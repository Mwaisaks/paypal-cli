import Anthropic from '@anthropic-ai/sdk';
import { DASHBOARD_URL, type Config } from './config.js';
import type { SavedError } from './errors.js';
import { maskValue } from './mask.js';
import { pc } from './output.js';
import { featureForPath } from './scopes.js';

export interface Hint {
  cause: string;
  fix: string;
}

const issuesOf = (e: SavedError) => new Set([e.name, ...e.details.map((d) => d.issue ?? '')].filter(Boolean));

/** Deterministic hints for the errors we hit most. Works offline, no API key. */
export function explainRules(e: SavedError, cfg: Pick<Config, 'env'>): Hint[] {
  const hints: Hint[] = [];
  const issues = issuesOf(e);
  const has = (...names: string[]) => names.some((n) => issues.has(n));
  const path = e.request?.path ?? '';
  const env = e.request?.env ?? cfg.env;

  if (e.status === 401 || has('invalid_client', 'AUTHENTICATION_FAILURE', 'invalid_token')) {
    hints.push({
      cause: 'PayPal rejected the credentials or token.',
      fix: `Run \`paypal-cli auth check\`. It also tests the other environment, because sandbox credentials used against live (or the reverse) is the most common cause. Re-copy the ID and secret from ${DASHBOARD_URL[env]}.`,
    });
  }
  if (e.status === 403 || has('NOT_AUTHORIZED', 'PERMISSION_DENIED', 'INSUFFICIENT_SCOPE')) {
    const f = featureForPath(path);
    hints.push({
      cause: f
        ? `This app does not have the "${f.label}" feature, so its token lacks the scope for ${path.split('?')[0]}.`
        : 'The app is not authorized for this API (missing feature or scope).',
      fix: f
        ? `Dashboard → Apps & Credentials → your ${env} app → Features → enable "${f.label}", save, then run \`paypal-cli doctor\` to confirm the new scope. Tokens issued before the change keep the old scopes.`
        : 'Run `paypal-cli doctor` to see which features the app has.',
    });
  }
  if (has('RESOURCE_NOT_FOUND', 'INVALID_RESOURCE_ID')) {
    hints.push({
      cause: 'The ID does not exist for these credentials.',
      fix: `Check the ID, and that it was created in ${env} by this same app (IDs from another app or environment return 404).`,
    });
  }
  if (has('ORDER_NOT_APPROVED', 'PAYER_ACTION_REQUIRED')) {
    hints.push({
      cause: 'The buyer has not approved the order yet.',
      fix: 'Open the order\'s approve link, log in as a sandbox *personal* account and approve, then capture. `paypal-cli orders create --wait --capture` does all of it.',
    });
  }
  if (has('ORDER_ALREADY_CAPTURED', 'DUPLICATE_INVOICE_ID')) {
    hints.push({
      cause: 'This order (or invoice ID) was already used.',
      fix: 'Nothing to retry. Fetch the order with `paypal-cli orders get <id>` to see the existing capture. Reuse the same PayPal-Request-Id when retrying POSTs so duplicates return the original result.',
    });
  }
  if (has('INSUFFICIENT_FUNDS', 'SENDER_INSUFFICIENT_FUNDS')) {
    hints.push({
      cause: 'The business account does not have enough balance for this payout.',
      fix: 'Sandbox: Dashboard → Sandbox → Accounts → the business account → "…" → Add funds… or lower the amount. Note: GET /v1/reporting/balances needs the Reporting feature.',
    });
  }
  if (has('RECEIVER_UNREGISTERED', 'RECEIVER_UNCONFIRMED', 'RECEIVER_COUNTRY_NOT_ALLOWED')) {
    hints.push({
      cause: 'The payout receiver cannot accept this payment (no PayPal account, unconfirmed, or country/currency mismatch).',
      fix: 'In sandbox, send to a sandbox personal account created in the same country as the currency (e.g. US for USD). Unclaimed payouts are returned after 30 days.',
    });
  }
  if (has('WEBHOOK_URL_ALREADY_EXISTS')) {
    hints.push({ cause: 'A webhook with this URL already exists on the app.', fix: 'Get its ID with `paypal-cli webhooks id <url>` instead of creating a new one.' });
  }
  if (has('WEBHOOK_NUMBER_LIMIT_EXCEEDED')) {
    hints.push({ cause: 'Apps can have at most 10 webhooks.', fix: 'Delete unused ones: `paypal-cli webhooks list`, then `paypal-cli webhooks delete <id>`.' });
  }
  if (has('INVALID_WEBHOOK_URL', 'WEBHOOK_URL_INVALID', 'INVALID_URL')) {
    hints.push({ cause: 'PayPal only accepts public https URLs for webhooks.', fix: 'Use a deployed URL or a tunnel (e.g. cloudflared). localhost and http:// are rejected.' });
  }
  if (has('DUPLICATE_REQUEST_ID')) {
    hints.push({ cause: 'This PayPal-Request-Id was already used with a different body.', fix: 'Use a new --request-id, or resend the exact same body to get the original result back.' });
  }
  if (e.status === 422 && hints.length === 0 && e.details.length) {
    hints.push({ cause: 'PayPal understood the request but a business rule rejected it.', fix: `Read the issue code(s) above: ${e.details.map((d) => d.issue).join(', ')}.` });
  }
  if (e.status === 400 && hints.length === 0) {
    const fields = e.details.map((d) => d.field).filter(Boolean);
    hints.push({
      cause: 'The request body or parameters are invalid.',
      fix: fields.length ? `Check these fields: ${fields.join(', ')}.` : 'Compare the request body with the API reference.',
    });
  }
  if (e.status >= 500) {
    hints.push({
      cause: 'PayPal had a server-side problem.',
      fix: `Retry with the same PayPal-Request-Id. If it persists, contact PayPal support with debug_id ${e.debug_id ?? '(none)'}.`,
    });
  }
  return hints;
}

