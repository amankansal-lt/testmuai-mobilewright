import createDebug from 'debug';
import type { RunResultInfo, TestObserver } from '@mobilewright/protocol';

const debug = createDebug('testmu:observer');

const MAX_NAME_LENGTH = 255;
const MAX_TITLES_IN_NAME = 3;

interface StatusSink {
  /** Sessions this driver allocated and has not released yet. */
  liveSessionIds(): string[];
  setSessionStatus(sessionId: string, passed: boolean, reason?: string): Promise<void>;
  setSessionName(sessionId: string, name: string): Promise<void>;
}

/** One session's tests, folded out of the run report. */
interface SessionRecord {
  titles: string[];
  failed: string[];
  firstError?: string;
}

// The shape of Playwright's JSON report that matters here.
interface ReportSuite {
  suites?: ReportSuite[];
  specs?: {
    title?: string;
    tests?: {
      annotations?: { type?: string; description?: string }[];
      results?: { status?: string; errors?: { message?: string }[] }[];
    }[];
  }[];
}

/**
 * Folds the run report into per-session records, keyed by the `device.id`
 * annotation the mobilewright device fixture attaches to every test — which is
 * the session the test actually ran on.
 *
 * Two things this gets right that a single set of counters cannot: with several
 * workers each session is judged only by its own tests, and a test's outcome is
 * its FINAL attempt, so a flaky-then-passed retry does not fail the session.
 */
export function sessionRecordsFromReport(report: unknown): Map<string, SessionRecord> {
  const records = new Map<string, SessionRecord>();

  const visit = (suite: ReportSuite): void => {
    for (const child of suite.suites ?? []) visit(child);
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const sessionId = test.annotations?.find((a) => a.type === 'device.id')?.description;
        if (!sessionId) continue;

        const attempts = (test.results ?? []).filter((r) => r.status && r.status !== 'skipped');
        if (attempts.length === 0) continue;

        const final = attempts[attempts.length - 1];
        const passed = final.status === 'passed';
        const record = records.get(sessionId) ?? { titles: [], failed: [] };
        const title = spec.title ?? '(untitled)';

        record.titles.push(title);
        if (!passed) {
          record.failed.push(title);
          record.firstError ??= final.errors?.[0]?.message?.split('\n')[0];
        }
        records.set(sessionId, record);
      }
    }
  };

  for (const suite of (report as { suites?: ReportSuite[] } | undefined)?.suites ?? []) visit(suite);
  return records;
}

function sessionName(record: SessionRecord): string {
  if (record.titles.length === 1) return record.titles[0].slice(0, MAX_NAME_LENGTH);
  const shown = record.titles.slice(0, MAX_TITLES_IN_NAME).join(' · ');
  const rest = record.titles.length - MAX_TITLES_IN_NAME;
  return `${shown}${rest > 0 ? ` (+${rest} more)` : ''}`.slice(0, MAX_NAME_LENGTH);
}

/**
 * Names sessions and pushes verdicts to the TestMu.Ai dashboard.
 *
 * Runs in the coordinator process at the end of the run. Sessions may already
 * have been released by then, so the driver's status push falls back to the
 * REST API when the in-session executor hook no longer reaches them.
 */
export class TestMuObserver implements TestObserver {
  constructor(
    private readonly sink: StatusSink,
    private readonly options: { name?: string } = {},
  ) {}

  async onRunEnd(result: RunResultInfo): Promise<void> {
    let records = new Map<string, SessionRecord>();
    try {
      const report = await result.jsonReport?.();
      records = sessionRecordsFromReport(report);
    } catch (err) {
      debug('could not read the run report: %s', (err as Error).message);
    }

    if (records.size > 0) {
      debug('reporting %d session(s) from the run report', records.size);
      await Promise.all([...records].map(async ([sessionId, record]) => {
        const passed = record.failed.length === 0;
        await this.sink.setSessionName(sessionId, this.options.name ?? sessionName(record));
        await this.sink.setSessionStatus(sessionId, passed, record.firstError);
      }));
      return;
    }

    // No report, or no device.id annotations in it: fall back to the run's own
    // verdict on whatever sessions are still open. Coarser, but never silent.
    const live = this.sink.liveSessionIds();
    if (live.length === 0) {
      debug('no session records and no live sessions — nothing to report');
      return;
    }
    const passed = result.status === 'passed';
    debug('no per-session mapping available; applying the run verdict to %d session(s)', live.length);
    await Promise.all(live.map(async (sessionId) => {
      if (this.options.name) await this.sink.setSessionName(sessionId, this.options.name);
      await this.sink.setSessionStatus(sessionId, passed);
    }));
  }
}
