# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # local dev via wrangler dev
npm run deploy     # deploy to Cloudflare Workers
npm run typecheck  # tsc --noEmit (no build step — wrangler handles bundling)
```

Secrets are set once with `wrangler secret put <NAME>` (never in code or wrangler.toml).

## Architecture

A Cloudflare Workers webhook handler that routes Telegram messages to LLM providers. All state lives in a single Durable Object (`AgentDO`) backed by SQLite — there is no KV namespace.

### Request flow

```
Telegram → Worker (index.ts) → fast-ack → ctx.waitUntil → AgentDO.handleMessage()
                ↓ commands handled synchronously in Worker
         AgentDO stub (RPC calls for state reads/writes)
```

### State ownership (AgentDO — src/agent.ts)

The single `idFromName("default")` DO instance owns all bot state. Storage keys:

| Key pattern | Scope | What |
|---|---|---|
| `history:chat:{chatId}` | per chat | conversation history (rolling 25 pairs = 50 msgs) |
| `history:chat:{chatId}:{threadId}` | per thread | same, for Telegram topic threads |
| `area:{sessionKey}` | per thread | selected model area |
| `doc:soul` | global | identity system prompt |
| `doc:agents:{sessionKey}` | per thread | per-agent rules/behavior |
| `doc:memory:{sessionKey}` | per thread | remembered facts |

`loadDoc` includes a one-time lazy migration: if a scoped key is empty and an old global `doc:agents` / `doc:memory` key exists, it promotes it to the scoped key on first read and deletes the old one.

### Adding a model/vendor (src/router.ts + src/providers.ts)

- **Same vendor, different model**: change the `model` string in an `AREAS` entry in `router.ts`.
- **New OpenAI-compatible API**: add one entry to `VENDORS` in `providers.ts`, add its key field to `Env` in `types.ts`, run `wrangler secret put`.
- **New API shape**: add a `kind` + handler function in `providers.ts`.

### Markdown rendering (src/bot.ts)

All outgoing messages go through `mdToTelegramHtml()` which converts CommonMark to Telegram HTML (`<b>`, `<i>`, `<s>`, `<code>`, `<pre>`, `<a>`). Code blocks are extracted first so their contents are never processed as markdown. `sendText` and `editText` send with `parse_mode: "HTML"` and fall back to plain text on failure. Messages are split at 3500 chars (below the 4096 Telegram limit) to leave headroom for tag expansion.

### Prompt caching (src/providers.ts — callAnthropic)

The system block and the last message block both carry `cache_control: {type: "ephemeral"}`. Caching is GA — no beta header required. Hits only occur once the cached prefix reaches ≥ 4096 tokens (Opus/Sonnet), so it pays off once `soul` + `agents` docs are populated.
