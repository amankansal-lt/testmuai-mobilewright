import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appsForCriteria,
  buildCapabilities,
  resolveCredentials,
  toTestMuDeviceName,
  toTestMuPlatformVersion,
} from '../dist/capabilities.js';

const creds = { username: 'user', accessKey: 'key' };
const lt = (criteria, options = {}, apps = ['lt://APP1']) => buildCapabilities(criteria, options, apps, creds).alwaysMatch;

test('platform is required', () => {
  assert.throws(() => lt({}), /platform \("ios" or "android"\) is required/);
});

test('TestMu.Ai capabilities are flat, not nested under lt:options', () => {
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

test('sessions are labelled with the mobilewright framework type', () => {
  assert.equal(lt({ platform: 'ios' }).frameworkType, 'mobilewright');
  // still overridable through the escape hatch
  assert.equal(lt({ platform: 'ios' }, { ltOptions: { frameworkType: 'appium' } }).frameworkType, 'appium');
});

test('a session without an app fails fast rather than allocating as web automation', () => {
  assert.throws(() => buildCapabilities({ platform: 'ios' }, {}, [], creds), /must start with an app/);
  // an app supplied through the escape hatch is accepted
  assert.doesNotThrow(() => buildCapabilities({ platform: 'ios' }, { capabilities: { app: 'lt://X' } }, [], creds));
});

test('TestMu.Ai log capabilities use their documented spelling', () => {
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

test('device name patterns become TestMu.Ai regexes, literals pass through', () => {
  assert.equal(toTestMuDeviceName('iPhone 14 Pro'), 'iPhone 14 Pro');
  assert.equal(toTestMuDeviceName('iPhone 1[45]'), '(iPhone 1[45].*)');
  assert.equal(toTestMuDeviceName(undefined), undefined);
  assert.equal(lt({ platform: 'ios', deviceNamePattern: 'Pixel.*' }).deviceName, '(Pixel.*.*)');
});

test('osVersion ranges translate to a major-version alternation', () => {
  assert.equal(toTestMuPlatformVersion('17.2'), '17.2');
  assert.equal(toTestMuPlatformVersion('17'), '17');
  assert.equal(toTestMuPlatformVersion('>=17 <19'), '(17.*),(18.*),(19.*)');
  assert.equal(toTestMuPlatformVersion(undefined), undefined);
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

test('the app comes from options, TESTMU_APP, then LT_APP', () => {
  assert.deepEqual(appsForCriteria({ platform: 'ios' }, { app: 'lt://X' }), ['lt://X']);

  process.env.LT_APP = 'lt://FROM_LT';
  assert.deepEqual(appsForCriteria({ platform: 'ios' }, {}), ['lt://FROM_LT']);

  process.env.TESTMU_APP = 'lt://FROM_TESTMU';
  assert.deepEqual(appsForCriteria({ platform: 'ios' }, {}), ['lt://FROM_TESTMU'], 'TESTMU_ must win over LT_');

  delete process.env.TESTMU_APP;
  delete process.env.LT_APP;
});

test('credentials come from options, then TESTMU_, then LT_', () => {
  const clear = () => ['TESTMU_USERNAME', 'TESTMU_ACCESS_KEY', 'LT_USERNAME', 'LT_ACCESS_KEY']
    .forEach((k) => delete process.env[k]);
  clear();

  // explicit options win over everything
  assert.deepEqual(resolveCredentials({ username: 'u', accessKey: 'k' }, true), { username: 'u', accessKey: 'k' });

  // the LT_ names existing pipelines already set keep working
  process.env.LT_USERNAME = 'lt-user';
  process.env.LT_ACCESS_KEY = 'lt-key';
  assert.deepEqual(resolveCredentials({}, true), { username: 'lt-user', accessKey: 'lt-key' });

  // TESTMU_ takes precedence when both are present
  process.env.TESTMU_USERNAME = 'testmu-user';
  process.env.TESTMU_ACCESS_KEY = 'testmu-key';
  assert.deepEqual(resolveCredentials({}, true), { username: 'testmu-user', accessKey: 'testmu-key' });

  // the two families can be mixed
  delete process.env.TESTMU_ACCESS_KEY;
  assert.deepEqual(resolveCredentials({}, true), { username: 'testmu-user', accessKey: 'lt-key' });

  clear();
  assert.equal(resolveCredentials({}, false), undefined);
  assert.throws(() => resolveCredentials({}, true), /TESTMU_USERNAME \(or LT_USERNAME\)/);
});
