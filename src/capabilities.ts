import type { AllocationCriteria, Platform } from '@mobilewright/protocol';
import { parseOsVersion } from '@mobilewright/protocol';
import { TestMuDriverError } from './errors.js';
import { envNames, envValue } from './env.js';
import type { TestMuDriverOptions } from './types.js';

/** Dashboard label for sessions this driver creates. */
export const FRAMEWORK_TYPE = 'mobilewright';

export interface Credentials {
  username: string;
  accessKey: string;
}

export function resolveCredentials(options: TestMuDriverOptions, required: boolean): Credentials | undefined {
  const username = options.username ?? envValue('USERNAME');
  const accessKey = options.accessKey ?? envValue('ACCESS_KEY');
  if (!username || !accessKey) {
    if (!required) return undefined;
    throw new TestMuDriverError(
      `TestMu.Ai credentials are missing. Set ${envNames('USERNAME')} and ${envNames('ACCESS_KEY')}, ` +
      'or pass { username, accessKey } to the driver.',
    );
  }
  return { username, accessKey };
}

/** Apps for this allocation, most specific key first ('ios-real' beats 'ios'). */
export function appsForCriteria(criteria: AllocationCriteria, options: TestMuDriverOptions): string[] {
  const platform = criteria.platform;
  if (!platform) return [];

  const apps = options.apps ?? {};
  const specific = criteria.deviceType === 'real' ? apps[`${platform}-real` as keyof typeof apps] : undefined;
  const configured = specific ?? apps[platform as keyof typeof apps];
  if (configured) return Array.isArray(configured) ? configured.filter(Boolean) : [configured];

  const single = options.app ?? envValue('APP');
  return single ? [single] : [];
}

/**
 * TestMu.Ai matches `deviceName` and `platformVersion` as regular expressions
 * for app automation, so a mobilewright device pattern goes straight through
 * and no catalog lookup is needed. Anchored group form is what their docs use.
 */
export function toTestMuDeviceName(pattern: string | undefined): string | undefined {
  if (!pattern) return undefined;
  return /[.*+?^${}()|[\]\\]/.test(pattern) ? `(${pattern}.*)` : pattern;
}

/**
 * Mobilewright's osVersion grammar ("17", "26.0", ">=17 <19") is a range, while
 * TestMu.Ai's platformVersion is an exact value or a regex. Exact versions and
 * simple prefixes pass through; a bounded range becomes an alternation over the
 * major versions it admits, which is the closest faithful translation.
 */
export function toTestMuPlatformVersion(osVersion: string | undefined): string | undefined {
  if (!osVersion) return undefined;
  if (!/[<>=~^\s]/.test(osVersion)) return osVersion;

  const range = parseOsVersion(osVersion);
  const min = range.min ? Math.floor(Number(range.min.version)) : undefined;
  const max = range.max ? Math.floor(Number(range.max.version)) : undefined;
  if (min === undefined && max === undefined) return undefined;

  // A half-open range becomes a finite list of majors; the window is generous on purpose, since over-inclusion only widens matching.
  const WINDOW = 11;
  const lower = min ?? Math.max(0, (max ?? 0) - WINDOW);
  // An exclusive bound on a whole major excludes that major entirely
  // (">=17 <19" admits 17.x and 18.x, never 19.x). An exclusive bound with
  // minors still admits the earlier minors of that major ("<19.5" admits
  // 19.0-19.4), so the major is kept — slightly over-inclusive, which is the
  // safe direction for device matching.
  const excludesWholeMajor = range.max !== undefined &&
    !range.max.inclusive &&
    /^\d+(\.0+)*$/.test(range.max.version);
  const upper = max === undefined ? lower + WINDOW : (excludesWholeMajor ? max - 1 : max);
  const majors: string[] = [];
  for (let v = lower; v <= upper && majors.length <= WINDOW + 1; v++) majors.push(`${v}.*`);
  if (majors.length === 0) return undefined;
  return `(${majors.join('),(')})`;
}

function platformName(platform: Platform): string {
  return platform === 'ios' ? 'iOS' : 'Android';
}

export interface CapabilityStyle {
  /**
   * 'testmu' is the flat capability set their Appium docs specify.
   * 'w3c' prefixes vendor capabilities, for a standard Appium server — which is
   * how the driver is exercised against a local Appium during development.
   */
  style: 'testmu' | 'w3c';
}

