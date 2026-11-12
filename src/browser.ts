import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // no browser available: the URL is printed anyway
  }
}

export interface ApprovalWaiter {
  returnUrl: string;
  cancelUrl: string;
  /** Resolves when the buyer is redirected back: approved (with the PayPal token) or cancelled. */
  result: Promise<{ approved: boolean; token?: string; payerId?: string }>;
  close(): void;
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1>${title}</h1><p>${body}</p><p style="color:#666">You can close this tab and go back to the terminal.</p></body>`;

/** A one-shot localhost server that the PayPal approval page redirects back to. */
export async function waitForApproval(timeoutMs = 10 * 60_000): Promise<ApprovalWaiter> {
  let settle!: (v: { approved: boolean; token?: string; payerId?: string }) => void;
  let fail!: (e: Error) => void;
  const result = new Promise<{ approved: boolean; token?: string; payerId?: string }>((res, rej) => {
    settle = res;
    fail = rej;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/return') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Payment approved', 'paypal-cli received the approval.'));
      settle({ approved: true, token: url.searchParams.get('token') ?? undefined, payerId: url.searchParams.get('PayerID') ?? undefined });
    } else if (url.pathname === '/cancel') {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Payment cancelled', 'The buyer cancelled on the PayPal page.'));
      settle({ approved: false, token: url.searchParams.get('token') ?? undefined });
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const timer = setTimeout(() => fail(new Error(`no approval within ${Math.round(timeoutMs / 60000)} minutes`)), timeoutMs);
  const close = () => {
    clearTimeout(timer);
    server.close();
  };
  result.finally(close).catch(() => undefined);
  return {
    returnUrl: `http://127.0.0.1:${port}/return`,
    cancelUrl: `http://127.0.0.1:${port}/cancel`,
    result,
    close,
  };
}
