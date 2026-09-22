import createDebug from 'debug';
import type {
  AllocatedDevice,
  AllocationCriteria,
  AppInfo,
  ConnectionConfig,
  DeviceAllocator,
  DeviceInfo,
  DeviceSettings,
  Geolocation,
  GestureSequence,
  HardwareButton,
  LaunchOptions,
  ListDevicesOptions,
  MobilewrightSession,
  Orientation,
  Platform,
  RecordingOptions,
  RecordingResult,
  ScreenSize,
  ScreenshotOptions,
  Session,
  SwipeDirection,
  SwipeOptions,
  TestObserver,
  ViewNode,
  WebViewBridge,
} from '@mobilewright/protocol';
import { NoDeviceAvailableError } from '@mobilewright/protocol';
import { appsForCriteria, buildCapabilities, resolveCredentials, type Credentials } from './capabilities.js';
import { LambdaTestApi } from './rest.js';
import { detectBuildName } from './ci.js';
import { LambdaTestDriverError, WebDriverError } from './errors.js';
import { Keepalive } from './keepalive.js';
import { LambdaTestObserver } from './observer.js';
import { parseSourceXml } from './parse-source.js';
import { cropPng } from './png-crop.js';
import type { LambdaTestDriverOptions, SnapshotTuning } from './types.js';
import {
  WebDriverClient,
  doubleTapActions,
  keyChordActions,
  pointerSequence,
  swipeActions,
  tapActions,
  typeTextActions,
} from './webdriver.js';

const debug = createDebug('lambdatest:driver');

export const DEFAULT_HUB_URL = 'https://mobile-hub.lambdatest.com/wd/hub';
const DEFAULT_ALLOCATION_TIMEOUT = 900_000;
const DEFAULT_IDLE_TIMEOUT = 900;
const DEFAULT_SNAPSHOT_TUNING: SnapshotTuning = { waitForIdleTimeout: 0, animationCoolOffTimeout: 0 };

/** Labels each WebDriver command with the Mobilewright verb behind it. */
const STEP_HEADER = 'X-LT-Framework-Step';

// LambdaTest session ids are long hex/uuid-ish strings; a catalog device name never is.
const SESSION_ID_RE = /^[0-9a-f][0-9a-f-]{19,}$/i;

const ANDROID_KEYCODES: Partial<Record<HardwareButton, number>> = {
  HOME: 3,
  BACK: 4,
  DPAD_UP: 19,
  DPAD_DOWN: 20,
  DPAD_LEFT: 21,
  DPAD_RIGHT: 22,
  DPAD_CENTER: 23,
  VOLUME_UP: 24,
  VOLUME_DOWN: 25,
  POWER: 26,
  ENTER: 66,
  APP_SWITCH: 187,
};

// XCUITest's `mobile: pressButton` accepts exactly these.
const IOS_BUTTON_NAMES: Partial<Record<HardwareButton, string>> = {
  HOME: 'home',
  VOLUME_UP: 'volumeup',
  VOLUME_DOWN: 'volumedown',
};

interface ActiveSession {
  sessionId: string;
  platform: Platform;
  /** True when this driver instance created the session and must delete it. */
  ownsSession: boolean;
  currentContext: string;
  currentWindowHandle?: string;
  lastLaunchedBundleId?: string;
  screenSize?: ScreenSize;
}

export class LambdaTestDriver implements MobilewrightSession, DeviceAllocator {
  readonly observer: TestObserver | undefined;

  private readonly options: LambdaTestDriverOptions;
  private readonly hub: WebDriverClient;
  private readonly keepalive: Keepalive;
  private readonly allocatedSessions = new Set<string>();
  private readonly appCache = new Map<string, Promise<string>>();
  private session: ActiveSession | null = null;
  private step: string | undefined;
  private api: LambdaTestApi | undefined;
  private planConcurrency: number | undefined;
  private concurrencyWarned = false;