export function buildCapabilities(
  criteria: AllocationCriteria,
  options: TestMuDriverOptions,
  appRefs: string[],
  credentials: Credentials | undefined,
  { style }: CapabilityStyle = { style: 'testmu' },
): { alwaysMatch: Record<string, unknown>; firstMatch: Record<string, unknown>[] } {
  const platform = criteria.platform;
  if (!platform) {
    throw new TestMuDriverError(
      'A platform ("ios" or "android") is required to allocate a device. Set `platform` in your mobilewright config, top-level or in a project\'s `use` block.',
    );
  }

  const automationName = platform === 'ios' ? 'XCUITest' : 'UiAutomator2';
  const [app, ...otherApps] = appRefs;
  const deviceName = toTestMuDeviceName(criteria.deviceNamePattern);
  const platformVersion = toTestMuPlatformVersion(criteria.osVersion);

  if (style === 'w3c') {
    const caps: Record<string, unknown> = {
      platformName: platformName(platform),
      'appium:automationName': automationName,
      ...(deviceName ? { 'appium:deviceName': deviceName } : {}),
      ...(platformVersion ? { 'appium:platformVersion': platformVersion } : {}),
      ...(app ? { 'appium:app': app } : {}),
      ...(otherApps.length ? { 'appium:otherApps': otherApps } : {}),
    };
    Object.assign(caps, options.capabilities);
    return { alwaysMatch: caps, firstMatch: [{}] };
  }

  const caps: Record<string, unknown> = {
    platformName: platformName(platform),
    automationName,
    isRealMobile: true,
    w3c: true,
    // Labels the session on the dashboard. The session itself is an ordinary
    // Appium one — this only says which client framework drove it.
    frameworkType: FRAMEWORK_TYPE,
    ...(deviceName ? { deviceName } : {}),
    ...(platformVersion ? { platformVersion } : {}),
    ...(app ? { app } : {}),
  };

  // TestMu.Ai derives isAppAutomate from the presence of `app`, and that flag
  // decides the sub-test type used for device allocation. Without an app the
  // session is allocated as web automation and fails confusingly downstream.
  const escapeHatchApp = options.capabilities?.['app'] ?? options.ltOptions?.['app'] ?? options.capabilities?.['browserName'];
  if (!app && !escapeHatchApp) {
    throw new TestMuDriverError(
      'A TestMu.Ai session must start with an app. Set the driver\'s `app` option ' +
      '(an lt://APP_ID, a local .apk/.ipa path, or an https url), or a per-platform `apps` entry.',
    );
  }

  // TestMu.Ai caps otherApps at 3 and rejects duplicates of the main app.
  if (otherApps.length) {
    const extras = [...new Set(otherApps)].filter((ref) => ref !== app);
    if (extras.length > 3) {
      throw new TestMuDriverError(
        `TestMu.Ai installs at most 3 additional apps per session; ${extras.length} were configured.`,
      );
    }
    caps['otherApps'] = extras;
  }

  if (credentials) {
    caps['user'] = credentials.username;
    caps['accessKey'] = credentials.accessKey;
  }
  if (options.build) caps['build'] = options.build;
  if (options.project) caps['project'] = options.project;
  if (options.name) caps['name'] = options.name;
  if (options.tags?.length) caps['tags'] = options.tags;
  if (options.idleTimeout !== undefined) caps['idleTimeout'] = options.idleTimeout;
  if (options.maxDuration !== undefined) caps['maxDuration'] = options.maxDuration;
  if (options.queueTimeout !== undefined) caps['queueTimeout'] = options.queueTimeout;
  if (options.video !== undefined) caps['video'] = options.video;
  // Their spelling: lowercase `devicelog`, and `network` is the network-log flag.
  if (options.deviceLog !== undefined) caps['devicelog'] = options.deviceLog;
  if (options.networkLog !== undefined) caps['network'] = options.networkLog;
  if (options.geoLocation) caps['geoLocation'] = options.geoLocation;
  if (options.timezone) caps['timezone'] = options.timezone;
  if (options.appiumVersion) caps['appiumVersion'] = options.appiumVersion;
  if (options.disableAnimation !== undefined) caps['disableAnimation'] = options.disableAnimation;
  if (options.tunnel !== undefined) caps['tunnel'] = options.tunnel;
  if (options.tunnelName) caps['tunnelName'] = options.tunnelName;
  if (options.region) caps['region'] = options.region;
  if (platform === 'android' && options.autoGrantPermissions !== undefined) {
    caps['autoGrantPermissions'] = options.autoGrantPermissions;
  }
  if (platform === 'ios') {
    if (options.autoAcceptAlerts !== undefined) caps['autoAcceptAlerts'] = options.autoAcceptAlerts;
    if (options.autoDismissAlerts !== undefined) caps['autoDismissAlerts'] = options.autoDismissAlerts;
  }

  Object.assign(caps, options.ltOptions, options.capabilities);
  return { alwaysMatch: caps, firstMatch: [{}] };
}
