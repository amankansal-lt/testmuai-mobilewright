import type { AllocationCriteria, Platform } from '@mobilewright/protocol';
import { parseOsVersion } from '@mobilewright/protocol';
import { LambdaTestDriverError } from './errors.js';
import type { LambdaTestDriverOptions } from './types.js';

export interface Credentials {
  username: string;
  accessKey: string;
}

export function resolveCredentials(options: LambdaTestDriverOptions, required: boolean): Credentials | undefined {
  const username = options.username ?? process.env['LT_USERNAME'];
  const accessKey = options.accessKey ?? process.env['LT_ACCESS_KEY'];
  if (!username || !accessKey) {
    if (!required) return undefined;
    throw new LambdaTestDriverError(
      'LambdaTest credentials are missing. Set LT_USERNAME and LT_ACCESS_KEY, or pass { username, accessKey } to the driver.',
    );
  }
  return { username, accessKey };
}

/** Apps for this allocation, most specific key first ('ios-real' beats 'ios'). */
export function appsForCriteria(criteria: AllocationCriteria, options: LambdaTestDriverOptions): string[] {
  const platform = criteria.platform;
  if (!platform) return [];

  const apps = options.apps ?? {};
  const specific = criteria.deviceType === 'real' ? apps[`${platform}-real` as keyof typeof apps] : undefined;
  const configured = specific ?? apps[platform as keyof typeof apps];
  if (configured) return Array.isArray(configured) ? configured.filter(Boolean) : [configured];

  const single = options.app ?? process.env['LT_APP'];
  return single ? [single] : [];
}

/**
 * LambdaTest matches `deviceName` and `platformVersion` as regular expressions
 * for app automation, so a mobilewright device pattern goes straight through
 * and no catalog lookup is needed. Anchored group form is what their docs use.
 */
export function toLambdaTestDeviceName(pattern: string | undefined): string | undefined {
  if (!pattern) return undefined;
  return /[.*+?^${}()|[\]\\]/.test(pattern) ? `(${pattern}.*)` : pattern;
}

/**
 * Mobilewright's osVersion grammar ("17", "26.0", ">=17 <19") is a range, while
 * LambdaTest's platformVersion is an exact value or a regex. Exact versions and
 * simple prefixes pass through; a bounded range becomes an alternation over the
 * major versions it admits, which is the closest faithful translation.
 */
export function toLambdaTestPlatformVersion(osVersion: string | undefined): string | undefined {
  if (!osVersion) return undefined;
  if (!/[<>=~^\s]/.test(osVersion)) return osVersion;

  const range = parseOsVersion(osVersion);
  const min = range.min ? Math.floor(Number(range.min.version)) : undefined;
  const max = range.max ? Math.floor(Number(range.max.version)) : undefined;
  if (min === undefined && max === undefined) return undefined;

  const lower = min ?? Math.max(0, (max ?? 0) - 6);
  // An exclusive upper bound still admits that major version's earlier minors
  // (">=17 <19" wants 17.x and 18.x), so only drop it when it is an exact major.
  const upper = max === undefined ? lower + 6 : (range.max?.inclusive ? max : max);
  const majors: string[] = [];
  for (let v = lower; v <= upper && majors.length < 12; v++) majors.push(`${v}.*`);
  if (majors.length === 0) return undefined;
  return `(${majors.join('),(')})`;
}

function platformName(platform: Platform): string {
  return platform === 'ios' ? 'iOS' : 'Android';
}

export interface CapabilityStyle {
  /**
   * 'lambdatest' is the flat capability set their Appium docs specify.
   * 'w3c' prefixes vendor capabilities, for a standard Appium server — which is
   * how the driver is exercised against a local Appium during development.
   */
  style: 'lambdatest' | 'w3c';
}

export function buildCapabilities(
  criteria: AllocationCriteria,
  options: LambdaTestDriverOptions,
  appRefs: string[],
  credentials: Credentials | undefined,
  { style }: CapabilityStyle = { style: 'lambdatest' },
): { alwaysMatch: Record<string, unknown>; firstMatch: Record<string, unknown>[] } {
  const platform = criteria.platform;
  if (!platform) {
    throw new LambdaTestDriverError(
      'A platform ("ios" or "android") is required to allocate a device. Set `platform` in your mobilewright config, top-level or in a project\'s `use` block.',
    );
  }

  const automationName = platform === 'ios' ? 'XCUITest' : 'UiAutomator2';
  const [app, ...otherApps] = appRefs;
  const deviceName = toLambdaTestDeviceName(criteria.deviceNamePattern);
  const platformVersion = toLambdaTestPlatformVersion(criteria.osVersion);

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
    ...(deviceName ? { deviceName } : {}),
    ...(platformVersion ? { platformVersion } : {}),
    ...(app ? { app } : {}),
  };

  // LambdaTest caps otherApps at 3 and rejects duplicates of the main app.
  if (otherApps.length) {
    const extras = [...new Set(otherApps)].filter((ref) => ref !== app);
    if (extras.length > 3) {
      throw new LambdaTestDriverError(
        `LambdaTest installs at most 3 additional apps per session; ${extras.length} were configured.`,
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
