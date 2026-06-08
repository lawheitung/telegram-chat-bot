# telegram-claude-bot

A personal Telegram bot on Cloudflare Workers (free plan) that routes each
conversation to a model — or a pair of models — based on its **area**.

## Project layout

```
src/
├── types.ts      # all shared types (Env, ChatMessage, ModelTarget, …)
├── providers.ts  # VENDORS registry + the API implementations
├── router.ts     # the AREAS registry — maps an area to its model(s)
├── bot.ts        # Telegram helpers (markdown→HTML, chunking) + prompt assembly
├── agent.ts      # AgentDO Durable Object — message handler + all stored state (SQLite)
└── index.ts      # webhook entry: commands + ack-fast, routes work to the DO
```

## Vendors + areas

There are only **three API shapes** in the whole codebase — Anthropic, Google, and
OpenAI-compatible — plus the Workers AI binding. Most models you'd ever add reuse one
of these, so adding a model is config, not code.

**Vendors** (`providers.ts`):

| vendor    | kind        | needs            |
|-----------|-------------|------------------|
| anthropic | anthropic   | ANTHROPIC_API_KEY |
| gemini    | google      | GEMINI_API_KEY   |
| workersai | workers-ai  | nothing (env.AI) |

**Areas** (`router.ts`) — set one per Telegram topic with `/model <id>`:

| /model    | text model                    | image model      |
|-----------|-------------------------------|------------------|
| default   | claude-sonnet-4-6             | (same)           |
| think     | claude-opus-4-8 (+thinking)   | —                |
| cv        | claude-sonnet-4-6             | claude-sonnet-4-6 |
| image     | gemini-3.5-flash              | (same)           |
| kimi      | kimi-k2.6 (Workers AI)        | gemini-3.5-flash |
| schedule  | claude-haiku-4-5 (Todoist – tools TBD) | —       |

## Adding or swapping a model

- **Same vendor, different model:** change the `model` string in `router.ts`. Done.
- **New OpenAI-compatible vendor** (xAI/Grok, OpenAI, Kimi-cloud, DeepSeek, OpenRouter…):
  add ONE line to `VENDORS` in `providers.ts`, add its key field to `Env` in `types.ts`,
  then `wrangler secret put <KEY>`. No new API code — they all share one implementation.
  (Commented `xai` / `openai` examples are right there in `VENDORS`.)
- **A genuinely different API shape** (rare): add one `kind` + one function in
  `providers.ts`. That's the only case that needs code.

## Caching

The Claude provider marks the system prompt cacheable (`cache_control: ephemeral`).
It pays off once that prefix is large and reused within ~5 min — i.e. once the memory
document lands there (next milestone).

## Prerequisites

- Node + npm; Cloudflare account (free plan works)
- Telegram bot token (@BotFather); your numeric user ID (@userinfobot)
- Keys only for what you use: Anthropic (most areas), Gemini (image / kimi-photo). Workers AI needs none.

## Setup

```bash
npm install
wrangler login

# State (history, area, soul/agents/memory) lives in the AgentDO's SQLite storage —
# no KV namespace to create. Just set your Telegram user ID:
# wrangler.toml -> [vars] ALLOWED_USER_IDS

wrangler secret put BOT_TOKEN
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GEMINI_API_KEY       # only for gemini areas
wrangler secret put WEBHOOK_SECRET

wrangler deploy
```

Register the webhook once:

```bash
curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  --data-urlencode "url=<WORKER_URL>" \
  --data-urlencode "secret_token=<WEBHOOK_SECRET>"
```

## Usage

- `/help` — list areas + current.
- `/model kimi` — Kimi 2.6 on Workers AI (photos go to Gemini).
- `/model image` — Gemini for vision.
- `/reset` — clear this conversation's memory.

## Caveats

- **Kimi on Workers AI** is a large model on the free `env.AI` binding; heavy use can
  exceed the free daily allocation — watch your Workers AI usage.
- **Free-plan latency:** `ctx.waitUntil` keeps the slow call alive after the ack, but
  multi-minute lifetimes aren't strongly guaranteed on the free plan. If long replies
  drop, move to the Paid plan + a Queue or Durable Object consumer.