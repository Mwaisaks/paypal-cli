import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { openUrl, waitForApproval } from '../browser.js';
import { api } from '../http.js';
import { ago, kv, link, pc, statusColor, table } from '../output.js';
import { captureOrder, createOrder, getOrder } from '../sdk.js';
import { authCheck, doctor, renderAuth, renderDoctor } from '../doctor.js';
import { explainRules, renderRules } from '../explain.js';
import { readLastError } from '../errors.js';
import { defineOp, type Op } from './types.js';

// ---------- shared schemas ----------
const amount = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'amount like 10 or 10.50')
  .describe('Amount, e.g. 60 or 12.50');
const currency = z.string().length(3).default('USD').describe('ISO currency code (default USD)');
const requestId = z
  .string()
  .optional()
  .describe('PayPal-Request-Id for idempotency. Re-using one returns the original result instead of a duplicate');

/** "1h", "30m", "2d" → ISO timestamp that far in the past. */
export function sinceToIso(since: string): string {
  const m = /^(\d+)\s*([smhd])$/.exec(since.trim());
  if (!m) {
    const t = Date.parse(since);
    if (Number.isNaN(t)) throw new Error(`--since must look like 30m, 1h, 2d or an ISO date (got "${since}")`);
    return new Date(t).toISOString();
  }
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return new Date(Date.now() - Number(m[1]) * mult * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---------- types for the hand-written APIs ----------
interface Webhook {
  id: string;
  url: string;
  event_types: { name: string }[];
}
interface WebhookEvent {
  id: string;
  create_time: string;
  event_type: string;
  summary?: string;
  resource_type?: string;
  resource?: { id?: string };
  transmissions?: { webhook_id?: string; http_status?: number; status?: string; time_stamp?: string; transmission_id?: string }[];
}

// ---------- auth & doctor ----------
const authCheckOp = defineOp({
  name: 'auth_check',
  command: ['auth', 'check'],
  summary: 'Test the current credentials: environment, client ID prefix, app ID, token expiry. Never prints secrets.',
  kind: 'read',
  input: {},
  run: (cfg) => authCheck(cfg),
  render: renderAuth,
});

const doctorOp = defineOp({
  name: 'doctor',
  command: ['doctor'],
  summary: 'Diagnose the app: credentials, enabled features (from token scopes), webhook setup and PAYPAL_WEBHOOK_ID.',
  kind: 'read',
  input: {},
  run: (cfg) => doctor(cfg),
  render: renderDoctor,
});

// ---------- webhooks ----------
const webhooksList = defineOp({
  name: 'webhooks_list',
  command: ['webhooks', 'list'],
  summary: 'List the webhooks registered on this app (with their IDs).',
  kind: 'read',
  input: {},
  run: async (cfg) => (await api<{ webhooks: Webhook[] }>(cfg, 'GET', '/v1/notifications/webhooks')).webhooks ?? [],
  render: (hooks: Webhook[]) =>
    hooks.length === 0
      ? 'No webhooks registered. Create one with: paypal-cli webhooks create --url https://… --events "*"'
      : table(
          ['ID', 'URL', 'Events'],
          hooks.map((h) => [h.id, h.url, summariseEvents(h.event_types)]),
        ),
});

function summariseEvents(types: { name: string }[]): string {
  const names = types.map((t) => t.name);
  if (names.length <= 3) return names.join('\n');
  return `${names.slice(0, 3).join('\n')}\n… +${names.length - 3} more`;
}

const webhooksId = defineOp({
  name: 'webhooks_id',
  command: ['webhooks', 'id'],
  summary: 'Print only the webhook ID for a URL (for scripts and PAYPAL_WEBHOOK_ID).',
  kind: 'read',
  input: { url: z.string().url().describe('The webhook URL, exactly as registered') },
  positional: ['url'],
  run: async (cfg, { url }) => {
    const hooks = (await api<{ webhooks: Webhook[] }>(cfg, 'GET', '/v1/notifications/webhooks')).webhooks ?? [];
    const norm = (u: string) => u.replace(/\/+$/, '');
    const hit = hooks.find((h) => norm(h.url) === norm(url));
    if (!hit) {
      throw new Error(
        `No webhook is registered for ${url}.\nRegistered: ${hooks.map((h) => h.url).join(', ') || '(none)'}`,
      );
    }
    return { id: hit.id, url: hit.url };
  },
  render: (d: { id: string }) => d.id,
});

const webhooksCreate = defineOp({
  name: 'webhooks_create',
  command: ['webhooks', 'create'],
  summary: 'Register a webhook URL for event types ("*" = all events). URL must be public HTTPS.',
  kind: 'write',
  input: {
    url: z.string().url().describe('Public HTTPS URL that will receive events'),
    events: z.array(z.string()).default(['*']).describe('Event types, comma-separated (default "*")'),
  },
  preview: ({ url, events }) => `Register webhook ${url} for ${events.join(', ')}`,
  run: async (cfg, { url, events }) => {
    if (!url.startsWith('https://')) throw new Error('PayPal only delivers webhooks to public https:// URLs.');
    if (/localhost|127\.0\.0\.1/.test(url)) throw new Error('PayPal cannot reach localhost. Use a tunnel URL.');
    return api<Webhook>(cfg, 'POST', '/v1/notifications/webhooks', {
      body: { url, event_types: events.map((name) => ({ name })) },
    });
  },
  render: (h: Webhook) =>
    `${pc.green('✓')} Webhook created\n` +
    kv([['id', h.id], ['url', h.url], ['events', h.event_types.map((e) => e.name).join(', ')]]) +
    `\n\nUse it for signature verification:\n  PAYPAL_WEBHOOK_ID=${h.id}`,
});

const webhooksDelete = defineOp({
  name: 'webhooks_delete',
  command: ['webhooks', 'delete'],
  summary: 'Delete a webhook by ID.',
  kind: 'write',
  input: { id: z.string().describe('Webhook ID') },
  positional: ['id'],
  preview: ({ id }) => `Delete webhook ${id}`,
  run: async (cfg, { id }) => {
    await api(cfg, 'DELETE', `/v1/notifications/webhooks/${encodeURIComponent(id)}`);
    return { deleted: id };
  },
  render: (d: { deleted: string }) => `${pc.green('✓')} Deleted webhook ${d.deleted}`,
});

const eventTypes = defineOp({
  name: 'webhooks_event_types',
  command: ['webhooks', 'event-types'],
  summary: 'List every webhook event type PayPal can send (use with trigger and webhooks create).',
  kind: 'read',
  input: { filter: z.string().optional().describe('Only types containing this text, e.g. PAYOUTS') },
  run: async (cfg, { filter }) => {
    const res = await api<{ event_types: { name: string; description: string }[] }>(
      cfg, 'GET', '/v1/notifications/webhooks-event-types');
    const all = res.event_types ?? [];
    return filter ? all.filter((t) => t.name.toUpperCase().includes(filter.toUpperCase())) : all;
  },
  render: (types: { name: string; description: string }[]) =>
    table(['Event type', 'Description'], types.map((t) => [t.name, t.description.slice(0, 70)])),
});

// ---------- events ----------
const eventsList = defineOp({
  name: 'events_list',
  command: ['events', 'list'],
  summary: 'List recent webhook events PayPal generated for this app (what the dashboard\'s "Webhooks Events" page shows).',
  kind: 'read',
  input: {
    since: z.string().default('24h').describe('How far back: 30m, 6h, 2d or an ISO date (default 24h)'),
    type: z.string().optional().describe('Only this event type, e.g. PAYMENT.CAPTURE.COMPLETED'),
    limit: z.coerce.number().int().min(1).max(300).default(20).describe('Max events (default 20)'),
  },
  run: async (cfg, { since, type, limit }) => {
    const res = await api<{ events: WebhookEvent[] }>(cfg, 'GET', '/v1/notifications/webhooks-events', {
      query: {
        start_time: sinceToIso(since),
        end_time: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        event_type: type,
        page_size: limit,
      },
    });
    return res.events ?? [];
  },
  render: (events: WebhookEvent[]) =>
    events.length === 0
      ? 'No events in that window. Note: simulated events (paypal-cli trigger) never appear here.'
      : table(
          ['Event ID', 'When', 'Type', 'Resource', 'Summary'],
          events.map((e) => [e.id, ago(e.create_time), e.event_type, e.resource?.id, (e.summary ?? '').slice(0, 40)]),
        ),
});

const eventsShow = defineOp({
  name: 'events_show',
  command: ['events', 'show'],
  summary: 'Show one webhook event with its full resource and delivery attempts.',
  kind: 'read',
  input: { id: z.string().describe('Event ID (WH-…)') },
  positional: ['id'],
  run: (cfg, { id }) => api<WebhookEvent>(cfg, 'GET', `/v1/notifications/webhooks-events/${encodeURIComponent(id)}`),
  render: (e: WebhookEvent) => {
    const head = kv([
      ['id', e.id],
      ['type', e.event_type],
      ['created', `${e.create_time} (${ago(e.create_time)})`],
      ['summary', e.summary],
      ['resource', `${e.resource_type ?? ''} ${e.resource?.id ?? ''}`.trim()],
    ]);
    const tx = e.transmissions?.length
      ? '\n\nDeliveries:\n' +
        table(
          ['Webhook', 'Status', 'HTTP', 'When'],
          e.transmissions.map((t) => [t.webhook_id, statusColor(t.status), t.http_status, t.time_stamp]),
        )
      : '';
    return `${head}${tx}\n\n${pc.dim('Full payload: add --json')}`;
  },
});

const eventsResend = defineOp({
  name: 'events_resend',
  command: ['events', 'resend'],
  summary: 'Ask PayPal to deliver a real webhook event again (not available for simulated events).',
  kind: 'write',
  input: {
    id: z.string().describe('Event ID (WH-…)'),
    webhookIds: z.array(z.string()).optional().describe('Only resend to these webhook IDs, comma-separated'),
  },
  positional: ['id'],
  preview: ({ id }) => `Resend webhook event ${id}`,
  run: (cfg, { id, webhookIds }) =>
    api<WebhookEvent>(cfg, 'POST', `/v1/notifications/webhooks-events/${encodeURIComponent(id)}/resend`, {
      body: webhookIds?.length ? { webhook_ids: webhookIds } : {},
    }),
  render: (e: WebhookEvent) => `${pc.green('✓')} Resend queued for ${e.id} (${e.event_type})`,
});

const trigger = defineOp({
  name: 'trigger',
  command: ['trigger'],
  summary:
    'Send a simulated webhook event to a webhook (by ID or URL). Simulated events are mock data: ' +
    'they fail verify-webhook-signature, never appear in events list, and cannot be resent.',
  kind: 'write',
  input: {
    event: z.string().describe('Event type, e.g. PAYMENT.CAPTURE.COMPLETED (see webhooks event-types)'),
    webhookId: z.string().optional().describe('Target webhook ID (defaults to PAYPAL_WEBHOOK_ID)'),
    url: z.string().url().optional().describe('Or: target URL instead of a webhook ID'),
    resourceVersion: z.string().optional().describe('Resource version of the sample payload, e.g. 2.0'),
  },
  positional: ['event'],
  preview: ({ event, url, webhookId }, cfg) =>
    `Send a simulated ${event} to ${url ?? webhookId ?? cfg.webhookId ?? '(no target)'}`,
  run: async (cfg, { event, webhookId, url, resourceVersion }) => {
    const target = url ? { url } : { webhook_id: webhookId ?? cfg.webhookId };
    if (!url && !target.webhook_id) {
      throw new Error('Give --webhook-id or --url, or set PAYPAL_WEBHOOK_ID. List IDs with: paypal-cli webhooks list');
    }
    return api<WebhookEvent>(cfg, 'POST', '/v1/notifications/simulate-event', {
      body: { ...target, event_type: event, resource_version: resourceVersion },
    });
  },
  render: (e: WebhookEvent) =>
    `${pc.green('✓')} Simulated ${e.event_type} sent (${e.id})\n` +
    pc.yellow('Note: ') +
    'simulated events carry mock data. PayPal\'s verify-webhook-signature API rejects them, so an app that fails\n' +
    'closed will answer 4xx. That is expected. Test verification with a real sandbox event instead.',
});

// ---------- orders (official SDK, APIMatic-generated) ----------
interface OrderWire {
  id: string;
  status: string;
  purchase_units?: {
    amount?: { value: string; currency_code: string };
    payments?: { captures?: { id: string; status: string; amount: { value: string; currency_code: string } }[] };
  }[];
  links?: { rel: string; href: string }[];
  approved?: boolean;
}

function renderOrder(o: OrderWire): string {
  const pu = o.purchase_units?.[0];
  const cap = pu?.payments?.captures?.[0];
  const approve = link(o, 'payer-action', 'approve');
  return kv([
    ['order', o.id],
    ['status', statusColor(o.status)],
    ['amount', pu?.amount ? `${pu.amount.value} ${pu.amount.currency_code}` : undefined],
    ['capture', cap ? `${cap.id} ${statusColor(cap.status)}` : undefined],
    ['approve', o.status === 'CREATED' || o.status === 'PAYER_ACTION_REQUIRED' ? approve : undefined],
  ]);
}

const ordersCreate = defineOp({
  name: 'orders_create',
  command: ['orders', 'create'],
  summary: 'Create a checkout order (intent CAPTURE) and return the buyer approval link.',
  kind: 'write',
  input: {
    amount,
    currency,
    description: z.string().optional().describe('Purchase description shown to the buyer'),
    requestId,
    open: z.boolean().optional().describe('Open the approval page in the browser'),
    wait: z
      .boolean()
      .optional()
      .describe('CLI only: open the approval page and wait until the buyer approves (localhost redirect)'),
    capture: z.boolean().optional().describe('With --wait: capture as soon as the buyer approves'),
  },
  preview: ({ amount, currency }) => `Create an order for ${amount} ${currency}`,
  run: async (cfg, input) => {
    if (!input.wait) {
      const order = await createOrder(cfg, {
        ...input,
        returnUrl: 'https://example.com/paypal-cli/approved',
        cancelUrl: 'https://example.com/paypal-cli/cancelled',
      });
      const approve = link(order, 'payer-action', 'approve');
      if (input.open && approve) openUrl(approve);
      return order;
    }
    const waiter = await waitForApproval();
    try {
      const order = (await createOrder(cfg, { ...input, returnUrl: waiter.returnUrl, cancelUrl: waiter.cancelUrl })) as unknown as OrderWire;
      const approve = link(order, 'payer-action', 'approve');
      process.stderr.write(`Order ${order.id} created. Approve it as the sandbox buyer:\n  ${approve}\n`);
      if (approve) openUrl(approve);
      process.stderr.write(pc.dim('Waiting for the buyer… (Ctrl-C to stop)\n'));
      const r = await waiter.result;
      if (!r.approved) return { ...order, status: 'CANCELLED_BY_BUYER' };
      process.stderr.write(`${pc.green('✓')} Buyer approved.\n`);
      if (input.capture) return captureOrder(cfg, order.id, randomUUID());
      return getOrder(cfg, order.id);
    } finally {
      waiter.close();
    }
  },
  render: (o: OrderWire, input) => {
    let out = renderOrder(o);
    if (o.status === 'APPROVED') out += `\n\nCapture it with: paypal-cli orders capture ${o.id}`;
    else if (!input.wait && o.status !== 'COMPLETED') out += `\n\nAfter approval: paypal-cli orders capture ${o.id}`;
    return out;
  },
});

const ordersGet = defineOp({
  name: 'orders_get',
  command: ['orders', 'get'],
  summary: 'Show an order and its status (CREATED, APPROVED, COMPLETED…).',
  kind: 'read',
  input: { id: z.string().describe('Order ID') },
  positional: ['id'],
  run: (cfg, { id }) => getOrder(cfg, id),
  render: renderOrder,
});

const ordersCapture = defineOp({
  name: 'orders_capture',
  command: ['orders', 'capture'],
  summary: 'Capture an approved order (the buyer must have approved it).',
  kind: 'money',
  input: { id: z.string().describe('Order ID (must be APPROVED by the buyer)'), requestId },
  positional: ['id'],
  preview: ({ id }) => `Capture payment for order ${id}`,
  run: (cfg, { id, requestId: rid }) => captureOrder(cfg, id, rid ?? randomUUID()),
  render: renderOrder,
});

// ---------- payouts ----------
interface PayoutBatch {
  batch_header: {
    payout_batch_id: string;
    batch_status: string;
    time_created?: string;
    amount?: { value: string; currency: string };
    fees?: { value: string; currency: string };
    sender_batch_header?: { sender_batch_id?: string };
  };
  items?: {
    payout_item_id: string;
    transaction_id?: string;
    transaction_status?: string;
    payout_item?: { receiver?: string; amount?: { value: string; currency: string } };
    errors?: { name?: string; message?: string };
  }[];
}

const payoutsSend = defineOp({
  name: 'payouts_send',
  command: ['payouts', 'send'],
  summary: 'Send the same amount to one or more PayPal emails in one payout batch.',
  kind: 'money',
  input: {
    to: z.array(z.string().email()).min(1).max(50).describe('Recipient emails, comma-separated'),
    amount,
    currency,
    note: z.string().optional().describe('Note to recipients'),
    requestId,
  },
  preview: ({ to, amount, currency }) =>
    `Send ${amount} ${currency} to ${to.length} recipient(s): ${to.join(', ')} (total ${(Number(amount) * to.length).toFixed(2)} ${currency})`,
  run: async (cfg, { to, amount, currency, note, requestId: rid }) => {
    const batchId = rid ?? `paypal-cli-${randomUUID()}`;
    return api<PayoutBatch>(cfg, 'POST', '/v1/payments/payouts', {
      requestId: batchId,
      body: {
        sender_batch_header: { sender_batch_id: batchId, email_subject: 'You have a payout' },
        items: to.map((receiver, i) => ({
          recipient_type: 'EMAIL',
          receiver,
          amount: { value: amount, currency },
          note,
          sender_item_id: `${batchId}-${i + 1}`,
        })),
      },
    });
  },
  render: (b: PayoutBatch) =>
    `${pc.green('✓')} Payout batch ${b.batch_header.payout_batch_id} ${statusColor(b.batch_header.batch_status)}\n` +
    `Check item status with: paypal-cli payouts get ${b.batch_header.payout_batch_id}`,
});

const payoutsGet = defineOp({
  name: 'payouts_get',
  command: ['payouts', 'get'],
  summary: 'Show a payout batch and the status of every item in it.',
  kind: 'read',
  input: { batchId: z.string().describe('Payout batch ID') },
  positional: ['batchId'],
  run: (cfg, { batchId }) =>
    api<PayoutBatch>(cfg, 'GET', `/v1/payments/payouts/${encodeURIComponent(batchId)}`, { query: { page_size: 100 } }),
  render: (b: PayoutBatch) => {
    const h = b.batch_header;
    const head = kv([
      ['batch', h.payout_batch_id],
      ['status', statusColor(h.batch_status)],
      ['created', h.time_created ? `${h.time_created} (${ago(h.time_created)})` : undefined],
      ['amount', h.amount ? `${h.amount.value} ${h.amount.currency}` : undefined],
      ['fees', h.fees ? `${h.fees.value} ${h.fees.currency}` : undefined],
    ]);
    const items = b.items ?? [];
    return (
      head +
      (items.length
        ? '\n\n' +
          table(
            ['Item', 'Receiver', 'Amount', 'Status', 'Error'],
            items.map((i) => [
              i.payout_item_id,
              i.payout_item?.receiver,
              i.payout_item?.amount ? `${i.payout_item.amount.value} ${i.payout_item.amount.currency}` : '',
              statusColor(i.transaction_status),
              i.errors?.name,
            ]),
          )
        : '')
    );
  },
});

const payoutsItem = defineOp({
  name: 'payouts_item',
  command: ['payouts', 'item'],
  summary: 'Show one payout item (status, receiver, errors such as RECEIVER_UNREGISTERED).',
  kind: 'read',
  input: { itemId: z.string().describe('Payout item ID') },
  positional: ['itemId'],
  run: (cfg, { itemId }) => api(cfg, 'GET', `/v1/payments/payouts-item/${encodeURIComponent(itemId)}`),
});

// ---------- explain (rules only; the CLI command adds the AI layer) ----------
const explainOp = defineOp({
  name: 'explain_last_error',
  command: ['explain-rules'],
  summary:
    'Return the last PayPal API error paypal-cli saw (masked) plus rule-based hints: likely cause, fix, ' +
    'dashboard path. Use it after any tool call fails.',
  kind: 'read',
  input: {},
  run: async (cfg) => {
    const last = readLastError();
    if (!last) return { error: null, hints: [] };
    return { error: last, hints: explainRules(last, cfg) };
  },
  render: (d) => (d.error ? renderRules(d.error, d.hints) : 'No saved error yet.'),
});

export const OPS: Op[] = [
  authCheckOp,
  doctorOp,
  webhooksList,
  webhooksId,
  webhooksCreate,
  webhooksDelete,
  eventTypes,
  eventsList,
  eventsShow,
  eventsResend,
  trigger,
  ordersCreate,
  ordersGet,
  ordersCapture,
  payoutsSend,
  payoutsGet,
  payoutsItem,
  explainOp,
];