  constructor(options: LambdaTestDriverOptions = {}) {
    this.options = { build: detectBuildName(), ...options };
    this.hub = new WebDriverClient(
      options.hubUrl ?? DEFAULT_HUB_URL,
      options.commandTimeout,
      () => (this.step && options.stepHeader !== false ? { [STEP_HEADER]: this.step } : undefined),
    );
    this.keepalive = new Keepalive(this.hub);
    this.observer = options.testResults === false
      ? undefined
      : new LambdaTestObserver(
        {
          liveSessionIds: () => [...this.allocatedSessions],
          setSessionStatus: (id, passed, reason) => this.setSessionStatus(id, passed, reason),
          setSessionName: (id, name) => this.setSessionName(id, name),
        },
        { ...(options.sessionPerTest !== undefined && { sessionPerTest: options.sessionPerTest }), ...(options.name !== undefined && { name: options.name }) },
      );
  }

  /** Credentials are only mandatory against LambdaTest's own hub. */
  private get credentials(): Credentials | undefined {
    return resolveCredentials(this.options, this.isLambdaTestHub);
  }

  /**
   * Whether the hub is a LambdaTest one, which decides the capability style and
   * whether credentials are mandatory. Devcluster hubs are
   * `mobile-hub-<name>-dev.lambdatestinternal.com`, so both domains count.
   */
  private get isLambdaTestHub(): boolean {
    if (this.options.capabilityStyle) return this.options.capabilityStyle === 'lambdatest';
    return /lambdatest(internal)?\.com/i.test(this.options.hubUrl ?? DEFAULT_HUB_URL);
  }

  /** REST client for uploads, concurrency and post-session status. */
  private get rest(): LambdaTestApi | undefined {
    if (!this.isLambdaTestHub) return undefined;
    const credentials = this.credentials;
    if (!credentials) return undefined;
    this.api ??= new LambdaTestApi(credentials, this.options.apiBase, this.options.uploadUrl);
    return this.api;
  }

  /** Local .apk/.ipa paths and https urls become lt:// ids, once per run. */
  private async resolveApps(refs: string[]): Promise<string[]> {
    const rest = this.rest;
    if (!rest) return refs;
    return Promise.all(refs.map((ref) => rest.resolveApp(ref, this.appCache)));
  }

  // ─── Allocation ─────────────────────────────────────────────

  /** Called once by the pool coordinator before any worker connects. */
  async prepare(): Promise<void> {
    const concurrency = await this.rest?.concurrency();
    if (!concurrency) return;
    this.planConcurrency = concurrency.maxConcurrency;
    debug('plan concurrency: %d (running %d, queued %d)', concurrency.maxConcurrency, concurrency.running, concurrency.queued);
  }