export function renderRules(e: SavedError, hints: Hint[]): string {
  const issue = e.details.find((d) => d.issue)?.issue;
  const lines = [
    pc.bold(`${e.status} ${e.name}${issue ? '/' + issue : ''}`) + (e.debug_id ? pc.dim(` debug_id ${e.debug_id}`) : ''),
    pc.dim(`${e.request.method} ${e.request.path} (${e.request.env ?? '?'}, ${e.at})`),
  ];
  if (e.message) lines.push(e.message);
  if (hints.length === 0) lines.push('', pc.dim('No built-in rule matches this error.'));
  for (const h of hints) lines.push('', `${pc.yellow('cause:')} ${h.cause}`, `${pc.cyan('fix:')}   ${h.fix}`);
  return lines.join('\n');
}

const SYSTEM = `You are the error explainer inside paypal-cli, an unofficial PayPal REST API developer CLI.
You get one failed PayPal API call: the request (method, path, body), the HTTP status, PayPal's error payload
(name, message, debug_id, details[].issue/field/description) and rule-based hints that may already apply.

Answer in plain text for a terminal, at most ~12 lines, in this shape:
Cause: one or two sentences naming the most likely cause, specific to this request.
Fix:
1. concrete step (exact dashboard path, field, value or paypal-cli command)
2. …
Why: one sentence linking the issue code to the cause.

Rules: be specific to the payload, never generic. Prefer paypal-cli commands where they exist:
auth check, doctor, webhooks list|create|delete|id|event-types, events list|show|resend, trigger,
orders create|get|capture, payouts send|get|item. Mention the debug_id only for PayPal support.
If the rule-based hints are right, build on them; if they are wrong, say so. Do not invent API fields.
No markdown headers, no bold.`;

/** Asks Claude for an explanation. Returns undefined when no key is configured. */
export async function explainWithAI(e: SavedError, hints: Hint[], cfg: Config, scopes?: string[]): Promise<string | undefined> {
  if (!cfg.anthropicKey) return undefined;
  const client = new Anthropic({ apiKey: cfg.anthropicKey, timeout: 60_000 });
  const context = maskValue({ error: e, rule_hints: hints, app_scopes: scopes, environment: e.request.env ?? cfg.env });
  const response = await client.messages.create({
    model: cfg.model,
    max_tokens: 16000,
    output_config: { effort: 'low' },
    system: SYSTEM,
    messages: [{ role: 'user', content: `Explain this failed PayPal call:\n\n${JSON.stringify(context, null, 2)}` }],
  });
  if (response.stop_reason === 'refusal') return undefined;
  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
