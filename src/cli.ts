#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { Command, Option } from 'commander';
import { z } from 'zod';
import { ConfigError, loadConfig, type Config, type GlobalOpts } from './config.js';
import {
  formatErrorDetails,
  formatErrorLine,
  PayPalApiError,
  readLastError,
  saveLastError,
  toSaved,
  type SavedError,
} from './errors.js';
import { explainRules, explainWithAI, renderRules } from './explain.js';
import { getToken } from './http.js';
import { maskString, maskValue } from './mask.js';
import { OPS } from './ops/index.js';
import { toCliCommand, type Op } from './ops/types.js';
import { pc } from './output.js';
import { baseType, InputError, kebab, parseInput } from './zodcli.js';

const VERSION = '0.1.0';
const program = new Command();

program
  .name('paypal-cli')
  .description(
    'Unofficial PayPal developer CLI and MCP server. Not affiliated with or endorsed by PayPal.\n' +
      'Sandbox by default. Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET from the environment or .env.',
  )
  .version(VERSION)
  .addOption(new Option('--env <env>', 'sandbox or live (default: PAYPAL_ENV or sandbox)'))
  .option('--env-file <path>', 'read credentials from this file instead of ./.env')
  .option('--json', 'print raw JSON (for scripts and jq)')
  .option('-v, --verbose', 'log HTTP requests to stderr (secrets masked)')
  .option('-y, --yes', 'skip confirmation prompts (live mode)')
  .option('--explain', 'on a PayPal error, explain it right away')
  .showHelpAfterError();

type Globals = GlobalOpts & { explain?: boolean };

