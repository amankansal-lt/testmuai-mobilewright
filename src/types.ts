export type NetworkProfile = '2G' | '3G' | '4G' | 'wifi' | 'edge' | 'offline';

export interface NetworkThrottle {
  /** kbps */
  download: number;
  /** kbps */
  upload: number;
  /** ms */
  latency: number;
  /** 0–100 */
  loss?: number;
}

export interface SnapshotTuning {
  /**
   * Stop XCUITest/UiAutomator2 waiting for the app to go quiescent before each
   * snapshot. Mobilewright does its own two-dump stability check, so the
   * driver-side idle wait is redundant and is usually the largest single cost
   * in `GET /source`. Default: 0 (disabled).
   */
  waitForIdleTimeout?: number;
  /** iOS: cap animation cool-off before a snapshot. Default: 0. */
  animationCoolOffTimeout?: number;
  /** Cap tree depth on deep SwiftUI/React Native hierarchies. Unset by default. */
  snapshotMaxDepth?: number;
  /** Bound a pathological snapshot instead of hanging, in seconds. */
  customSnapshotTimeout?: number;
}

export interface LambdaTestDriverOptions {
  /** Defaults to LT_USERNAME. */
  username?: string;
  /** Defaults to LT_ACCESS_KEY. */
  accessKey?: string;

  /**
   * App under test: an `lt://APP_ID`, a local `.apk`/`.ipa` path (uploaded once
   * per run), or a public https URL. Falls back to the LT_APP env var.
   */
  app?: string;
  /** Per-platform apps; the most specific key wins ('ios-real' over 'ios'). */
  apps?: Partial<Record<'ios' | 'android' | 'ios-real' | 'android-real', string | string[]>>;

  /** Override the Appium hub. Set this to point at a local Appium for development. */
  hubUrl?: string;
  /** Override the REST API host. */
  apiUrl?: string;

  build?: string;
  project?: string;
  name?: string;
  tags?: string[];

  /** One session, video and verdict per test instead of one per worker slot. */
  sessionPerTest?: boolean;
  /** Push pass/fail to the dashboard. Default: true. */
  testResults?: boolean;

  /** ms to wait for a device, covering LT's own queue. Default: 900000. */
  allocationTimeout?: number;
  /** Per-command timeout in ms. Default: 120000. */
  commandTimeout?: number;
  /**
   * Seconds LT waits before reaping an idle session. A pooled slot idles
   * between tests, so this is raised from LT's 120s default and paired with a
   * keepalive ping. Default: 900.
   */
  idleTimeout?: number;
  /** Max session length in seconds. */
  maxDuration?: number;
  /** Seconds LambdaTest holds a queued session create. 300-900, default 600. */
  queueTimeout?: number;
  /** Data centre: 'US' | 'EU' | 'AP'. Defaults to the nearest. */
  region?: 'US' | 'EU' | 'AP';

  /** LT capabilities exposed as driver options. */
  tunnel?: boolean;
  tunnelName?: string;
  geoLocation?: string;
  network?: NetworkProfile | NetworkThrottle;
  networkLog?: boolean;
  deviceLog?: boolean;
  video?: boolean;
  timezone?: string;
  autoGrantPermissions?: boolean;
  autoAcceptAlerts?: boolean;
  autoDismissAlerts?: boolean;
  appiumVersion?: string;
  disableAnimation?: boolean;

  /**
   * Appium snapshot tuning applied once per session. Pass `false` to leave the
   * server's defaults alone.
   */
  snapshotTuning?: SnapshotTuning | false;

  /** Override the REST API base (mobile-automation API). */
  apiBase?: string;
  /** Override the app-upload endpoint. */
  uploadUrl?: string;

  /**
   * How iOS element visibility is judged. 'native' (default) trusts XCUITest's
   * own `visible` attribute, matching other Appium-backed drivers. 'bounds'
   * treats any element with non-zero on-screen geometry as visible, which
   * matches mobilecli and keeps suites written against a local device passing.
   */
  visibility?: 'native' | 'bounds';

  /**
   * Send the X-LT-Framework-Step header naming the Mobilewright verb behind
   * each WebDriver command, so the dashboard's command log can be read as
   * framework calls rather than raw `GET /source` traffic. Default: true.
   */
  stepHeader?: boolean;

  /** Escape hatches merged last. */
  capabilities?: Record<string, unknown>;
  ltOptions?: Record<string, unknown>;
}
