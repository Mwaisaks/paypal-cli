# paypal-cli

> **Unofficial.** Not affiliated with, endorsed by or supported by PayPal. "PayPal" is a trademark of PayPal, Inc.
> Sandbox by default.

A command-line tool and MCP server for PayPal developers. It covers the jobs that usually send you to the
developer dashboard or into a throwaway script:

- **Webhooks:** list, create, delete, and print the ID for a URL.
- **Webhook events:** list, show and resend.
- **Simulated events:** send them with `trigger`.
- **Orders:** create, approve and capture.
- **Payouts:** send, then check batch and item status.
- **`doctor`:** checks the app's credentials, enabled features and webhook setup.
- **`explain`:** turns a PayPal error into its likely cause and an exact fix. It uses built-in rules first,
  then an AI model (Groq or Claude).
- **`mcp`:** exposes every operation to AI coding assistants as MCP tools. Money-moving tools need
  explicit human approval.

```
$ paypal-cli orders capture 238589717H366752P
→ Capture payment for order 238589717H366752P (sandbox)
✗ 422 UNPROCESSABLE_ENTITY/ORDER_NOT_APPROVED (debug_id f998238caff6d) POST /v2/checkout/orders/238589717H366752P/capture
  - ORDER_NOT_APPROVED: Payer has not yet approved the Order for payment. …
  Run `paypal-cli explain` for the likely cause and fix.

$ paypal-cli explain
cause: The buyer has not approved the order yet.
fix:   Open the order's approve link, log in as a sandbox *personal* account and approve, then capture.
       `paypal-cli orders create --wait --capture` does all of it.
```

## Why

PayPal has no maintained general-purpose CLI. The old official one was a payments-only developer preview, and
it is no longer maintained. The [PayPal Agent Toolkit](https://github.com/paypal/AI-Toolkit) gives AI agents
orders, invoices, subscriptions, disputes and reporting tools. It does **not** cover webhooks, webhook events,
simulated events or payouts, and it has no interface for a person at a terminal.

This tool came out of a real hackathon build. During that build we kept leaving the IDE to:

- copy a webhook ID out of the dashboard,
- check "Webhooks Events" for delivery status,
- guess whether Payouts was enabled on the app,
- work out why a rotated secret still returned 200,
- or decode a `NOT_AUTHORIZED` that hid a missing dashboard checkbox.

`paypal-cli` handles each of those from the terminal, and gives an AI assistant the same tools through MCP.
It complements the official Agent Toolkit rather than replacing it.

## Quick start (about 5 minutes)

You need Node.js 22+ and a free PayPal developer account.

1. **Create a sandbox REST app.**
   - Go to <https://developer.paypal.com/dashboard/applications/sandbox> and choose *Create App* (type:
     Merchant).
   - Under *Features*, tick **Payouts**.
   - Copy the client ID and secret.
2. **Install:**

   ```bash
   git clone https://github.com/Mwaisaks/paypal-cli && cd paypal-cli
   npm install          # also builds dist/
   npm link             # puts `paypal-cli` on your PATH (or use: node dist/cli.js …)
   cp .env.example .env # then paste PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET
   ```

3. **Check the setup:**

   ```bash
   paypal-cli doctor
   ```

   If `doctor` reports that the credentials belong to live rather than sandbox, run commands with
   `--env live`.

### Try it

```bash
# 1. Checkout. Opens the PayPal approval page.
#    Log in as your sandbox *personal* account (Dashboard → Sandbox → Accounts → View/Edit for its password).
#    The CLI waits for the approval, then captures.
paypal-cli orders create --amount 25 --description "Workshop ticket" --wait --capture

# 2. Webhooks. PayPal needs a public https URL; https://webhook.site gives you one for free.
paypal-cli webhooks create --url https://webhook.site/<your-id> --events "*"
paypal-cli webhooks list
paypal-cli trigger PAYMENT.CAPTURE.COMPLETED --webhook-id <id>    # watch it arrive on webhook.site
paypal-cli events list --since 1h                                 # real events from step 1
paypal-cli events show <WH-…>  &&  paypal-cli events resend <WH-…>

# 3. Payouts (sandbox money). Use a sandbox personal account's email.
paypal-cli payouts send --to sb-xxxx@personal.example.com --amount 10
paypal-cli payouts get <batch-id>

# 4. Errors
paypal-cli orders capture NOT-A-REAL-ID ; paypal-cli explain
```

Every command takes these flags:

