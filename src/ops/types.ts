import { z } from 'zod';
import type { Config } from '../config.js';

/**
 * read  – no side effects
 * write – changes PayPal config or sends notifications (webhooks, resend, simulate)
 * money – moves money (capture, payouts). Needs explicit human approval in MCP mode and in live mode.
 */
export type OpKind = 'read' | 'write' | 'money';

export interface Op<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name, e.g. `webhooks_list`. */
  name: string;
  /** CLI path, e.g. ['webhooks', 'list']. */
  command: string[];
  summary: string;
  kind: OpKind;
  input: S;
  /** Inputs passed positionally on the CLI, in order. */
  positional?: (keyof S & string)[];
  run(cfg: Config, input: z.infer<z.ZodObject<S>>): Promise<unknown>;
  /** Human output for the terminal. Defaults to pretty JSON. */
  render?(data: any, input: z.infer<z.ZodObject<S>>): string;
  /** One sentence shown before a money/write op asks for approval. */
  preview?(input: z.infer<z.ZodObject<S>>, cfg: Config): string;
}

export function defineOp<S extends z.ZodRawShape>(op: Op<S>): Op {
  return op as unknown as Op;
}

/** Reconstructs the exact CLI command an op call corresponds to (shown in previews and MCP results). */
export function toCliCommand(op: Op, input: Record<string, unknown>): string {
  const parts = ['paypal-cli', ...op.command];
  for (const key of op.positional ?? []) if (input[key] !== undefined) parts.push(quote(String(input[key])));
  for (const [key, value] of Object.entries(input)) {
    if (op.positional?.includes(key) || value === undefined || key === 'confirm') continue;
    const flag = '--' + key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
    if (value === true) parts.push(flag);
    else if (value === false) continue;
    else if (Array.isArray(value)) parts.push(flag, quote(value.join(',')));
    else parts.push(flag, quote(String(value)));
  }
  return parts.join(' ');
}

function quote(s: string): string {
  return /^[\w@.,:/=+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
