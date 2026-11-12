/**
 * Maps OAuth scopes in a client-credentials token to the dashboard features they come from.
 * The app's "Features" checkboxes (Apps & Credentials → app → Features) decide which scopes you get.
 */
export interface Feature {
  key: string;
  label: string;
  /** Substrings of scope URIs that prove the feature is enabled. */
  match: string[];
  /** What breaks without it. */
  blocks: string;
  /** API path prefixes that need this feature (used by `explain` for 403s). */
  paths: string[];
}

export const FEATURES: Feature[] = [
  {
    key: 'checkout',
    label: 'Accept payments (Orders v2)',
    match: ['/services/payments/payment/authcapture', '/services/payments/payment'],
    blocks: 'orders create/capture, checkout',
    paths: ['/v2/checkout/orders', '/v2/payments'],
  },
  {
    key: 'refunds',
    label: 'Refunds',
    match: ['/services/payments/refund'],
    blocks: 'refunding captures',
    paths: ['/v2/payments/captures'],
  },
  {
    key: 'payouts',
    label: 'Payouts',
    match: ['/payments/payouts', '/services/payments/payouts'],
    blocks: 'payouts send/get (POST /v1/payments/payouts)',
    paths: ['/v1/payments/payouts', '/v1/payments/payouts-item'],
  },
  {
    key: 'webhooks',
    label: 'Webhooks',
    match: ['/services/applications/webhooks'],
    blocks: 'webhooks list/create/delete, events, trigger',
    paths: ['/v1/notifications'],
  },
  {
    key: 'reporting',
    label: 'Transaction search / Reporting',
    match: ['/services/reporting/search/read', '/services/reporting'],
    blocks: 'balance and transaction search (GET /v1/reporting/*)',
    paths: ['/v1/reporting'],
  },
  {
    key: 'invoicing',
    label: 'Invoicing',
    match: ['/services/invoicing'],
    blocks: 'invoices',
    paths: ['/v2/invoicing'],
  },
  {
    key: 'subscriptions',
    label: 'Subscriptions',
    match: ['/services/subscriptions', '/services/billing'],
    blocks: 'billing plans and subscriptions',
    paths: ['/v1/billing'],
  },
  {
    key: 'disputes',
    label: 'Disputes',
    match: ['/services/disputes'],
    blocks: 'listing and responding to disputes',
    paths: ['/v1/customer/disputes'],
  },
  {
    key: 'vault',
    label: 'Vault (save payment methods)',
    match: ['/services/vault'],
    blocks: 'saved payment tokens',
    paths: ['/v3/vault'],
  },
  {
    key: 'login',
    label: 'Log in with PayPal',
    match: ['openid'],
    blocks: 'identity / userinfo',
    paths: ['/v1/identity'],
  },
];

export interface FeatureStatus {
  feature: Feature;
  enabled: boolean;
}

export function decodeScopes(scopes: string[]): FeatureStatus[] {
  return FEATURES.map((feature) => ({
    feature,
    enabled: scopes.some((s) => feature.match.some((m) => s === m || s.includes(m))),
  }));
}

/** The feature an API path belongs to, if we know it. */
export function featureForPath(path: string): Feature | undefined {
  const p = path.split('?')[0] ?? path;
  let best: Feature | undefined;
  let bestLen = 0;
  for (const f of FEATURES) {
    for (const prefix of f.paths) {
      if (p.startsWith(prefix) && prefix.length > bestLen) {
        best = f;
        bestLen = prefix.length;
      }
    }
  }
  return best;
}
