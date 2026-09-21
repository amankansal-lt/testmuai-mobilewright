import createDebug from 'debug';
import { WebDriverError } from './errors.js';
import type { WebDriverClient } from './webdriver.js';

const debug = createDebug('lambdatest:keepalive');

const PING_INTERVAL_MS = 45_000;
const PING_TIMEOUT_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Keeps pooled sessions alive between tests.
 *
 * Mobilewright allocates one session per worker slot and reuses it, so a slot
 * sits idle between allocation and the first command, and again between tests.
 * Without a ping the hub's idle reaper takes the session mid-run. Pings go to
 * the hub (a cheap read-only command), never the rate-limited REST API.
 */
export class Keepalive {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly client: WebDriverClient) {}

  start(sessionId: string): void {
    if (this.timers.has(sessionId)) return;

    let failures = 0;
    const timer = setInterval(() => {
      this.client.get(sessionId, '/orientation', PING_TIMEOUT_MS).then(
        () => { failures = 0; },
        (err: unknown) => {
          failures += 1;
          const gone = err instanceof WebDriverError && err.isSessionGone;
          const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
          // Tolerate transient blips; stop immediately once the session is gone
          // for good, so we don't ping a dead id for the rest of the run.
          if (gone || failures >= MAX_CONSECUTIVE_FAILURES) {
            debug('stopping keepalive for %s (%s): %s', sessionId, gone ? 'session gone' : 'repeated failures', reason);
            this.stop(sessionId);
          } else {
            debug('transient ping failure %d/%d for %s: %s', failures, MAX_CONSECUTIVE_FAILURES, sessionId, reason);
          }
        },
      );
    }, PING_INTERVAL_MS);

    timer.unref?.();
    this.timers.set(sessionId, timer);
    debug('started for %s', sessionId);
  }

  stop(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer) return;
    clearInterval(timer);
    this.timers.delete(sessionId);
    debug('stopped for %s', sessionId);
  }

  stopAll(): void {
    for (const sessionId of [...this.timers.keys()]) this.stop(sessionId);
  }
}
