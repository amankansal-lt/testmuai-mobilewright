import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import createDebug from 'debug';
import { LambdaTestDriverError } from './errors.js';
import type { Credentials } from './capabilities.js';

const debug = createDebug('lambdatest:rest');

export const DEFAULT_API_URL = 'https://mobile-api.lambdatest.com/mobile-automation/api/v1';
export const DEFAULT_UPLOAD_URL = 'https://manual-api.lambdatest.com/app/upload/realDevice';

const UPLOAD_TIMEOUT_MS = 600_000;
const REQUEST_TIMEOUT_MS = 60_000;

export interface Concurrency {
  maxConcurrency: number;
  maxQueue: number;
  queued: number;
  running: number;
}

export class LambdaTestApi {
  private readonly authHeader: string;

  constructor(
    credentials: Credentials,
    private readonly apiUrl = DEFAULT_API_URL,
    private readonly uploadUrl = DEFAULT_UPLOAD_URL,
  ) {
    this.authHeader = `Basic ${Buffer.from(`${credentials.username}:${credentials.accessKey}`).toString('base64')}`;
  }

  /** The account's parallel-session limit, used to warn when workers exceed it. */
  async concurrency(): Promise<Concurrency | undefined> {
    try {
      const body = await this.json<{ data?: Record<string, number> }>('GET', '/org/concurrency');
      const data = body.data ?? {};
      return {
        maxConcurrency: data['max_concurrency'] ?? 0,
        maxQueue: data['max_queue'] ?? 0,
        queued: data['queued'] ?? 0,
        running: data['running'] ?? 0,
      };
    } catch (err) {
      debug('concurrency lookup failed: %s', (err as Error).message);
      return undefined;
    }
  }

  /** Sets a session's dashboard name and verdict after it has ended. */
  async updateSession(sessionId: string, patch: { name?: string; status_ind?: 'passed' | 'failed' }): Promise<void> {
    await this.json('PATCH', `/sessions/${encodeURIComponent(sessionId)}`, patch);
  }

  /**
   * Resolves an app reference to an `lt://` id.
   *
   * `lt://` refs and custom ids pass straight through; local files and public
   * URLs are uploaded. Uploads are cached per process by content hash (path and
   * size for large files), so a run uploads each build once even though every
   * worker slot asks for it.
   */
  async resolveApp(pathOrUrl: string, cache: Map<string, Promise<string>>): Promise<string> {
    if (pathOrUrl.startsWith('lt://')) return pathOrUrl;

    const key = /^https?:\/\//.test(pathOrUrl) ? pathOrUrl : await fileKey(pathOrUrl);
    const cached = cache.get(key);
    if (cached) return cached;

    const upload = this.uploadApp(pathOrUrl).catch((err: unknown) => {
      cache.delete(key);
      throw err;
    });
    cache.set(key, upload);
    return upload;
  }

  private async uploadApp(pathOrUrl: string): Promise<string> {
    const form = new FormData();
    const name = basename(pathOrUrl);

    if (/^https?:\/\//.test(pathOrUrl)) {
      form.append('url', pathOrUrl);
      form.append('storage', 'url');
    } else {
      const content = await readFile(pathOrUrl);
      form.append('appFile', new Blob([content]), name);
      form.append('storage', 'file');
    }
    form.append('name', name);

    debug('uploading %s', pathOrUrl);
    const response = await fetch(this.uploadUrl, {
      method: 'POST',
      headers: { Authorization: this.authHeader },
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new LambdaTestDriverError(`App upload failed (${response.status}): ${text.slice(0, 400)}`);
    }
    const body = JSON.parse(text) as { app_url?: string; app_id?: string };
    const appUrl = body.app_url ?? (body.app_id ? `lt://${body.app_id}` : undefined);
    if (!appUrl) {
      throw new LambdaTestDriverError(`App upload response carried no app_url: ${text.slice(0, 400)}`);
    }
    debug('uploaded %s -> %s', name, appUrl);
    return appUrl;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: this.authHeader,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new LambdaTestDriverError(`${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }
}

/** Content hash for small builds, path+size+mtime for large ones. */
async function fileKey(path: string): Promise<string> {
  const info = await stat(path).catch(() => undefined);
  if (!info) {
    throw new LambdaTestDriverError(`App file not found: ${path}`);
  }
  if (info.size > 64 * 1024 * 1024) {
    return `${path}:${info.size}:${info.mtimeMs}`;
  }
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