  async allocate(criteria: AllocationCriteria, _taken: ReadonlySet<string>, signal?: AbortSignal): Promise<AllocatedDevice> {
    if (!criteria.platform) {
      throw new LambdaTestDriverError('allocate requires a platform ("ios" or "android").');
    }
    // Only LambdaTest's own hub is real-devices-only; a custom hub (local
    // Appium during development) may well be a simulator or emulator.
    if (this.isLambdaTestHub && criteria.deviceType && criteria.deviceType !== 'real') {
      throw new LambdaTestDriverError(
        `LambdaTest real-device automation provides real devices only (requested deviceType "${criteria.deviceType}").`,
      );
    }

    const appRefs = await this.resolveApps(appsForCriteria(criteria, this.options));
    const capabilities = buildCapabilities(
      criteria,
      this.optionsWithDefaults(),
      appRefs,
      this.credentials,
      { style: this.isLambdaTestHub ? 'lambdatest' : 'w3c' },
    );
    const timeout = this.options.allocationTimeout ?? DEFAULT_ALLOCATION_TIMEOUT;

    if (this.planConcurrency !== undefined && this.allocatedSessions.size >= this.planConcurrency && !this.concurrencyWarned) {
      this.concurrencyWarned = true;
      console.warn(
        `[LambdaTest] Plan concurrency is ${this.planConcurrency}; further workers will queue until a session is released.`,
      );
    }
    debug('creating session (platform=%s, device=%s)', criteria.platform, criteria.deviceNamePattern ?? 'any');
    let sessionId: string;
    let matched: Record<string, unknown>;
    try {
      ({ sessionId, capabilities: matched } = await this.hub.newSession(capabilities, timeout));
    } catch (err) {
      throw this.translateAllocationError(err);
    }
    if (signal?.aborted) {
      await this.hub.deleteSession(sessionId).catch(() => {});
      throw new LambdaTestDriverError('allocation aborted');
    }

    this.allocatedSessions.add(sessionId);
    this.keepalive.start(sessionId);

    const deviceName = String(matched['deviceName'] ?? matched['appium:deviceName'] ?? criteria.deviceNamePattern ?? '');
    const osVersion = String(matched['platformVersion'] ?? matched['appium:platformVersion'] ?? criteria.osVersion ?? '');
    console.log(`[LambdaTest] session ${sessionId}${deviceName ? ` on ${deviceName}${osVersion ? `-${osVersion}` : ''}` : ''}`);

    return {
      deviceId: sessionId,
      platform: criteria.platform,
      driver: 'lambdatest',
      ...(deviceName ? { model: deviceName } : {}),
      ...(osVersion ? { osVersion } : {}),
      type: criteria.deviceType ?? 'real',
    };
  }

  async release(deviceId: string): Promise<void> {
    this.keepalive.stop(deviceId);
    this.allocatedSessions.delete(deviceId);
    // Deleting the session ends it, and the executor hooks only reach a live
    // one — so this is the last chance to put a verdict on the dashboard.
    const verdict = (this.observer as LambdaTestObserver | undefined)?.verdict?.();
    if (verdict) {
      if (verdict.name) await this.setSessionName(deviceId, verdict.name);
      await this.setSessionStatus(deviceId, verdict.passed, verdict.reason);
    }
    try {
      await this.hub.deleteSession(deviceId);
    } catch (err) {
      // Already reaped or stopped is fine — the device is free either way.
      debug('release(%s): %s', deviceId, (err as Error).message);
    }
  }

  async dispose(): Promise<void> {
    this.keepalive.stopAll();
    const leftover = [...this.allocatedSessions];
    this.allocatedSessions.clear();
    await Promise.all(leftover.map((id) => this.hub.deleteSession(id).catch(() => {})));
  }

  /**
   * LambdaTest queues a session create while every device that matches is busy,
   * and answers 429 once the plan's parallel limit is reached. Neither is a bad
   * request: the pool re-queues NoDeviceAvailableError until a slot frees up,
   * instead of failing every test that a worker picks up meanwhile.
   */
  private translateAllocationError(err: unknown): Error {
    if (err instanceof WebDriverError) {
      if (err.httpStatus === 429 || /concurren|parallel limit|queue/i.test(err.message)) {
        return new NoDeviceAvailableError(err.message);
      }
    }
    return err as Error;
  }

  private optionsWithDefaults(): LambdaTestDriverOptions {
    return { idleTimeout: DEFAULT_IDLE_TIMEOUT, ...this.options };
  }

  // ─── Connection ─────────────────────────────────────────────

