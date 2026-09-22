import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionRecordsFromReport, TestMuObserver } from '../dist/observer.js';

// A Playwright JSON report, trimmed to the parts that matter: the device.id
// annotation the mobilewright fixture attaches, and the per-attempt results.
const spec = (title, sessionId, statuses, error) => ({
  title,
  tests: [{
    annotations: [{ type: 'device.platform', description: 'ios' }, { type: 'device.id', description: sessionId }],
    results: statuses.map((status) => ({ status, errors: error && status === 'failed' ? [{ message: error }] : [] })),
  }],
});

test('each session is judged only by the tests that ran on it', () => {
  // Two workers: worker B failed. Worker A must not be marked failed.
  const report = { suites: [{ specs: [
    spec('a1', 'session-A', ['passed']),
    spec('b1', 'session-B', ['failed'], 'expected true, got false'),
    spec('a2', 'session-A', ['passed']),
  ] }] };

  const records = sessionRecordsFromReport(report);
  assert.equal(records.size, 2);
  assert.deepEqual(records.get('session-A').failed, [], 'session A had no failures of its own');
  assert.equal(records.get('session-A').titles.length, 2);
  assert.deepEqual(records.get('session-B').failed, ['b1']);
  assert.equal(records.get('session-B').firstError, 'expected true, got false');
});

test('a retried test counts as its final attempt', () => {
  // Playwright reports this run green; the session must not be marked failed.
  const report = { suites: [{ specs: [spec('flaky', 'session-A', ['failed', 'passed'], 'transient')] }] };
  const records = sessionRecordsFromReport(report);
  assert.deepEqual(records.get('session-A').failed, [], 'flaky-then-passed is a pass');

  const stillFailing = sessionRecordsFromReport({ suites: [{ specs: [spec('bad', 'session-A', ['failed', 'failed'], 'boom')] }] });
  assert.deepEqual(stillFailing.get('session-A').failed, ['bad']);
});

test('skipped tests are ignored, and nested suites are walked', () => {
  const report = { suites: [{ suites: [{ specs: [
    spec('skipped-only', 'session-A', ['skipped']),
    spec('real', 'session-A', ['passed']),
  ] }] }] };
  const records = sessionRecordsFromReport(report);
  assert.deepEqual(records.get('session-A').titles, ['real']);
});

test('tests with no device.id are not attributed to a session', () => {
  const report = { suites: [{ specs: [{ title: 'no annotations', tests: [{ results: [{ status: 'passed' }] }] }] }] };
  assert.equal(sessionRecordsFromReport(report).size, 0);
});

test('the observer pushes one verdict per session, not the run verdict', async () => {
  const pushed = [];
  const observer = new TestMuObserver({
    liveSessionIds: () => ['session-A', 'session-B'],
    setSessionStatus: async (id, passed, reason) => { pushed.push({ id, passed, reason }); },
    setSessionName: async () => {},
  });

  await observer.onRunEnd({
    status: 'failed',
    startTime: new Date(),
    duration: 1,
    jsonReport: async () => ({ suites: [{ specs: [
      spec('a1', 'session-A', ['passed']),
      spec('b1', 'session-B', ['failed'], 'boom'),
    ] }] }),
  });

  const byId = Object.fromEntries(pushed.map((p) => [p.id, p]));
  assert.equal(byId['session-A'].passed, true, 'A passed its own tests despite the run failing');
  assert.equal(byId['session-B'].passed, false);
  assert.equal(byId['session-B'].reason, 'boom');
});

test('with no usable report it falls back to the run verdict on live sessions', async () => {
  const pushed = [];
  const observer = new TestMuObserver({
    liveSessionIds: () => ['session-A'],
    setSessionStatus: async (id, passed) => { pushed.push({ id, passed }); },
    setSessionName: async () => {},
  });

  await observer.onRunEnd({
    status: 'passed',
    startTime: new Date(),
    duration: 1,
    jsonReport: async () => { throw new Error('no report configured'); },
  });

  assert.deepEqual(pushed, [{ id: 'session-A', passed: true }]);
});
