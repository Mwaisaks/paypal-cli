import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import dotenv from 'dotenv';

export type PayPalEnv = 'sandbox' | 'live';

export interface Config {
  clientId: string;
  clientSecret: string;
  env: PayPalEnv;
  webhookId?: string;
  anthropicKey?: string;
  model: string;
  timeoutMs: number;
  verbose: boolean;
  json: boolean;
  yes: boolean;
}

export interface GlobalOpts {
  env?: string;
  envFile?: string;
  verbose?: boolean;
  json?: boolean;
  yes?: boolean;
}

export const BASE_URL: Record<PayPalEnv, string> = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

export const DASHBOARD_URL: Record<PayPalEnv, string> = {
  sandbox: 'https://developer.paypal.com/dashboard/applications/sandbox',
  live: 'https://developer.paypal.com/dashboard/applications/live',
};

export const DEFAULT_MODEL = 'claude-opus-5-5';

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, 'paypal-cli');
}

export class ConfigError extends Error {}

/** Loads credentials from the environment, after reading a .env file (never overriding real env vars). */
export function loadConfig(opts: GlobalOpts = {}, { requireCreds = true } = {}): Config {
  const file = opts.envFile ?? '.env';
  if (existsSync(file)) dotenv.config({ path: file, quiet: true });
  else if (opts.envFile) throw new ConfigError(`env file not found: ${opts.envFile}`);

  const rawEnv = (opts.env ?? process.env.PAYPAL_ENV ?? 'sandbox').toLowerCase();
  if (rawEnv !== 'sandbox' && rawEnv !== 'live') {
    throw new ConfigError(`--env must be "sandbox" or "live" (got "${rawEnv}")`);
  }
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim() ?? '';
  if (requireCreds && (!clientId || !clientSecret)) {
    throw new ConfigError(
      'PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are not set.\n' +
        `  Create a REST app at ${DASHBOARD_URL[rawEnv as PayPalEnv]}\n` +
        '  and put both values in .env (see .env.example) or export them.',
    );
  }
  return {
    clientId,
    clientSecret,
    env: rawEnv,
    webhookId: process.env.PAYPAL_WEBHOOK_ID?.trim() || undefined,
    anthropicKey: process.env.ANTHROPIC_API_KEY?.trim() || undefined,
    model: process.env.PAYPAL_CLI_MODEL?.trim() || DEFAULT_MODEL,
    timeoutMs: Number(process.env.PAYPAL_CLI_TIMEOUT_MS) || 20_000,
    verbose: !!opts.verbose,
    json: !!opts.json,
    yes: !!opts.yes,
  };
}
