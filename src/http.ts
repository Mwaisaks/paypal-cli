import { randomUUID } from 'node:crypto';
import { BASE_URL, type Config } from './config.js';
import { PayPalApiError } from './errors.js';
import { maskString, registerSecret } from './mask.js';

export interface TokenInfo {
  accessToken: string;
  scopes: string[];
  appId?: string;
  expiresIn: number;
  obtainedAt: number;
}

const tokenCache = new Map<string, TokenInfo>();

function log(cfg: Config, line: string): void {
  if (cfg.verbose) process.stderr.write(maskString(`[http] ${line}`) + '\n');
}

/** Turns a fetch failure into a readable reason, e.g. "network error (ENOTFOUND api-m.sandbox.paypal.com)". */
export function netReason(e: unknown, timeoutMs: number): string {
  if (!(e instanceof Error)) return String(e);
  if (e.name === 'TimeoutError' || e.name === 'AbortError') {
    return `timed out after ${timeoutMs} ms (slow network? raise PAYPAL_CLI_TIMEOUT_MS)`;
  }
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code || cause?.message) return `network error (${cause.code ?? cause.message})`;
  return e.message;
}

/** Client-credentials token. Cached per process; secrets are registered for masking first. */
export async function getToken(cfg: Config, { fresh = false } = {}): Promise<TokenInfo> {
  registerSecret(cfg.clientSecret);
  const key = `${cfg.env}:${cfg.clientId}`;
  const cached = tokenCache.get(key);
  if (!fresh && cached && Date.now() - cached.obtainedAt < (cached.expiresIn - 60) * 1000) return cached;

  const path = '/v1/oauth2/token';
  log(cfg, `POST ${path}`);
  let res: Response;
  for (let attempt = 1; ; attempt++) {
    try {
      // Getting a token has no side effects, so it is safe to retry on network errors.
      res = await fetch(BASE_URL[cfg.env] + path, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      break;
    } catch (e) {
      if (attempt < 3) {
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`POST ${path} failed: ${netReason(e, cfg.timeoutMs)}`);
    }
  }
  const payload = await readBody(res);
  log(cfg, `-> ${res.status}`);
  if (!res.ok) {
    throw PayPalApiError.fromPayload(res.status, payload, { method: 'POST', path, env: cfg.env },
      res.headers.get('paypal-debug-id') ?? undefined);
  }
  const p = payload as { access_token: string; scope?: string; app_id?: string; expires_in: number };
  registerSecret(p.access_token);
  const info: TokenInfo = {
    accessToken: p.access_token,
    scopes: (p.scope ?? '').split(/\s+/).filter(Boolean),
    appId: p.app_id,
    expiresIn: p.expires_in,
    obtainedAt: Date.now(),
  };
  tokenCache.set(key, info);
  return info;
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface RequestOpts {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** PayPal-Request-Id. Generated for every POST unless given, so retries are idempotent. */
  requestId?: string;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/**
 * The hand-written client for APIs the APIMatic SDK does not cover (payouts, webhooks, events, simulate).
 * - timeout on every request
 * - retries only idempotent GETs (network errors, 408/429/5xx), with backoff
 * - PayPal-Request-Id on every POST
 */
export async function api<T = unknown>(cfg: Config, method: string, path: string, opts: RequestOpts = {}): Promise<T> {
  const url = new URL(BASE_URL[cfg.env] + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const requestId = method === 'POST' ? (opts.requestId ?? randomUUID()) : undefined;
  const maxAttempts = method === 'GET' ? 3 : 1;
  const reqInfo = { method, path: url.pathname + url.search, body: opts.body, env: cfg.env };

  for (let attempt = 1; ; attempt++) {
    const token = await getToken(cfg);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token.accessToken}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (requestId) headers['PayPal-Request-Id'] = requestId;
    log(cfg, `${method} ${reqInfo.path}${requestId ? ` (PayPal-Request-Id ${requestId})` : ''}`);

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
    } catch (e) {
      if (attempt < maxAttempts) {
        await sleep(400 * 2 ** (attempt - 1));
        continue;
      }
      throw new Error(`${method} ${reqInfo.path} failed: ${netReason(e, cfg.timeoutMs)}`);
    }

    const debugId = res.headers.get('paypal-debug-id') ?? undefined;
    log(cfg, `-> ${res.status}${debugId ? ` debug_id ${debugId}` : ''}`);
    if (res.ok) return (await readBody(res)) as T;
    if (RETRYABLE.has(res.status) && attempt < maxAttempts) {
      await sleep(400 * 2 ** (attempt - 1));
      continue;
    }
    throw PayPalApiError.fromPayload(res.status, await readBody(res), reqInfo, debugId);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
