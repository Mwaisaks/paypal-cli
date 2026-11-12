import { DASHBOARD_URL, type Config, type PayPalEnv } from './config.js';
import { PayPalApiError } from './errors.js';
import { api, getToken } from './http.js';
import { maskId } from './mask.js';
import { kv, pc } from './output.js';
import { decodeScopes } from './scopes.js';

export interface AuthResult {
  ok: boolean;
  env: PayPalEnv;
  clientId: string;
  appId?: string;
  expiresInSeconds?: number;
  scopeCount?: number;
  error?: string;
  /** Set when the credentials fail here but work in the other environment. */
  worksIn?: PayPalEnv;
}

/** Tests the credentials. On a 401, also tries the other environment to catch the classic sandbox/live mix-up. */
export async function authCheck(cfg: Config): Promise<AuthResult> {
  const base = { env: cfg.env, clientId: maskId(cfg.clientId) };
  try {
    const t = await getToken(cfg, { fresh: true });
    return { ...base, ok: true, appId: t.appId, expiresInSeconds: t.expiresIn, scopeCount: t.scopes.length };
  } catch (e) {
    if (!(e instanceof PayPalApiError)) throw e;
    const other: PayPalEnv = cfg.env === 'sandbox' ? 'live' : 'sandbox';
    let worksIn: PayPalEnv | undefined;
    if (e.status === 401) {
      try {
        await getToken({ ...cfg, env: other, verbose: false }, { fresh: true });
        worksIn = other;
      } catch {
        /* wrong in both */
      }
    }
    return { ...base, ok: false, error: `${e.status} ${e.errorName}: ${e.message}`, worksIn };
  }
}

export function renderAuth(r: AuthResult): string {
  if (r.ok) {
    return (
      `${pc.green('✓')} Credentials work in ${pc.bold(r.env)}\n` +
      kv([
        ['client id', r.clientId],
        ['app id', r.appId],
        ['token expires', r.expiresInSeconds ? `in ${Math.round(r.expiresInSeconds / 60)} min` : undefined],
        ['scopes', r.scopeCount],
      ]) +
      `\n${pc.dim('Rotated the secret? PayPal keeps the old one valid until you delete it in the dashboard.')}`
    );
  }
  let out = `${pc.red('✗')} Credentials rejected in ${r.env}: ${r.error}\n` + kv([['client id', r.clientId]]);
  if (r.worksIn) {
    out += `\n\n${pc.yellow('These credentials belong to ' + r.worksIn + '.')} Use --env ${r.worksIn} or set PAYPAL_ENV=${r.worksIn}.`;
  } else {
    out += `\n\nCheck PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET against ${DASHBOARD_URL[r.env]}`;
  }
  return out;
}

export interface DoctorCheck {
  status: 'ok' | 'warn' | 'fail';
  title: string;
  detail?: string;
  fix?: string;
}

export interface DoctorReport {
  env: PayPalEnv;
  auth: AuthResult;
  features: { key: string; label: string; enabled: boolean; blocks: string }[];
  webhooks: { id: string; url: string; events: number }[];
  checks: DoctorCheck[];
}

