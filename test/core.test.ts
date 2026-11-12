import { afterEach, describe, expect, it } from 'vitest';
import { formatErrorLine, PayPalApiError, toSaved } from '../src/errors.js';
import { explainRules } from '../src/explain.js';
import { clearSecrets, maskId, maskString, maskValue, registerSecret } from '../src/mask.js';
import { OPS, sinceToIso } from '../src/ops/index.js';
import { toCliCommand } from '../src/ops/types.js';
import { decodeScopes, featureForPath } from '../src/scopes.js';
import { parseInput } from '../src/zodcli.js';

afterEach(() => clearSecrets());

describe('masking', () => {
  it('masks registered secrets, bearer and basic headers, and token fields', () => {
    registerSecret('EFGHsecretvalue123456');
    const s = maskString(
      'secret=EFGHsecretvalue123456 Authorization: Bearer A21AAabc.def-ghi Basic QWxhZGRpbjpvcGVu {"access_token":"tok123","client_secret":"cs"}',
    );
    expect(s).not.toContain('EFGHsecretvalue123456');
    expect(s).not.toContain('A21AAabc');
    expect(s).not.toContain('QWxhZGRpbjpvcGVu');
    expect(s).not.toContain('tok123');
    expect(s).toContain('"client_secret":"****"');
  });

  it('masks nested values and keeps only an ID prefix', () => {
    registerSecret('topsecret-1');
    expect(maskValue({ a: { b: ['x topsecret-1 y'] } })).toEqual({ a: { b: ['x **** y'] } });
    expect(maskId('AbCdEfGhIjKl')).toBe('AbCdEf…(12 chars)');
  });
});

describe('error formatting', () => {
  it('prints one line with name/issue and debug_id', () => {
    const err = PayPalApiError.fromPayload(
      422,
      {
        name: 'UNPROCESSABLE_ENTITY',
        message: 'The requested action could not be performed.',
        debug_id: 'f879abc',
        details: [{ issue: 'ORDER_NOT_APPROVED', description: 'Payer has not yet approved the Order for payment.' }],
      },
      { method: 'POST', path: '/v2/checkout/orders/5O1/capture' },
    );
    expect(formatErrorLine(err)).toBe(
      '422 UNPROCESSABLE_ENTITY/ORDER_NOT_APPROVED (debug_id f879abc) POST /v2/checkout/orders/5O1/capture',
    );
  });

  it('understands OAuth error payloads and header debug ids', () => {
    const err = PayPalApiError.fromPayload(401, { error: 'invalid_client', error_description: 'Client Authentication failed' },
      { method: 'POST', path: '/v1/oauth2/token' }, 'hdr123');
    expect(formatErrorLine(err)).toBe('401 invalid_client (debug_id hdr123) POST /v1/oauth2/token');
  });
});

describe('scopes', () => {
  it('decodes features from token scopes', () => {
    const status = decodeScopes([
      'https://uri.paypal.com/services/payments/payment/authcapture',
      'https://uri.paypal.com/services/applications/webhooks',
      'https://uri.paypal.com/payments/payouts',
    ]);
    const on = status.filter((s) => s.enabled).map((s) => s.feature.key);
    expect(on).toEqual(['checkout', 'payouts', 'webhooks']);
  });

  it('maps API paths to the feature that unlocks them', () => {
    expect(featureForPath('/v1/reporting/balances?currency_code=USD')?.key).toBe('reporting');
    expect(featureForPath('/v1/payments/payouts/ABC')?.key).toBe('payouts');
    expect(featureForPath('/v2/payments/captures/1/refund')?.key).toBe('refunds');
  });
});

describe('explain rules', () => {
  it('names the missing dashboard feature for a 403', () => {
    const err = PayPalApiError.fromPayload(403, { name: 'NOT_AUTHORIZED', message: 'Authorization failed due to insufficient permissions.', debug_id: 'd1' },
      { method: 'GET', path: '/v1/reporting/balances', env: 'sandbox' });
    const hints = explainRules(toSaved(err), { env: 'sandbox' });
    expect(hints[0]?.cause).toContain('Transaction search / Reporting');
    expect(hints[0]?.fix).toContain('Features');
  });
});

describe('operation registry', () => {
  it('has unique MCP names and CLI paths', () => {
    expect(new Set(OPS.map((o) => o.name)).size).toBe(OPS.length);
    expect(new Set(OPS.map((o) => o.command.join(' '))).size).toBe(OPS.length);
  });

  it('marks every money-moving op with a preview', () => {
    for (const op of OPS.filter((o) => o.kind === 'money')) expect(op.preview).toBeTypeOf('function');
  });

  it('turns CLI strings into validated input and back into the exact command', () => {
    const op = OPS.find((o) => o.name === 'payouts_send')!;
    const input = parseInput(op.input, { to: 'a@x.com, b@x.com', amount: '10' });
    expect(input).toEqual({ to: ['a@x.com', 'b@x.com'], amount: '10', currency: 'USD' });
    expect(toCliCommand(op, input)).toBe('paypal-cli payouts send --to a@x.com,b@x.com --amount 10 --currency USD');
    expect(() => parseInput(op.input, { to: 'nope', amount: '1' })).toThrow(/--to/);
  });

  it('parses --since durations', () => {
    const t = Date.parse(sinceToIso('2h'));
    expect(Math.abs(Date.now() - 2 * 3600_000 - t)).toBeLessThan(5_000);
    expect(() => sinceToIso('soon')).toThrow();
  });
});

describe('network errors', () => {
  it('names the cause of a fetch failure and of a timeout', async () => {
    const { netReason } = await import('../src/http.js');
    const fail = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    expect(netReason(fail, 20000)).toBe('network error (ENOTFOUND)');
    expect(netReason(Object.assign(new Error('x'), { name: 'TimeoutError' }), 20000)).toMatch(/timed out after 20000 ms/);
  });
});
