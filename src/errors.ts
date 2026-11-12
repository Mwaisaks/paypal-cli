import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, type PayPalEnv } from './config.js';
import { maskValue } from './mask.js';

export interface ErrorDetail {
  field?: string;
  value?: string;
  location?: string;
  issue?: string;
  description?: string;
}

/** A PayPal REST error, normalised from either our fetch client or the APIMatic SDK. */
export class PayPalApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorName: string,
    message: string,
    public readonly debugId: string | undefined,
    public readonly details: ErrorDetail[],
    public readonly payload: unknown,
    public readonly request: { method: string; path: string; body?: unknown; env?: PayPalEnv },
  ) {
    super(message);
    this.name = 'PayPalApiError';
  }

  static fromPayload(
    status: number,
    payload: unknown,
    request: PayPalApiError['request'],
    headerDebugId?: string,
  ): PayPalApiError {
    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
    // REST errors use {name, message, debug_id, details}; OAuth errors use {error, error_description}.
    const name = String(p.name ?? p.error ?? httpName(status));
    const message = String(p.message ?? p.error_description ?? (typeof payload === 'string' ? payload : ''));
    const debugId = (p.debug_id as string | undefined) ?? headerDebugId;
    const details = Array.isArray(p.details) ? (p.details as ErrorDetail[]) : [];
    return new PayPalApiError(status, name, message, debugId, details, payload, request);
  }
}

function httpName(status: number): string {
  const names: Record<number, string> = {
    400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND',
    409: 'CONFLICT', 415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'UNPROCESSABLE_ENTITY',
    429: 'RATE_LIMITED', 500: 'INTERNAL_SERVER_ERROR', 503: 'SERVICE_UNAVAILABLE',
  };
  return names[status] ?? `HTTP_${status}`;
}

/** One line, always: `422 UNPROCESSABLE_ENTITY/ORDER_NOT_APPROVED (debug_id f879…) POST /v2/checkout/orders/…/capture` */
export function formatErrorLine(err: PayPalApiError): string {
  const issue = err.details.find((d) => d.issue)?.issue;
  const code = issue ? `${err.errorName}/${issue}` : err.errorName;
  const debug = err.debugId ? ` (debug_id ${err.debugId})` : '';
  return `${err.status} ${code}${debug} ${err.request.method} ${err.request.path}`;
}

export function formatErrorDetails(err: PayPalApiError): string[] {
  const lines: string[] = [];
  if (err.message) lines.push(err.message);
  for (const d of err.details) {
    const where = d.field ? ` [${d.field}${d.location ? ` in ${d.location}` : ''}]` : '';
    lines.push(`- ${d.issue ?? 'issue'}${where}: ${d.description ?? ''}`.trim());
  }
  return lines;
}

const lastErrorFile = () => join(configDir(), 'last-error.json');

export interface SavedError {
  at: string;
  status: number;
  name: string;
  message: string;
  debug_id?: string;
  details: ErrorDetail[];
  request: PayPalApiError['request'];
  payload: unknown;
}

/** Saves the last failure (masked, 0600) so `paypal-cli explain` can pick it up. */
export function saveLastError(err: PayPalApiError): void {
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const saved: SavedError = maskValue({
      at: new Date().toISOString(),
      status: err.status,
      name: err.errorName,
      message: err.message,
      debug_id: err.debugId,
      details: err.details,
      request: err.request,
      payload: err.payload,
    });
    writeFileSync(lastErrorFile(), JSON.stringify(saved, null, 2), { mode: 0o600 });
  } catch {
    // best effort: never fail a command because the error log could not be written
  }
}

export function readLastError(): SavedError | undefined {
  try {
    return JSON.parse(readFileSync(lastErrorFile(), 'utf8')) as SavedError;
  } catch {
    return undefined;
  }
}

export function toSaved(err: PayPalApiError): SavedError {
  return {
    at: new Date().toISOString(),
    status: err.status,
    name: err.errorName,
    message: err.message,
    debug_id: err.debugId,
    details: err.details,
    request: err.request,
    payload: err.payload,
  };
}