  async connect(config: ConnectionConfig): Promise<Session> {
    if (config.deviceId && SESSION_ID_RE.test(config.deviceId)) {
      debug('attaching to session %s', config.deviceId);
      this.session = { sessionId: config.deviceId, platform: config.platform, ownsSession: false, currentContext: 'NATIVE_APP' };
    } else {
      // Standalone path (no device pool): create and own a session.
      const pattern = config.deviceName
        ? (typeof config.deviceName === 'string' ? config.deviceName : config.deviceName.source)
        : config.deviceId;
      const allocated = await this.allocate(
        {
          platform: config.platform,
          ...(pattern ? { deviceNamePattern: pattern } : {}),
          ...(config.osVersion ? { osVersion: config.osVersion } : {}),
        },
        new Set(),
      );
      this.session = { sessionId: allocated.deviceId, platform: config.platform, ownsSession: true, currentContext: 'NATIVE_APP' };
    }

    await this.applySnapshotTuning();
    return { deviceId: this.session.sessionId, platform: this.session.platform };
  }

  async disconnect(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    if (session.ownsSession) {
      await this.release(session.sessionId);
    }
  }

  /**
   * Mobilewright polls the hierarchy every 100ms and settles an element by
   * comparing two consecutive dumps, so the automation backend's own idle wait
   * before each snapshot is redundant work on the critical path.
   */
  private async applySnapshotTuning(): Promise<void> {
    if (this.options.snapshotTuning === false) return;
    const tuning = { ...DEFAULT_SNAPSHOT_TUNING, ...(this.options.snapshotTuning ?? {}) };
    const settings = Object.fromEntries(Object.entries(tuning).filter(([, v]) => v !== undefined));
    if (Object.keys(settings).length === 0) return;
    try {
      await this.hub.post(this.require().sessionId, '/appium/settings', { settings });
      debug('snapshot tuning applied: %o', settings);
    } catch (err) {
      // Older servers reject unknown settings; the session is still usable.
      debug('snapshot tuning rejected (%s) — continuing with server defaults', (err as Error).message);
    }
  }

  // ─── UI hierarchy ───────────────────────────────────────────

  async getViewHierarchy(): Promise<ViewNode[]> {
    return this.stepped('getViewHierarchy', async () => {
      const { sessionId, platform } = await this.nativeSession();
      const xml = await this.hub.source(sessionId);
      return parseSourceXml(xml, platform, this.options.visibility ?? 'native');
    });
  }

