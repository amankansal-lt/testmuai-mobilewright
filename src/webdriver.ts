import createDebug from 'debug';
import { WebDriverError } from './errors.js';

const debug = createDebug('lambdatest:wd');

const W3C_ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';
const JSONWP_ELEMENT_KEY = 'ELEMENT';
const DEFAULT_COMMAND_TIMEOUT = 120_000;

interface W3CResponse {
  value?: unknown;
  sessionId?: string;
  status?: number;
}

function errorFrom(body: W3CResponse | undefined, fallback: string): { message: string; error?: string } {
  const value = body?.value as { message?: string; error?: string } | undefined;
  if (value?.message || value?.error) {
    return { message: value.message ?? value.error ?? fallback, error: value.error };
  }
  return { message: fallback };
}

/**
 * Stateless W3C WebDriver client. Every call takes an explicit sessionId so the
 * worker process can drive a session the coordinator process created.
 */
export class WebDriverClient {
  constructor(
    private readonly hubUrl: string,
    private readonly commandTimeout = DEFAULT_COMMAND_TIMEOUT,
  ) {}

  async newSession(capabilities: unknown, timeoutMs?: number): Promise<{ sessionId: string; capabilities: Record<string, unknown> }> {
    const body = await this.request('POST', '/session', { capabilities }, timeoutMs);
    const value = body?.value as { sessionId?: string; capabilities?: Record<string, unknown> } | undefined;
    const sessionId = value?.sessionId ?? body?.sessionId;
    if (!sessionId) {
      throw new WebDriverError(`newSession response carried no sessionId: ${JSON.stringify(body).slice(0, 400)}`, 200);
    }
    return { sessionId, capabilities: value?.capabilities ?? {} };
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request('DELETE', `/session/${sessionId}`);
  }

  async cmd<T = unknown>(method: string, sessionId: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const suffix = path.startsWith('/') ? path : `/${path}`;
    const response = await this.request(method, `/session/${sessionId}${suffix}`, body, timeoutMs);
    return response?.value as T;
  }

  get<T = unknown>(sessionId: string, path: string, timeoutMs?: number): Promise<T> {
    return this.cmd<T>('GET', sessionId, path, undefined, timeoutMs);
  }

  post<T = unknown>(sessionId: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    return this.cmd<T>('POST', sessionId, path, body, timeoutMs);
  }

  /** POST /execute/sync — carries both `mobile:` commands and LambdaTest executor payloads. */
  executeScript<T = unknown>(sessionId: string, script: string, args: unknown[] = []): Promise<T> {
    return this.post<T>(sessionId, '/execute/sync', { script, args });
  }

  /** Runs an Appium `mobile:` extension command. */
  mobile<T = unknown>(sessionId: string, command: string, arg?: unknown): Promise<T> {
    return this.executeScript<T>(sessionId, `mobile: ${command}`, arg === undefined ? [] : [arg]);
  }

  async source(sessionId: string): Promise<string> {
    return (await this.get<string>(sessionId, '/source')) ?? '';
  }

  async screenshot(sessionId: string): Promise<string> {
    return (await this.get<string>(sessionId, '/screenshot')) ?? '';
  }

  async performActions(sessionId: string, actions: unknown[]): Promise<void> {
    await this.post(sessionId, '/actions', { actions });
  }

  /** The focused element's id, or null when the platform reports none. */
  async activeElement(sessionId: string): Promise<string | null> {
    try {
      const value = await this.get<Record<string, string>>(sessionId, '/element/active');
      return value?.[W3C_ELEMENT_KEY] ?? value?.[JSONWP_ELEMENT_KEY] ?? null;
    } catch (err) {
      debug('activeElement unavailable: %s', (err as Error).message);
      return null;
    }
  }