function out(cfg: Pick<Config, 'json'>, op: Op | undefined, data: unknown, input: Record<string, unknown>): void {
  if (cfg.json || !op?.render) {
    process.stdout.write(maskString(JSON.stringify(data, null, 2)) + '\n');
  } else {
    process.stdout.write(maskString(op.render(data, input)) + '\n');
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function handleError(err: unknown, globals: Globals): Promise<never> {
  if (err instanceof PayPalApiError) {
    saveLastError(err);
    if (globals.json) {
      process.stdout.write(JSON.stringify({ error: maskValue(toSaved(err)) }, null, 2) + '\n');
    } else {
      process.stderr.write(pc.red('✗ ' + formatErrorLine(err)) + '\n');
      for (const l of formatErrorDetails(err)) process.stderr.write('  ' + maskString(l) + '\n');
      if (globals.explain) {
        process.stderr.write('\n');
        await runExplain(toSaved(err), globals, true);
      } else {
        process.stderr.write(pc.dim('  Run `paypal-cli explain` for the likely cause and fix.') + '\n');
      }
    }
  } else if (err instanceof ConfigError || err instanceof InputError) {
    process.stderr.write(pc.red('✗ ') + err.message + '\n');
  } else {
    process.stderr.write(pc.red('✗ ') + maskString(err instanceof Error ? err.message : String(err)) + '\n');
  }
  process.exit(1);
}

// ---------- commands generated from the operation registry ----------
const groups = new Map<string, Command>();
const groupDescriptions: Record<string, string> = {
  auth: 'Credentials',
  webhooks: 'Webhook endpoints registered on the app',
  events: 'Webhook events PayPal generated (list, inspect, resend)',
  orders: 'Checkout orders (via the official PayPal Server SDK)',
  payouts: 'Payouts to PayPal accounts',
};

for (const op of OPS) {
  if (op.command[0] === 'explain-rules') continue; // MCP-only; the CLI has `explain`
  let parent = program;
  if (op.command.length > 1) {
    const g = op.command[0]!;
    if (!groups.has(g)) groups.set(g, program.command(g).description(groupDescriptions[g] ?? g));
    parent = groups.get(g)!;
  }
  const cmd = parent.command(op.command[op.command.length - 1]!).description(
    op.summary + (op.kind === 'money' ? pc.yellow(' [moves money]') : ''),
  );
  for (const key of op.positional ?? []) {
    const schema = op.input[key] as z.ZodTypeAny;
    cmd.argument(schema.isOptional() ? `[${key}]` : `<${key}>`, schema.description ?? '');
  }
  for (const [key, s] of Object.entries(op.input)) {
    if (op.positional?.includes(key)) continue;
    const schema = s as z.ZodTypeAny;
    const b = baseType(schema);
    const flag = `--${kebab(key)}`;
    const spec = b instanceof z.ZodBoolean ? flag : `${flag} <${b instanceof z.ZodArray ? 'list' : 'value'}>`;
    const o = new Option(spec, schema.description ?? '');
    if (!schema.isOptional()) o.makeOptionMandatory();
    cmd.addOption(o);
  }
  cmd.action(async (...args: unknown[]) => {
    const command = args[args.length - 1] as Command;
    const globals = command.optsWithGlobals() as Globals & Record<string, unknown>;
    try {
      const raw: Record<string, unknown> = { ...command.opts() };
      (op.positional ?? []).forEach((key, i) => (raw[key] = args[i]));
      const input = parseInput(op.input, raw);
      const cfg = loadConfig(globals);
      if (op.kind === 'money' && cfg.env === 'live' && !cfg.yes) {
        const msg = `${pc.red('LIVE')} ${op.preview?.(input as never, cfg) ?? op.name}. Real money. Continue?`;
        if (!(await confirm(msg))) {
          process.stderr.write('Cancelled.\n');
          process.exit(1);
        }
      } else if (op.kind === 'money' && !cfg.json) {
        process.stderr.write(pc.dim(`→ ${op.preview?.(input as never, cfg) ?? op.name} (${cfg.env})`) + '\n');
      }
      const data = await op.run(cfg, input as never);
      out(cfg, op, data, input);
    } catch (err) {
      await handleError(err, globals);
    }
  });
}

// ---------- explain ----------
async function runExplain(saved: SavedError, globals: Globals, fromFailure = false, noAi = false): Promise<void> {
  const cfg = loadConfig(globals, { requireCreds: false });
  const hints = explainRules(saved, cfg);
  if (!fromFailure) process.stdout.write(maskString(renderRules(saved, hints)) + '\n');
  else for (const h of hints) process.stderr.write(`${pc.yellow('cause:')} ${h.cause}\n${pc.cyan('fix:')}   ${h.fix}\n`);

  if (noAi) return;
  if (!cfg.aiProvider) {
    process.stderr.write(
      pc.dim('\nSet ANTHROPIC_API_KEY or GROQ_API_KEY for an AI explanation, or ask your coding agent through `paypal-cli mcp`.') + '\n',
    );
    return;
  }
  let scopes: string[] | undefined;
  if (cfg.clientId && cfg.clientSecret) {
    try {
      scopes = (await getToken(cfg)).scopes;
    } catch {
      /* explanation still works without scopes */
    }
  }
  process.stderr.write(pc.dim(`\nAsking ${cfg.model} (${cfg.aiProvider})…`) + '\n');
  try {
    const text = await explainWithAI(saved, hints, cfg, scopes);
    if (text) process.stdout.write('\n' + pc.bold('AI explanation') + '\n' + maskString(text) + '\n');
  } catch (e) {
    process.stderr.write(pc.yellow('AI explanation unavailable: ') + (e instanceof Error ? e.message : String(e)) + '\n');
  }
}

program
  .command('explain')
  .description('Explain the last PayPal error (or one saved to a file): likely cause, exact fix. Rules first, then an AI model if ANTHROPIC_API_KEY or GROQ_API_KEY is set.')
  .option('--file <path>', 'explain an error payload from a JSON file instead (PayPal error body or `--json` output)')
  .option('--no-ai', 'rule-based hints only')
  .action(async (opts: { file?: string; ai: boolean }, command: Command) => {
    const globals = command.optsWithGlobals() as Globals;
    try {
      let saved: SavedError | undefined;
      if (opts.file) {
        const parsed = JSON.parse(readFileSync(opts.file, 'utf8')) as Record<string, unknown>;
        const body = (parsed.error as Record<string, unknown> | undefined) ?? parsed;
        if ('request' in body && 'status' in body) saved = body as unknown as SavedError;
        else {
          const e = PayPalApiError.fromPayload(Number(body.status ?? 0) || 400, body, { method: '?', path: '?' });
          saved = toSaved(e);
        }
      } else {
        saved = readLastError();
      }
      if (!saved) {
        process.stdout.write('No PayPal error recorded yet. Run a command first, or pass --file.\n');
        return;
      }
      await runExplain(saved, globals, false, !opts.ai);
    } catch (err) {
      await handleError(err, globals);
    }
  });

// ---------- mcp ----------
program
  .command('mcp')
  .description('Run as an MCP server over stdio, so AI coding assistants (Claude Code, Cursor…) can use these tools.')
  .action(async (_opts: unknown, command: Command) => {
    const { startMcp } = await import('./mcp.js');
    await startMcp(command.optsWithGlobals() as Globals);
  });

program.parseAsync(process.argv).catch((err) => handleError(err, program.opts() as Globals));

export { toCliCommand };