| Flag | Effect |
|---|---|
| `--json` | Raw JSON for scripts and `jq` |
| `-v` | Logs each HTTP request. Secrets are always masked |
| `--env live` | Uses live credentials |
| `--env-file other.env` | Switches between apps |
| `--explain` | Explains a PayPal error as soon as it happens |

## AI features

### `paypal-cli explain`: from error payload to fix

Every PayPal error is printed as one line: `status NAME/ISSUE (debug_id …) METHOD path`. The full error is also
saved (masked, mode 0600) to `~/.config/paypal-cli/last-error.json`.

`paypal-cli explain` then works in two steps:

1. **Built-in rules (offline, no key).** These cover the common failures:
   - wrong environment or credentials
   - a missing app feature behind a 403, named exactly
   - an order the buyer hasn't approved
   - insufficient funds
   - an unregistered payout receiver
   - webhook URL problems
   - duplicate request IDs
2. **An AI model (if `GROQ_API_KEY` or `ANTHROPIC_API_KEY` is set).** The model receives:
   - the masked request and error payload
   - the rule hints
   - the app's granted OAuth scopes

   It returns a cause and numbered fix steps written for this specific request: dashboard paths, field names
   and `paypal-cli` commands.
   - **Groq** (free tier, <https://console.groq.com/keys>) uses `openai/gpt-oss-120b` by default.
   - **Claude** uses `claude-opus-5-5` by default, and is preferred when both keys are set.
   - Force one with `PAYPAL_CLI_AI_PROVIDER=groq|anthropic`. Change the model with `PAYPAL_CLI_MODEL`.
   - The model may only suggest `paypal-cli` commands that exist, and the error is masked before it is sent.

### `paypal-cli mcp`: the same tools for your coding assistant

Each operation is registered as an MCP tool with a typed input schema (the same zod schema the CLI uses).
Tools also carry these annotations:

- `readOnlyHint` on tools that only read.
- `destructiveHint` on tools that change things.
- **Money-moving tools** (`orders_capture`, `payouts_send`) are gated twice.
  1. The first call only returns a preview and the exact equivalent command.
  2. The assistant must show that preview to you and call again with `confirm: true` after you approve.
- Live-mode money movement is refused over MCP entirely.

To add it to Claude Code:

```bash
claude mcp add paypal-cli -- paypal-cli mcp --env-file /absolute/path/to/paypal-cli/.env
```

Then ask, for example:
- "Which webhook events failed delivery in the last hour? Resend them."
- "Send a $5 test payout to my sandbox buyer."

No AI key ships with this tool. In MCP mode, your own assistant does the reasoning.

## How it's built

| Layer | Choice |
|---|---|
| Orders | **The official PayPal Server SDK** (`@paypal/paypal-server-sdk`, generated by **APIMatic**) |
| Payouts, Webhooks, Events, Simulate | A small hand-written `fetch` client. The SDK doesn't cover these APIs |
| Shared operation registry | **zod**. Each operation becomes a **commander** CLI command and an MCP tool |
| AI | Groq's OpenAI-compatible API or `@anthropic-ai/sdk` for `explain`, and `@modelcontextprotocol/sdk` for MCP |

Safety defaults:

- **Timeouts.** Every request has one. This includes the SDK, whose default is to wait forever.
- **Retries.** Only idempotent GETs are retried.
- **Idempotency.** Every POST carries a `PayPal-Request-Id`, which you can set with `--request-id`.
- **Secrets** never reach stdout, logs or the saved error file. A unit test checks this.

**Tools used to build it:** Claude Code (CLI) and the APIMatic Context Plugin for PayPal, which supplied
PayPal SDK context to the coding agent. At runtime, `explain` calls Groq (`openai/gpt-oss-120b`) or Claude, whichever key is set.

## Known limits

- **Simulated events** (`trigger`) contain mock data. By PayPal's design they:
  - fail `verify-webhook-signature`,
  - don't appear in `events list`,
  - and can't be resent.

  Use a real sandbox event to test signature verification.
- **Real events** take a few minutes to show up in `events list` after the action that caused them.
  The sandbox doesn't return per-delivery attempts on an event.
- **Sandbox accounts** can only be created in the dashboard. PayPal has no public API for this.
- **Roadmap:**
  - `listen`: a tunnel plus a temporary webhook that forwards events to localhost
  - `webhooks verify`
  - refunds
  - balance

## Development

```bash
npm run dev -- doctor   # run from source with tsx
npm test                # vitest
npm run typecheck
```

## License

MIT