  private async request(method: string, path: string, body?: unknown, timeoutMs = this.commandTimeout): Promise<W3CResponse | undefined> {
    const url = `${this.hubUrl}${path}`;
    const started = Date.now();
    debug('%s %s %s', method, path, body === undefined ? '' : JSON.stringify(body).slice(0, 200));

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new WebDriverError(`${method} ${path} failed after ${Date.now() - started}ms: ${(err as Error).message}`, 0);
    }

    const text = await response.text();
    let parsed: W3CResponse | undefined;
    try {
      parsed = text ? (JSON.parse(text) as W3CResponse) : undefined;
    } catch {
      parsed = undefined;
    }
    debug('%s %s -> %d in %dms', method, path, response.status, Date.now() - started);

    if (!response.ok) {
      const { message, error } = errorFrom(parsed, `${response.status} ${text.slice(0, 400)}`);
      throw new WebDriverError(`${method} ${path}: ${message}`, response.status, error);
    }
    // JSONWP-shaped errors arrive as HTTP 200 with a non-zero status field.
    if (typeof parsed?.status === 'number' && parsed.status !== 0) {
      const { message, error } = errorFrom(parsed, `legacy status ${parsed.status}`);
      throw new WebDriverError(`${method} ${path}: ${message}`, response.status, error);
    }
    return parsed;
  }
}

// ─── Action builders ────────────────────────────────────────────

interface PointerAction {
  type: string;
  duration?: number;
  x?: number;
  y?: number;
  button?: number;
}

export function pointerSequence(id: string, actions: PointerAction[]): unknown {
  return { type: 'pointer', id, parameters: { pointerType: 'touch' }, actions };
}

export function tapActions(x: number, y: number, holdMs = 80): unknown[] {
  return [
    pointerSequence('finger1', [
      { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: holdMs },
      { type: 'pointerUp', button: 0 },
    ]),
  ];
}

export function doubleTapActions(x: number, y: number): unknown[] {
  return [
    pointerSequence('finger1', [
      { type: 'pointerMove', duration: 0, x: Math.round(x), y: Math.round(y) },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
      { type: 'pause', duration: 120 },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ]),
  ];
}

export function swipeActions(x1: number, y1: number, x2: number, y2: number, durationMs = 400): unknown[] {
  return [
    pointerSequence('finger1', [
      { type: 'pointerMove', duration: 0, x: Math.round(x1), y: Math.round(y1) },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 100 },
      { type: 'pointerMove', duration: Math.max(durationMs, 50), x: Math.round(x2), y: Math.round(y2) },
      { type: 'pointerUp', button: 0 },
    ]),
  ];
}

/** Named keys → WebDriver key codepoints. */
export const KEY_CODEPOINTS: Record<string, string> = {
  enter: '',
  return: '',
  tab: '',
  backspace: '',
  delete: '',
  escape: '',
  space: ' ',
  arrowup: '',
  arrowdown: '',
  arrowleft: '',
  arrowright: '',
  home: '',
  end: '',
  shift: '',
  ctrl: '',
  control: '',
  alt: '',
  meta: '',
  cmd: '',
  command: '',
};

export function keyChordActions(chord: string): unknown {
  const parts = chord.split('+').map((p) => p.trim()).filter(Boolean);
  const keys = parts.map((part) => {
    const named = KEY_CODEPOINTS[part.toLowerCase()];
    if (named) return named;
    if ([...part].length === 1) return part;
    throw new Error(`Unsupported key "${part}" in chord "${chord}"`);
  });
  const actions: Array<{ type: string; value: string }> = [];
  for (const key of keys) actions.push({ type: 'keyDown', value: key });
  for (const key of [...keys].reverse()) actions.push({ type: 'keyUp', value: key });
  return { type: 'key', id: 'keyboard', actions };
}

export function typeTextActions(text: string): unknown {
  const actions: Array<{ type: string; value: string }> = [];
  for (const ch of text) {
    actions.push({ type: 'keyDown', value: ch });
    actions.push({ type: 'keyUp', value: ch });
  }
  return { type: 'key', id: 'keyboard', actions };
}
