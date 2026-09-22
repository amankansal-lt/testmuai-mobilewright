import createDebug from 'debug';
import type { RunResultInfo, TestInfo, TestObserver, TestResultInfo } from '@mobilewright/protocol';

const debug = createDebug('testmu:observer');

interface StatusSink {
  /** Sessions this driver allocated and has not released yet. */
  liveSessionIds(): string[];
  setSessionStatus(sessionId: string, passed: boolean, reason?: string): Promise<void>;
  setSessionName(sessionId: string, name: string): Promise<void>;
}

/**
 * Names sessions and pushes verdicts to the TestMu.Ai dashboard.
 *
 * Runs in the coordinator process, the same one that allocated the sessions,
 * so it can reach them directly. Verdicts are pushed at `onRunEnd`, while the
 * sessions are still alive — the executor hooks only work on a live session.
 *
 * A pooled session hosts several tests, so it is reported with a run summary
 * rather than one test's verdict. Per-test naming requires `sessionPerTest`.
 */
export class TestMuObserver implements TestObserver {
  private passed = 0;
  private failed = 0;
  private total = 0;
  private firstFailure: string | undefined;
  private lastTestTitle: string | undefined;

  constructor(
    private readonly sink: StatusSink,
    private readonly options: { sessionPerTest?: boolean; name?: string } = {},
  ) {}

  onTestEnd(test: TestInfo, result: TestResultInfo): void {
    // Retries land here too; only the final attempt of a test counts.
    if (result.status === 'skipped') return;
    this.total += 1;
    this.lastTestTitle = test.title;
    if (result.status === 'passed') {
      this.passed += 1;
      return;
    }
    this.failed += 1;
    this.firstFailure ??= result.errors[0]?.split('\n')[0];
  }

  async onRunEnd(result: RunResultInfo): Promise<void> {
    const sessions = this.sink.liveSessionIds();
    if (sessions.length === 0) {
      debug('no live sessions at run end — nothing to report');
      return;
    }

    const allPassed = this.failed === 0 && result.status === 'passed';
    const name = this.sessionName();
    debug('reporting %s to %d session(s)', allPassed ? 'passed' : 'failed', sessions.length);

    await Promise.all(sessions.map(async (sessionId) => {
      if (name) await this.sink.setSessionName(sessionId, name);
      await this.sink.setSessionStatus(sessionId, allPassed, this.firstFailure);
    }));
  }

  /**
   * The verdict so far. Read by the driver when it releases a session: a
   * released session is deleted, and the executor hooks only reach a live one,
   * so this is the last moment a status can be pushed for it.
   */
  verdict(): { passed: boolean; name: string | undefined; reason: string | undefined } | undefined {
    if (this.total === 0) return undefined;
    return { passed: this.failed === 0, name: this.sessionName(), reason: this.firstFailure };
  }

  private sessionName(): string | undefined {
    if (this.options.name) return this.options.name;
    // One test in the whole run (or one session per test) — name it after that
    // test. Otherwise a count is the only thing we can honestly claim.
    if (this.total === 1 && this.lastTestTitle) return this.lastTestTitle;
    if (this.total === 0) return undefined;
    return `${this.passed}/${this.total} tests passed`;
  }
}
