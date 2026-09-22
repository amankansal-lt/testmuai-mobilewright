import createDebug from 'debug';
import type { WebViewSession } from '@mobilewright/protocol';
import type { WebDriverClient } from './webdriver.js';

const debug = createDebug('testmu:webview');

const SCRIPT_TIMEOUT_MS = 30_000;

interface ContextSwitcher {
  switchContext(name: string): Promise<void>;
}

interface AsyncResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Drives one webview context through Appium.
 *
 * Every call runs through `/execute/async`: XCUITest stopped awaiting promises
 * returned from `/execute/sync`, so a sync evaluate resolves to `{}` for any
 * async expression — and mobilewright's webview locators are built on
 * Playwright's injected engine, which returns promises throughout.
 */
export class WebViewSessionImpl implements WebViewSession {
  private timeoutsSet = false;

  constructor(
    private readonly hub: WebDriverClient,
    private readonly sessionId: string,
    private readonly driver: ContextSwitcher,
    private readonly contextId: string,
  ) {}

  async evaluate<T = unknown>(expr: string): Promise<T> {
    await this.enter();
    const script = `
      var callback = arguments[arguments.length - 1];
      try {
        Promise.resolve((function () { return (${expr}); })()).then(
          function (value) { callback({ ok: true, value: value }); },
          function (err) { callback({ ok: false, error: String((err && err.message) || err) }); }
        );
      } catch (err) {
        callback({ ok: false, error: String((err && err.message) || err) });
      }`;

    const result = await this.hub.post<AsyncResult>(this.sessionId, '/execute/async', { script, args: [] });
    if (result && result.ok === false) {
      throw new Error(result.error ?? 'webview evaluate failed');
    }
    return result?.value as T;
  }

  async goto(url: string): Promise<void> {
    await this.enter();
    await this.hub.post(this.sessionId, '/url', { url });
  }

  async goBack(): Promise<void> {
    await this.enter();
    await this.hub.post(this.sessionId, '/back');
  }

  async goForward(): Promise<void> {
    await this.enter();
    await this.hub.post(this.sessionId, '/forward');
  }

  async url(): Promise<string> {
    await this.enter();
    return (await this.hub.get<string>(this.sessionId, '/url')) ?? '';
  }

  async title(): Promise<string> {
    await this.enter();
    return (await this.hub.get<string>(this.sessionId, '/title')) ?? '';
  }

  async reload(): Promise<void> {
    await this.enter();
    await this.hub.post(this.sessionId, '/refresh');
  }

  async waitForLoadState(state: 'load' | 'domcontentloaded' = 'load'): Promise<void> {
    const wanted = state === 'domcontentloaded' ? ['interactive', 'complete'] : ['complete'];
    const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
    for (;;) {
      const ready = await this.evaluate<string>('document.readyState');
      if (wanted.includes(ready)) return;
      if (Date.now() >= deadline) {
        throw new Error(`waitForLoadState("${state}") timed out; document.readyState is "${ready}"`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async close(): Promise<void> {
    await this.driver.switchContext('NATIVE_APP');
    debug('detached from %s', this.contextId);
  }

  private async enter(): Promise<void> {
    await this.driver.switchContext(this.contextId);
    if (this.timeoutsSet) return;
    try {
      await this.hub.post(this.sessionId, '/timeouts', { script: SCRIPT_TIMEOUT_MS });
    } catch (err) {
      debug('could not set script timeout: %s', (err as Error).message);
    }
    this.timeoutsSet = true;
  }
}
