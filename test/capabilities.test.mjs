import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appsForCriteria,
  buildCapabilities,
  resolveCredentials,
  toLambdaTestDeviceName,
  toLambdaTestPlatformVersion,
} from '../dist/capabilities.js';

const creds = { username: 'user', accessKey: 'key' };
const lt = (criteria, options = {}, apps = []) => buildCapabilities(criteria, options, apps, creds).alwaysMatch;

test('platform is required', () => {
  assert.throws(() => lt({}), /platform \("ios" or "android"\) is required/);
});

test('LambdaTest capabilities are flat, not nested under lt:options', () => {
  const caps = lt({ platform: 'ios' }, { build: 'ci-1' }, ['lt://APP1']);
  assert.equal(caps['lt:options'], undefined);
  assert.equal(caps.platformName, 'iOS');
  assert.equal(caps.automationName, 'XCUITest');
  assert.equal(caps.isRealMobile, true);
  assert.equal(caps.w3c, true);
  assert.equal(caps.app, 'lt://APP1');
  assert.equal(caps.user, 'user');
  assert.equal(caps.accessKey, 'key');
  assert.equal(caps.build, 'ci-1');
});

test('LambdaTest log capabilities use their documented spelling', () => {
  const caps = lt({ platform: 'android' }, { deviceLog: true, networkLog: true, video: false });
  assert.equal(caps.devicelog, true);
  assert.equal(caps.network, true);
  assert.equal(caps.video, false);
  assert.equal(caps.deviceLog, undefined);
  assert.equal(caps.networkLog, undefined);
});

test('w3c style prefixes vendor capabilities for a standard Appium server', () => {
  const caps = buildCapabilities({ platform: 'ios' }, {}, ['/tmp/app.ipa'], undefined, { style: 'w3c' }).alwaysMatch;
  assert.equal(caps['appium:automationName'], 'XCUITest');
  assert.equal(caps['appium:app'], '/tmp/app.ipa');
  assert.equal(caps.isRealMobile, undefined);
  assert.equal(caps.user, undefined);
});

test('device name patterns become LambdaTest regexes, literals pass through', () => {
  assert.equal(toLambdaTestDeviceName('iPhone 14 Pro'), 'iPhone 14 Pro');
  assert.equal(toLambdaTestDeviceName('iPhone 1[45]'), '(iPhone 1[45].*)');
  assert.equal(toLambdaTestDeviceName(undefined), undefined);
  assert.equal(lt({ platform: 'ios', deviceNamePattern: 'Pixel.*' }).deviceName, '(Pixel.*.*)');
});

test('osVersion ranges translate to a major-version alternation', () => {
  assert.equal(toLambdaTestPlatformVersion('17.2'), '17.2');
  assert.equal(toLambdaTestPlatformVersion('17'), '17');
  assert.equal(toLambdaTestPlatformVersion('>=17 <19'), '(17.*),(18.*),(19.*)');
  assert.equal(toLambdaTestPlatformVersion(undefined), undefined);
});

test('helper apps become otherApps, deduped and capped at three', () => {
  const caps = lt({ platform: 'android' }, {}, ['lt://A', 'lt://B', 'lt://B']);
  assert.deepEqual(caps.otherApps, ['lt://B']);
  assert.throws(
    () => lt({ platform: 'android' }, {}, ['lt://A', 'lt://B', 'lt://C', 'lt://D', 'lt://E']),
    /at most 3 additional apps/,
  );
});

test('platform-specific alert and permission capabilities', () => {
  assert.equal(lt({ platform: 'ios' }, { autoAcceptAlerts: true }).autoAcceptAlerts, true);
  assert.equal(lt({ platform: 'android' }, { autoAcceptAlerts: true }).autoAcceptAlerts, undefined);
  assert.equal(lt({ platform: 'android' }, { autoGrantPermissions: true }).autoGrantPermissions, true);
});

test('escape hatches merge last', () => {
  const caps = lt({ platform: 'android' }, {
    capabilities: { newCommandTimeout: 90 },
    ltOptions: { smartUI: true },
  });
  assert.equal(caps.newCommandTimeout, 90);
  assert.equal(caps.smartUI, true);
});

test('apps map prefers the most specific key', () => {
  const options = { apps: { ios: './generic.ipa', 'ios-real': './real.ipa', android: ['./a.apk', './helper.apk'] } };
  assert.deepEqual(appsForCriteria({ platform: 'ios', deviceType: 'real' }, options), ['./real.ipa']);
  assert.deepEqual(appsForCriteria({ platform: 'ios' }, options), ['./generic.ipa']);
  assert.deepEqual(appsForCriteria({ platform: 'android' }, options), ['./a.apk', './helper.apk']);
});

test('single app option and LT_APP fallback', () => {
  assert.deepEqual(appsForCriteria({ platform: 'ios' }, { app: 'lt://X' }), ['lt://X']);
  process.env.LT_APP = 'lt://FROM_ENV';
  assert.deepEqual(appsForCriteria({ platform: 'ios' }, {}), ['lt://FROM_ENV']);
  delete process.env.LT_APP;
});

test('credentials come from options or env, and are optional off-hub', () => {
  assert.deepEqual(resolveCredentials({ username: 'u', accessKey: 'k' }, true), { username: 'u', accessKey: 'k' });
  assert.equal(resolveCredentials({}, false), undefined);
  assert.throws(() => resolveCredentials({}, true), /LT_USERNAME and LT_ACCESS_KEY/);
});