export async function doctor(cfg: Config): Promise<DoctorReport> {
  const auth = await authCheck(cfg);
  const checks: DoctorCheck[] = [];
  const report: DoctorReport = { env: cfg.env, auth, features: [], webhooks: [], checks };
  if (!auth.ok) {
    checks.push({
      status: 'fail',
      title: 'Credentials rejected',
      detail: auth.error,
      fix: auth.worksIn ? `They are ${auth.worksIn} credentials: use --env ${auth.worksIn}` : `Copy them again from ${DASHBOARD_URL[cfg.env]}`,
    });
    return report;
  }
  checks.push({ status: 'ok', title: `Credentials valid (${cfg.env}, app ${auth.appId ?? '?'})` });

  const token = await getToken(cfg);
  const decoded = decodeScopes(token.scopes);
  report.features = decoded.map((d) => ({ key: d.feature.key, label: d.feature.label, enabled: d.enabled, blocks: d.feature.blocks }));
  for (const key of ['payouts', 'reporting']) {
    const f = decoded.find((d) => d.feature.key === key);
    if (f && !f.enabled) {
      checks.push({
        status: 'warn',
        title: `${f.feature.label} is not enabled on this app`,
        detail: `Blocks: ${f.feature.blocks}. Calls return 403 NOT_AUTHORIZED.`,
        fix: `Dashboard → Apps & Credentials → your app → Features → tick "${f.feature.label}", save, then re-run doctor (new tokens pick it up).`,
      });
    }
  }

  try {
    const hooks = (await api<{ webhooks: { id: string; url: string; event_types: { name: string }[] }[] }>(
      cfg, 'GET', '/v1/notifications/webhooks')).webhooks ?? [];
    report.webhooks = hooks.map((h) => ({ id: h.id, url: h.url, events: h.event_types.length }));
    if (hooks.length === 0) {
      checks.push({
        status: 'warn',
        title: 'No webhooks registered',
        fix: 'paypal-cli webhooks create --url https://your-app.example.com/api/webhooks/paypal --events "*"',
      });
    } else {
      checks.push({ status: 'ok', title: `${hooks.length} webhook(s) registered (max 10 per app)` });
      for (const h of hooks) {
        if (/localhost|127\.0\.0\.1|\.local\b/.test(h.url)) {
          checks.push({ status: 'warn', title: `Webhook ${h.id} points at a local address`, detail: h.url, fix: 'PayPal cannot reach it. Use a public URL or a tunnel.' });
        }
      }
    }
    if (!cfg.webhookId) {
      checks.push({
        status: 'warn',
        title: 'PAYPAL_WEBHOOK_ID is not set',
        detail: 'Your app needs it to verify webhook signatures.',
        fix: hooks[0] ? `paypal-cli webhooks id ${hooks[0].url}` : 'Create a webhook first.',
      });
    } else if (!hooks.some((h) => h.id === cfg.webhookId)) {
      checks.push({
        status: 'fail',
        title: `PAYPAL_WEBHOOK_ID (${cfg.webhookId}) is not a webhook on this app`,
        detail: 'Signature verification will fail for every event.',
        fix: `Use one of: ${hooks.map((h) => h.id).join(', ') || '(none registered)'}`,
      });
    } else {
      checks.push({ status: 'ok', title: 'PAYPAL_WEBHOOK_ID matches a registered webhook' });
    }
  } catch (e) {
    if (e instanceof PayPalApiError) {
      checks.push({ status: 'fail', title: 'Could not list webhooks', detail: `${e.status} ${e.errorName}` });
    } else throw e;
  }
  return report;
}

export function renderDoctor(r: DoctorReport): string {
  const icon = { ok: pc.green('✓'), warn: pc.yellow('!'), fail: pc.red('✗') };
  const lines: string[] = [pc.bold(`paypal-cli doctor (${r.env})`), ''];
  if (r.features.length) {
    lines.push(pc.bold('Features (from token scopes)'));
    for (const f of r.features) lines.push(`  ${f.enabled ? pc.green('✓') : pc.dim('✗')} ${f.enabled ? f.label : pc.dim(f.label)}`);
    lines.push('');
  }
  lines.push(pc.bold('Checks'));
  for (const c of r.checks) {
    lines.push(`  ${icon[c.status]} ${c.title}`);
    if (c.detail) lines.push(`    ${pc.dim(c.detail)}`);
    if (c.fix) lines.push(`    ${pc.cyan('fix:')} ${c.fix}`);
  }
  const fails = r.checks.filter((c) => c.status === 'fail').length;
  const warns = r.checks.filter((c) => c.status === 'warn').length;
  lines.push('', fails ? pc.red(`${fails} problem(s), ${warns} warning(s)`) : warns ? pc.yellow(`${warns} warning(s)`) : pc.green('All good.'));
  return lines.join('\n');
}
