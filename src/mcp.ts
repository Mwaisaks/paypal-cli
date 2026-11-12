import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ConfigError, loadConfig, type Config, type GlobalOpts } from './config.js';
import { formatErrorDetails, formatErrorLine, PayPalApiError, saveLastError, toSaved } from './errors.js';
import { explainRules } from './explain.js';
import { maskString } from './mask.js';
import { OPS } from './ops/index.js';
import { toCliCommand, type Op } from './ops/types.js';

/** Inputs that only make sense in an interactive terminal. */
const CLI_ONLY_INPUTS = new Set(['wait', 'capture']);

const text = (s: string) => ({ content: [{ type: 'text' as const, text: maskString(s) }] });

function mcpShape(op: Op): z.ZodRawShape {
  const shape: z.ZodRawShape = {};
  for (const [k, v] of Object.entries(op.input)) if (!CLI_ONLY_INPUTS.has(k)) shape[k] = v;
  if (op.kind === 'money') {
    shape.confirm = z
      .boolean()
      .optional()
      .describe(
        'Leave unset first: the tool returns a preview. Show it to the user, and only after they explicitly approve, call again with confirm=true.',
      );
  }
  return shape;
}

export async function startMcp(globals: GlobalOpts): Promise<void> {
  let cfg: Config | undefined;
  /** Exact money-moving calls this server has already previewed; confirm=true is refused for anything else. */
  const previewed = new Set<string>();
  const getCfg = () => (cfg ??= loadConfig(globals));

  const server = new McpServer(
    { name: 'paypal-cli', version: '0.1.0' },
    {
      instructions:
        'Unofficial PayPal developer tools (sandbox by default): webhooks, webhook events, simulated events, orders, payouts, ' +
        'app diagnostics. Tools marked as moving money return a preview first; show it to the user and only call again with ' +
        'confirm=true after they approve. After any failed call, use explain_last_error and fix the cause before retrying.',
    },
  );

  for (const op of OPS) {
    server.registerTool(
      op.name,
      {
        title: op.command.join(' '),
        description:
          op.summary +
          (op.kind === 'money' ? ' MOVES MONEY: requires a preview and explicit user approval (confirm=true).' : '') +
          ` CLI equivalent: paypal-cli ${op.command.join(' ')}.`,
        inputSchema: mcpShape(op),
        annotations: {
          readOnlyHint: op.kind === 'read',
          destructiveHint: op.kind !== 'read',
          idempotentHint: op.kind === 'read',
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const c = getCfg();
          const { confirm, ...input } = args;
          const command = toCliCommand(op, input);
          if (op.kind === 'money') {
            if (c.env === 'live') {
              return { ...text('Refused: paypal-cli does not move live money through MCP. Run the command in a terminal.'), isError: true };
            }
            const key = `${op.name} ${command}`;
            if (confirm !== true || !previewed.has(key)) {
              previewed.add(key);
              return text(
                `APPROVAL REQUIRED (${c.env}): ${op.preview?.(input as never, c) ?? op.name}.\n` +
                  `Equivalent command: ${command}\n` +
                  'Ask the user to approve this exact action. Only if they say yes, call this tool again with the same arguments and confirm=true.',
              );
            }
            previewed.delete(key); // one approval, one execution
          }
          const data = await op.run(c, input as never);
          return text(`${command}\n\n${JSON.stringify(data, null, 2)}`);
        } catch (err) {
          if (err instanceof PayPalApiError) {
            saveLastError(err);
            const hints = explainRules(toSaved(err), getCfg());
            return {
              ...text(
                [formatErrorLine(err), ...formatErrorDetails(err), '', ...hints.map((h) => `cause: ${h.cause}\nfix: ${h.fix}`)].join('\n'),
              ),
              isError: true,
            };
          }
          const msg = err instanceof ConfigError ? err.message : err instanceof Error ? err.message : String(err);
          return { ...text(msg), isError: true };
        }
      },
    );
  }

  await server.connect(new StdioServerTransport());
  process.stderr.write('paypal-cli MCP server running on stdio\n');
}