  /**
   * Labels every hub command raised inside `fn` with the verb that caused it.
   * The hub only ever sees `GET /source` and `POST /actions`; without this it
   * cannot tell that one locator tap produced three of them.
   */
  private async stepped<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.step;
    this.step = name;
    try {
      return await fn();
    } finally {
      this.step = previous;
    }
  }

  // ─── Input ──────────────────────────────────────────────────

  async tap(x: number, y: number): Promise<void> {
    return this.stepped('tap', async () => {
      const { sessionId } = await this.nativeSession();
      await this.hub.performActions(sessionId, tapActions(x, y));
    });
  }

  async doubleTap(x: number, y: number): Promise<void> {
    const { sessionId } = await this.nativeSession();
    await this.hub.performActions(sessionId, doubleTapActions(x, y));
  }

  async longPress(x: number, y: number, duration = 800): Promise<void> {
    const { sessionId } = await this.nativeSession();
    await this.hub.performActions(sessionId, tapActions(x, y, duration));
  }

  async typeText(text: string): Promise<void> {
    const { sessionId, platform } = await this.nativeSession();
    const elementId = await this.hub.activeElement(sessionId);
    if (elementId) {
      try {
        await this.hub.post(sessionId, `/element/${elementId}/value`, { text, value: [...text] });
        return;
      } catch (err) {
        debug('sendKeys on the active element failed, falling back to key actions: %s', (err as Error).message);
      }
    }
    if (platform === 'ios') {
      try {
        await this.hub.mobile(sessionId, 'type', { text });
        return;
      } catch (err) {
        debug('mobile: type failed, falling back to key actions: %s', (err as Error).message);
      }
    }
    await this.hub.performActions(sessionId, [typeTextActions(text)]);
  }

  async pressKeys(keys: string[]): Promise<void> {
    const { sessionId } = await this.nativeSession();
    for (const key of keys) {
      await this.hub.performActions(sessionId, [keyChordActions(key)]);
    }
  }

  /**
   * XCUITest cannot hold modifier keys, so the select-all chord that works on
   * Android is unreliable on iOS. Clear the focused element directly, and fall
   * back to one backspace per character rather than a chord.
   */
  async clearText(): Promise<void> {
    const { sessionId, platform } = await this.nativeSession();
    const elementId = await this.hub.activeElement(sessionId);
    if (elementId) {
      try {
        await this.hub.post(sessionId, `/element/${elementId}/clear`);
        return;
      } catch (err) {
        debug('element clear failed: %s', (err as Error).message);
      }
    }
    if (platform === 'android') {
      await this.pressKeys(['ctrl+a', 'backspace']);
      return;
    }
    const current = await this.focusedValueLength();
    if (current > 0) {
      await this.hub.performActions(sessionId, [typeTextActions(''.repeat(current))]);
    }
  }

  private async focusedValueLength(): Promise<number> {
    const { sessionId } = this.require();
    const elementId = await this.hub.activeElement(sessionId);
    if (!elementId) return 0;
    try {
      const value = await this.hub.get<string>(sessionId, `/element/${elementId}/attribute/value`);
      return value ? [...value].length : 0;
    } catch {
      return 0;
    }
  }

  async swipe(direction: SwipeDirection, opts?: SwipeOptions): Promise<void> {
    const { sessionId } = await this.nativeSession();
    const screen = await this.getScreenSize();
    const startX = opts?.startX ?? screen.width / 2;
    const startY = opts?.startY ?? screen.height / 2;
    const horizontal = direction === 'left' || direction === 'right';
    const distance = opts?.distance ?? (horizontal ? screen.width : screen.height) * 0.5;

    let endX = startX;
    let endY = startY;
    switch (direction) {
      case 'up': endY = startY - distance; break;
      case 'down': endY = startY + distance; break;
      case 'left': endX = startX - distance; break;
      case 'right': endX = startX + distance; break;
    }
    // Keep the gesture inside the viewport; a target outside it is rejected.
    endX = Math.min(Math.max(endX, 1), screen.width - 1);
    endY = Math.min(Math.max(endY, 1), screen.height - 1);

    await this.hub.performActions(sessionId, swipeActions(startX, startY, endX, endY, opts?.duration ?? 400));
  }

  async gesture(gestures: GestureSequence): Promise<void> {
    const { sessionId } = await this.nativeSession();
    const sequences = gestures.pointers.map((points, index) => {
      const actions: Array<Record<string, unknown>> = [];
      let previousTime = 0;
      points.forEach((point, i) => {
        const time = point.time ?? 0;
        if (i === 0) {
          actions.push({ type: 'pointerMove', duration: 0, x: Math.round(point.x), y: Math.round(point.y) });
          actions.push({ type: 'pointerDown', button: 0 });
        } else {
          actions.push({ type: 'pointerMove', duration: Math.max(time - previousTime, 10), x: Math.round(point.x), y: Math.round(point.y) });
        }
        previousTime = time;
      });
      actions.push({ type: 'pointerUp', button: 0 });
      return pointerSequence(`finger${index + 1}`, actions as never);
    });
    await this.hub.performActions(sessionId, sequences);
  }

  async pressButton(button: HardwareButton): Promise<void> {
    const { sessionId, platform } = await this.nativeSession();

    if (platform === 'android') {
      if (button === 'LOCK') {
        await this.hub.mobile(sessionId, 'lock');
        return;
      }
      const keycode = ANDROID_KEYCODES[button];
      if (keycode === undefined) {
        throw new LambdaTestDriverError(`Unsupported hardware button on Android: ${button}`);
      }
      await this.hub.mobile(sessionId, 'pressKey', { keycode });
      return;
    }

    if (button === 'LOCK' || button === 'POWER') {
      await this.hub.mobile(sessionId, 'lock');
      return;
    }
    // iOS has no back button. screen.goBack() maps here, so translate it into
    // the system back-swipe rather than failing the call outright.
    if (button === 'BACK') {
      const screen = await this.getScreenSize();
      const y = Math.round(screen.height / 2);
      await this.hub.performActions(sessionId, swipeActions(2, y, Math.round(screen.width * 0.6), y, 250));
      return;
    }
    const name = IOS_BUTTON_NAMES[button];
    if (!name) {
      throw new LambdaTestDriverError(`Unsupported hardware button on iOS: ${button}`);
    }
    await this.hub.mobile(sessionId, 'pressButton', { name });
  }

  // ─── Screen ─────────────────────────────────────────────────

  async screenshot(opts?: ScreenshotOptions): Promise<Buffer> {
    const { sessionId } = await this.nativeSession();
    const png = Buffer.from(await this.hub.screenshot(sessionId), 'base64');
    if (!opts?.clip) return png;
    // locator.screenshot() asks for element bounds via `clip`. Both competing
    // drivers ignore it and hand back the whole screen; crop so element
    // screenshots are actually element screenshots.
    const { scale } = await this.getScreenSize();
    return cropPng(png, opts.clip, scale);
  }

  async getScreenSize(): Promise<ScreenSize> {
    const session = this.require();
    if (session.screenSize) return session.screenSize;

    const rect = await this.hub.get<{ width: number; height: number }>(session.sessionId, '/window/rect');
    // Android reports pixels and iOS points, while screenshots are always
    // physical pixels. Derive the ratio from one PNG header so crops are right
    // on 2x/3x screens without an extra round trip later.
    let scale = 1;
    try {
      const png = Buffer.from(await this.hub.screenshot(session.sessionId), 'base64');
      const pngWidth = png.readUInt32BE(16);
      if (pngWidth > 0 && rect.width > 0) {
        scale = Math.round((pngWidth / rect.width) * 100) / 100;
      }
    } catch {
      // keep scale 1 — layout maths still works, crops may be off on retina
    }
    session.screenSize = { width: rect.width, height: rect.height, scale };
    return session.screenSize;
  }

  async getOrientation(): Promise<Orientation> {
    const { sessionId } = this.require();
    const value = await this.hub.get<string>(sessionId, '/orientation');
    return value?.toUpperCase() === 'LANDSCAPE' ? 'landscape' : 'portrait';
  }

  async setOrientation(orientation: Orientation): Promise<void> {
    const session = this.require();
    await this.hub.post(session.sessionId, '/orientation', { orientation: orientation.toUpperCase() });
    // Width and height swap; drop the cache so the next query re-reads.
    session.screenSize = undefined;
  }

  async setGeolocation(geolocation: Geolocation | null): Promise<void> {
    const { sessionId, platform } = await this.nativeSession();
    const [set, clear] = platform === 'android'
      ? ['mobile: setGeolocation', 'mobile: resetGeolocation']
      : ['mobile: setSimulatedLocation', 'mobile: clearSimulatedLocation'];

    if (geolocation === null) {
      await this.hub.executeScript(sessionId, clear);
      return;
    }
    await this.hub.executeScript(sessionId, set, [{ latitude: geolocation.latitude, longitude: geolocation.longitude }]);
  }

  // ─── Apps ───────────────────────────────────────────────────

  async launchApp(bundleId: string, opts?: LaunchOptions): Promise<void> {
    const session = await this.nativeSession();
    if (session.platform === 'android' && opts?.activity) {
      const activity = opts.activity.startsWith('.') ? `${bundleId}${opts.activity}` : opts.activity;
      await this.hub.mobile(session.sessionId, 'startActivity', { intent: `${bundleId}/${activity}` });
    } else {
      await this.hub.mobile(session.sessionId, 'activateApp', { appId: bundleId, bundleId });
    }
    session.lastLaunchedBundleId = bundleId;
  }

  async terminateApp(bundleId: string): Promise<void> {
    const { sessionId } = await this.nativeSession();
    await this.hub.mobile(sessionId, 'terminateApp', { appId: bundleId, bundleId });
  }

  async listApps(): Promise<AppInfo[]> {
    const session = this.require();
    // Neither platform exposes a package list over a cloud Appium session;
    // report what this session is known to have launched.
    return session.lastLaunchedBundleId ? [{ bundleId: session.lastLaunchedBundleId }] : [];
  }

  async getForegroundApp(): Promise<AppInfo> {
    const { sessionId, platform } = await this.nativeSession();
    if (platform === 'android') {
      try {
        const pkg = await this.hub.get<string>(sessionId, '/appium/device/current_package');
        if (pkg) return { bundleId: pkg };
      } catch (err) {
        debug('current_package failed (%s), trying mobile: getCurrentPackage', (err as Error).message);
      }
      const pkg = await this.hub.mobile<string>(sessionId, 'getCurrentPackage');
      return { bundleId: pkg ?? '' };
    }
    const info = await this.hub.mobile<{ bundleId?: string; name?: string }>(sessionId, 'activeAppInfo');
    return { bundleId: info?.bundleId ?? '', ...(info?.name ? { name: info.name } : {}) };
  }

  async installApp(pathOrRef: string): Promise<void> {
    // The session started with this app, so the fixture's install pass would
    // reinstall the same build for nothing.
    const configured = [this.options.app, ...Object.values(this.options.apps ?? {}).flat()];
    if (configured.includes(pathOrRef)) {
      debug('installApp(%s) skipped — already the session app', pathOrRef);
      return;
    }

    const { sessionId } = await this.nativeSession();
    const [appUrl] = await this.resolveApps([pathOrRef]);
    if (!appUrl?.startsWith('lt://')) {
      throw new LambdaTestDriverError(
        `Cannot install "${pathOrRef}" mid-session: it did not resolve to an lt:// app id. ` +
        'Upload it first, or declare it in the driver\'s `app`/`apps` option.',
      );
    }
    await this.hub.executeScript(sessionId, 'lambda-install-app', [{ appUrl, retainData: true }]);
    debug('installed %s mid-session', appUrl);
  }

  async uninstallApp(bundleId: string): Promise<void> {
    const { sessionId } = await this.nativeSession();
    await this.hub.mobile(sessionId, 'removeApp', { appId: bundleId, bundleId });
  }

  // ─── Device ─────────────────────────────────────────────────

  async listDevices(_opts?: ListDevicesOptions): Promise<DeviceInfo[]> {
    // Device selection happens at allocation through capabilities; there is no
    // per-session device list to enumerate.
    return [];
  }

  async openUrl(url: string): Promise<void> {
    const { sessionId, platform, lastLaunchedBundleId } = await this.nativeSession();
    await this.hub.mobile(sessionId, 'deepLink', {
      url,
      ...(platform === 'android' ? { package: lastLaunchedBundleId } : { bundleId: lastLaunchedBundleId }),
    });
  }

  async applyDeviceSettings(settings: DeviceSettings): Promise<void> {
    // Animations are a session capability on LambdaTest (disableAnimation),
    // applied at allocation — there is no runtime toggle over a cloud session.
    debug('applyDeviceSettings(%o) is a no-op; use driver option disableAnimation', settings);
  }

  // ─── Recording ──────────────────────────────────────────────

  async startRecording(_opts: RecordingOptions): Promise<void> {
    // LambdaTest records the whole session server-side; nothing to start.
    debug('startRecording: server-side video covers the session');
  }

  async stopRecording(): Promise<RecordingResult> {
    return { status: 'session-video' };
  }

  // ─── WebView ────────────────────────────────────────────────

  get webViewBridge(): WebViewBridge {
    return {
      listWebViews: async () => {
        const { sessionId } = this.require();
        const deadline = Date.now() + 5_000;
        let names: string[] = [];
        for (;;) {
          names = ((await this.hub.get<string[]>(sessionId, '/contexts')) ?? []).filter((n) => n !== 'NATIVE_APP');
          if (names.length > 0 || Date.now() >= deadline) break;
          await new Promise((r) => setTimeout(r, 500));
        }
        return names.map((id) => ({ id, url: '', title: '' }));
      },
      attachWebView: async (id: string) => {
        const { WebViewSessionImpl } = await import('./webview.js');
        return new WebViewSessionImpl(this.hub, this.require().sessionId, this, id);
      },
    };
  }

  /** Switches automation context, skipping the round trip when already there. */
  async switchContext(name: string): Promise<void> {
    const session = this.require();
    if (session.currentContext === name) return;
    await this.hub.post(session.sessionId, '/context', { name });
    session.currentContext = name;
    session.currentWindowHandle = undefined;
    debug('context -> %s', name);
  }

  // ─── LambdaTest hooks ───────────────────────────────────────

  /** Runs a `lambda-*` executor hook on the live session. */
  async executeLambdaHook<T = unknown>(payload: string): Promise<T> {
    const { sessionId } = this.require();
    return this.hub.executeScript<T>(sessionId, payload);
  }

  /**
   * Puts the verdict on the dashboard. The hook form carries a remark, so it is
   * tried first; `lambda-status=` is the older spelling and stays as a fallback.
   * A released session is gone, so the REST API is the last resort.
   */
  async setSessionStatus(sessionId: string, passed: boolean, reason?: string): Promise<void> {
    const status = passed ? 'passed' : 'failed';
    const hook = {
      action: 'setTestStatus',
      arguments: { status, ...(reason ? { remark: reason.slice(0, 255) } : {}) },
    };
    try {
      await this.hub.executeScript(sessionId, `lambda-hook: ${JSON.stringify(hook)}`);
      return;
    } catch (err) {
      debug('lambda-hook setTestStatus failed (%s), trying lambda-status', (err as Error).message);
    }
    try {
      await this.hub.executeScript(sessionId, `lambda-status=${status}`);
      return;
    } catch (err) {
      debug('lambda-status failed (%s), trying the REST API', (err as Error).message);
    }
    await this.rest?.updateSession(sessionId, { status_ind: status }).catch((err: unknown) => {
      debug('REST status update failed for %s: %s', sessionId, (err as Error).message);
    });
  }

  async setSessionName(sessionId: string, name: string): Promise<void> {
    try {
      await this.hub.executeScript(sessionId, `lambda-name=${name}`);
      return;
    } catch (err) {
      debug('lambda-name failed (%s), trying the REST API', (err as Error).message);
    }
    await this.rest?.updateSession(sessionId, { name }).catch(() => {});
  }

  /** Test seam: the capabilities this driver would send for a given allocation. */
  buildCapabilitiesForTest(criteria: AllocationCriteria, appRefs: string[] = ['lt://TEST']): Record<string, unknown> {
    return buildCapabilities(criteria, this.optionsWithDefaults(), appRefs, this.credentials, {
      style: this.isLambdaTestHub ? 'lambdatest' : 'w3c',
    }).alwaysMatch;
  }

  get activeSessionId(): string | undefined {
    return this.session?.sessionId;
  }

  // ─── Helpers ────────────────────────────────────────────────

  private require(): ActiveSession {
    if (!this.session) {
      throw new LambdaTestDriverError('No active session. Call connect() first.');
    }
    return this.session;
  }

  /** require() plus a guarantee that the session is in the native context. */
  private async nativeSession(): Promise<ActiveSession> {
    const session = this.require();
    if (session.currentContext !== 'NATIVE_APP') {
      await this.switchContext('NATIVE_APP');
    }
    return session;
  }
}
