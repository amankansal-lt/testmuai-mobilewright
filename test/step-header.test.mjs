import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { LambdaTestDriver } from '../dist/driver.js';

const SESSION_ID = '0123456789abcdef0123';

const SOURCE = `<AppiumAUT><XCUIElementTypeButton type="XCUIElementTypeButton" name="go" label="Go"
  enabled="true" visible="true" x="0" y="0" width="100" height="40"/></AppiumAUT>`;

/** A stub WebDriver server that records what every request carried. */
async function startHub() {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, path: req.url, step: req.headers['x-lt-framework-step'], body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/session') {
        res.end(JSON.stringify({ value: { sessionId: SESSION_ID, capabilities: { deviceName: 'iPhone 14', platformVersion: '17.2' } } }));
      } else if (req.url.endsWith('/source')) {
        res.end(JSON.stringify({ value: SOURCE }));
      } else if (req.url.endsWith('/actions') || req.url.endsWith('/appium/settings')) {
        res.end(JSON.stringify({ value: null }));
      } else {
        res.end(JSON.stringify({ value: {} }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // fetch keeps sockets alive, so idle connections must be dropped or close() hangs
  return {
    seen,
    port: server.address().port,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }),
  };
}

test('each command is labelled with the Mobilewright verb behind it', async () => {
  const hub = await startHub();
  const driver = new LambdaTestDriver({ hubUrl: `http://127.0.0.1:${hub.port}` });

  await driver.connect({ platform: 'ios', deviceId: SESSION_ID });
  await driver.getViewHierarchy();
  await driver.tap(10, 20);

  const source = hub.seen.find((r) => r.path.endsWith('/source'));
  const actions = hub.seen.find((r) => r.path.endsWith('/actions'));
  assert.equal(source.step, 'getViewHierarchy');
  assert.equal(actions.step, 'tap');

  // Commands raised outside a labelled verb carry no header rather than a stale one.
  const settings = hub.seen.find((r) => r.path.endsWith('/appium/settings'));
  assert.equal(settings.step, undefined);

  await hub.close();
});

test('snapshot tuning is applied on connect and can be disabled', async () => {
  const on = await startHub();
  await new LambdaTestDriver({ hubUrl: `http://127.0.0.1:${on.port}` }).connect({ platform: 'ios', deviceId: SESSION_ID });
  const applied = on.seen.find((r) => r.path.endsWith('/appium/settings'));
  assert.deepEqual(JSON.parse(applied.body).settings, { waitForIdleTimeout: 0, animationCoolOffTimeout: 0 });
  await on.close();

  const off = await startHub();
  await new LambdaTestDriver({ hubUrl: `http://127.0.0.1:${off.port}`, snapshotTuning: false })
    .connect({ platform: 'ios', deviceId: SESSION_ID });
  assert.equal(off.seen.find((r) => r.path.endsWith('/appium/settings')), undefined);
  await off.close();
});

test('the page source is parsed into ViewNodes end to end', async () => {
  const hub = await startHub();
  const driver = new LambdaTestDriver({ hubUrl: `http://127.0.0.1:${hub.port}` });
  await driver.connect({ platform: 'ios', deviceId: SESSION_ID });

  const [node] = await driver.getViewHierarchy();
  assert.equal(node.type, 'XCUIElementTypeButton');
  assert.equal(node.identifier, 'go');
  assert.equal(node.label, 'Go');
  assert.deepEqual(node.bounds, { x: 0, y: 0, width: 100, height: 40 });

  await hub.close();
});

test('a standalone connect creates its own session and releases it', async () => {
  const hub = await startHub();
  const driver = new LambdaTestDriver({ hubUrl: `http://127.0.0.1:${hub.port}` });
  try {
    // A pattern with metacharacters becomes a LambdaTest regex; a literal name
    // is sent as-is.
    const session = await driver.connect({ platform: 'ios', deviceName: /iPhone 1[45]/ });
    assert.equal(session.deviceId, SESSION_ID);
    const created = hub.seen.find((r) => r.path === '/session');
    assert.equal(JSON.parse(created.body).capabilities.alwaysMatch['appium:deviceName'], '(iPhone 1[45].*)');

    await driver.disconnect();
    assert.ok(hub.seen.some((r) => r.method === 'DELETE' && r.path === `/session/${SESSION_ID}`));
  } finally {
    // An assertion failure must not leave the keepalive interval running, or
    // the test file never exits.
    await driver.dispose();
    await hub.close();
  }
});

test('devcluster hubs are recognised as LambdaTest hubs', async () => {
  const hub = await startHub();
  // lambdatestinternal.com is the devcluster domain; a plain Appium host is not.
  const dev = new LambdaTestDriver({
    hubUrl: `http://mobile-hub-demo-dev.lambdatestinternal.com:${hub.port}/wd/hub`,
    username: 'u',
    accessKey: 'k',
  });
  const caps = dev.buildCapabilitiesForTest({ platform: 'ios' });
  assert.equal(caps.isRealMobile, true, 'devcluster hub must use LambdaTest capability style');
  assert.equal(caps.frameworkType, 'mobilewright');

  const plain = new LambdaTestDriver({ hubUrl: `http://127.0.0.1:${hub.port}` });
  assert.equal(plain.buildCapabilitiesForTest({ platform: 'ios' }).isRealMobile, undefined);

  // explicit override wins over the hostname
  const forced = new LambdaTestDriver({ hubUrl: `http://127.0.0.1:${hub.port}`, capabilityStyle: 'lambdatest', username: 'u', accessKey: 'k' });
  assert.equal(forced.buildCapabilitiesForTest({ platform: 'ios' }).isRealMobile, true);

  await hub.close();
});
