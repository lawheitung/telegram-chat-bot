# LEARNINGS — Telegram ⇄ multi-model assistant bot

Architecture, design decisions, and hard-won technical learnings from building a
personal Telegram assistant on Cloudflare Workers that routes messages to multiple
LLM vendors (Anthropic, Google Gemini, Workers AI) and executes real tools (Todoist,
Housework). Written so future-me doesn't re-learn these the hard way.

The companion `todoist-mcp/LEARNINGS.md` covers the MCP server + the model-selection
framework. This file covers the **bot** itself.

---

## 1. The system, end to end

```
Telegram (webhook: message updates only)
   │
   ▼
Worker  (src/index.ts)  ── fast-acks Telegram, handles slash-commands synchronously
   │  ctx.waitUntil(...)         (no Queue on the free plan → do slow work after ack)
   ▼
AgentDO (src/agent.ts)  ── single Durable Object, SQLite-backed, owns ALL state
   │  handleMessage()
   ▼
generate() (src/providers.ts)  ── dispatch by vendor
   ├─ Anthropic  (HTTP, prompt caching, adaptive thinking + effort)
   ├─ Gemini     (HTTP, thinkingLevel)            ← the "eyes" for images
   └─ Workers AI (env.AI binding; Kimi / Nemotron) ── tool-calling loop
                        │
                        ▼  RPC via Service Bindings (no HTTP, no auth, 1 billed req)
              todoist-mcp (TodoistRpc) · housework-tracker (HouseworkRpc)
```

Everything is on Cloudflare's **free tier**, and the constraints of that tier shaped
the architecture (see §13).

---

## 2. State architecture — one Durable Object owns everything

There is **no KV, no D1**. A single Durable Object instance (`idFromName("default")`)
holds all bot state in its own SQLite storage. The Worker reaches it over RPC.

### Why one DO
- Telegram is single-user (allow-listed), low-traffic → no need to shard.
- DO SQLite is free on the free plan and gives transactional, colocated state.
- One place to reason about all reads/writes; no cross-store consistency problems.

### Storage keys

| Key | Scope | Holds |
|---|---|---|
| `history:{sessionKey}` | per conversation | rolling 25 user/assistant pairs |
| `area:{sessionKey}` | per conversation | selected model area id |
| `effort:{sessionKey}` | per conversation | reasoning level override (low…max) |
| `doc:{name}` | global | `soul`, `user`, `tools` |
| `doc:{name}:{sessionKey}` | per conversation | `agents`, `memory`, `heartbeat`, `local_tools` |
| `agent:name:{threadKey}` | per thread | the named-agent label assigned to a thread |
| `agent:location:{name}` | per name | `chatId:threadId` (for inter-agent handoff) |

### sessionKey & named agents — the key indirection
- Raw key: `chat:{chatId}` or `chat:{chatId}:{threadId}` (Telegram topics = threads).
- `/agent set <name>` maps a thread → a name; `resolveSessionKey()` then returns
  **`agent:{name}`** as the effective key.
- **Consequence:** all config (area, docs, history) is stored under the *agent name*,
  not the thread id — so it **survives deleting/recreating the Telegram topic**. The
  thread is just a window onto a named agent.
- `agentExists(name)` scans `agent:name:*` values (don't use the location table as an
  existence proxy — location is only written when chatId is passed).

### Doc migration quirk
`loadDoc` lazily promotes an old global `doc:agents`/`doc:memory` to the scoped key on
first read (one-time migration from when those were global).

---

## 3. Request flow — fast-ack + waitUntil

The free plan has **no Queues**, and Telegram will retry a webhook if you don't answer
fast. So:

1. Worker validates the secret header + allow-listed user id.
2. **Slash commands** are handled synchronously in the Worker (cheap state reads/writes
   via RPC) and return immediately. No model call.
3. **Normal messages**: send a "🤔 Thinking…" placeholder, then
   `ctx.waitUntil(stub.handleMessage(...))` and **return `"ok"` right away**. The slow
   LLM/tool work runs after the HTTP response. `sendReply` later edits the placeholder.

This "ack first, work after" is the single most important free-plan workaround.

---

## 4. The provider/vendor layer (src/providers.ts)

`VENDORS` maps a vendor key → `{ kind, baseURL?, keyEnv? }`. `generate(input, env)`
dispatches on `kind`:

- **anthropic** → `callAnthropic` — prompt caching (`cache_control` on system + last
  message), adaptive thinking, `output_config.effort`.
- **google** → `callGemini` — `generationConfig.thinkingConfig.thinkingLevel`.
- **openai** → `callOpenAICompatible` — for any OpenAI-shaped API (none active now;
  one-line to add xAI/OpenAI/DeepSeek).
- **workers-ai** → `callWorkersAI` / `callWorkersAIWithTools` — the `env.AI` binding.

**Design intent:** adding a same-shape vendor is a one-line `VENDORS` entry + a secret;
only a genuinely new wire format needs a new `kind` + handler.

---

## 5. Areas, models, and reasoning levels (src/router.ts)

An **area** = a named bundle of `{ system prompt, model target(s), reasoning levels }`.
`AREAS` is model-named now: `sonnet`, `opus`, `gemini`, `kimi`, `admin`, + hidden `do`.

### `/model <name> [level]`
- Picks the area, and optionally a **reasoning level** stored separately
  (`effort:{key}`) so `/model sonnet` and `/model sonnet high` compose.
- `areaList()` renders a model menu with levels in brackets and filters `hidden` areas.

### Reasoning level = one knob, translated per vendor
The big realization: **"thinking" isn't a separate toggle from "level" — the level IS
the thinking dial.** One value, mapped per vendor in the provider layer:

| Level | Anthropic (`output_config.effort`) | Gemini (`thinkingConfig.thinkingLevel`) |
|---|---|---|
| `low` | thinking **off** + effort low (fast chat) | `low` |
| `medium`/`high`/(`xhigh`)/`max` | adaptive thinking on + that effort | `medium`/`high` (xhigh/max → high) |

- `low` ⇒ no extended thinking; `medium`+ ⇒ adaptive thinking on.
- Effort is **never sent to Haiku** (it errors) — Haiku is only used internally for
  memory extraction, which sets no effort.
- **Opus 4.7/4.8 removed `budget_tokens`** — the old `thinking:{type:"enabled",
  budget_tokens}` returns a **400**. Use `thinking:{type:"adaptive"}`. (This silently
  broke the old `think` area until fixed.)
- We deliberately **do not display** the thinking summary — it just chopped the message
  up with no value. (`display:"omitted"`, no rendering of `thinking` blocks.)

### `AreaConfig` flags worth knowing
- `image?` — per-area model override when an image is attached (mostly superseded by
  the global vision pipeline, see §7).
- `hidden?` — keep out of the `/model` menu (internal executors like `do`).
- `stateless?` — skip history + docs + memory + saveTurn; treat each call as one-shot.

---

## 6. Threads → agents → personas (the mental model)

The clean decomposition we converged on:

- **Tool** = a callable function (code + service binding). The unit of *doing*.
- **Skill / persona instructions** = how an agent thinks (lives in the per-thread
  `agents` doc today; a formal skill library is deferred — YAGNI for a personal bot).
- **Agent** = a persistent actor: model + identity/memory + a thread. The unit of *who*.
- **Executor** = a *tools layer*, NOT a persona. You don't chat with it; it acts.

Key insight that took a while: **the "scheduler" was never a persona — it's the tools
layer.** That reframed it from "a chat thread you `/send` to" into "backend
infrastructure any agent invokes" (the `/do` command + the hidden `do` executor).

---

## 7. The vision pipeline — Gemini eyes, Claude brain (TWO turns)

Goal: use **Gemini for image analysis** (its vision), but **Claude for reasoning** —
and have the *analysis goal differ per thread* (posture vs. sewing vs. …).

### The design that works (and why)
The goal lives in the **thread's persona** (`agents` doc), not in a generic command.
And the flow is **two separate turns**, bridged by history:

```
Turn 1 — image:  Gemini analyzes the photo, framed by the thread's goal
                 ("observe, don't advise"); its analysis is the REPLY you see,
                 and is saved as the assistant turn in history.
Turn 2 — text:   you reply with intent ("give me exercises for the rounded
                 shoulders"); the thread's own model (Claude) reasons over
                 history (which now contains the analysis) + your prompt.
```

### Why two turns, not an auto-pipeline
The first version chained Gemini→Claude **inside one turn** (stuffing the analysis into
`userText`). Wrong, because **Claude got the analysis with no user prompt** — pointless;
it didn't know what you wanted done. The two-turn version lets you *see* the analysis and
*direct* the planning.

### How Claude "ingests" the analysis (no magic)
LLM APIs are stateless — the bot **replays the whole thread history every call**.
Gemini's analysis is just the previous assistant message. On the text turn,
`callAnthropic` builds `messages = [...history, newUserMessage]`, so Claude sees:
```
system:    <thread persona>
user:      (image)
assistant: <Gemini's analysis>     ← read as its own prior turn
user:      <your prompt>
```

### Implementation (src/agent.ts handleMessage)
- Build `system` (persona) + `history` first.
- `if (image)` → one `generate()` call to **Gemini** with a vision-analyst system that
  wraps the thread's persona ("describe what's relevant for this task; observe only").
- `else` → one `generate()` to the **thread's model**.
- One model call per turn; `saveTurn` persists the reply; history does the bridging.

**Cost/caching note:** this doesn't hurt Anthropic caching — the cached prefix is the
(unchanged) system prompt. It's often *cheaper* on Opus (offload pixels to cheap Gemini
flash, feed Opus text) and keeps heavy image blocks out of the cached history.

---

## 8. Tool calling & the executor — the biggest saga

### Cost-tiered split (from todoist-mcp/LEARNINGS §model-selection)
**Planning is rare/hard/short-context; execution is frequent/easy/fat-context.** So:
smart model plans (Opus, no tools), cheap model executes (Workers AI, tools, stateless).
Critically — **don't attach tools to your Opus thread as a skill**, or Opus runs the
(expensive, many-round-trip) tool loop. Tools belong to a separate cheap executor.

### Only Workers AI has a tool loop
`callWorkersAIWithTools` is the only tool-calling loop. **We deliberately never built an
Anthropic/Gemini tool loop** — because Opus only *plans* (emits a text plan); the cheap
executor *applies* it. That whole "all-vendors tool loop" project stayed cancelled.

### Areas with tools
- `admin` (foreground tool chat) → **Nemotron**.
- `do` (hidden, stateless, `/do` backend) → **Nemotron**.
- (Both run Nemotron now; the global `detailed thinking off` injection is model-name
  based, so it covers any Nemotron area. Kimi is also a proven fallback — it tool-calls
  with `chat_template_kwargs:{thinking:false}` — and still backs the `kimi` chat area.)
- Both share `EXECUTOR_SYSTEM` and `useTodoist:true` (which loads **both** Todoist *and*
  Housework tools — they're bundled on that one flag; "housework rides on useTodoist").

### ⚠️ THE Nemotron learning (measured via `wrangler tail`, not assumed)
`@cf/nvidia/nemotron-3-120b-a12b` returned **`tool_calls: []` every time** — it answered
in chat and *reasoned its way out of* calling tools. Root cause, from NVIDIA's docs:
**Nemotron only tool-calls reliably with "detailed thinking OFF"**, toggled by the
literal phrase **`detailed thinking off` in the system prompt**. In thinking-on (default)
it reasons instead of acting. Fix in `callWorkersAIWithTools`: prepend
`detailed thinking off\n\n` to the system when the model name contains "nemotron".
With that, it correctly built a full nested project (project → subtasks → sub-subtasks).

This closed the todoist-mcp gap *"tool-calling reliability is asserted, not measured."*
It was asserted; it was wrong; only a `tail` log proved it.

### Other tool-loop facts
- **Kimi** tool-calls without that, but pass `chat_template_kwargs:{thinking:false}` so
  its default reasoning doesn't eat the whole token budget and return empty.
- `MAX_TOOL_STEPS = 25` (was 6). `/do` applies a whole plan — one `add_task` per step,
  so a real decomposition is 10–15+ steps. 6 was sized for one-off "add a task."
- Response parsing handles both shapes: `out.tool_calls` (native) and
  `out.choices[0].message.tool_calls` (OpenAI). `arguments` may be a JSON string or
  object — parse defensively.
- `sanitizeSchema` flattens union `type:["string","null"]` (Workers AI's validator
  rejects them).
- **Idempotency gap:** re-running `/do` on the same plan **duplicates** tasks. The step
  cap bounds blast radius; no request-ids yet.

### Tool access is per-AREA, not per-agent
An agent gets tools by being on a tools-area (`admin`/`do`). There's no per-tool
permission and no Todoist-only vs Housework-only split — both come together via
`useTodoist`. Finer control would be the deferred tool-registry refactor.

---

## 9. Action commands & inter-agent handoff

### `/do` — execute to Todoist
Runs the thread's last assistant message (a plan) — or an inline instruction — through
the **stateless `do` executor** (Nemotron + tools); reply comes back in-thread. Routed
via `handleMessage`'s `areaOverride` field.

### Generic action framework (ACTIONS table, src/index.ts)
```js
const ACTIONS = { "/do": { area: "do", fallbackLast: true, emptyMsg: ... } };
```
A command maps to an area + reply-here, without changing the thread's model. Adding a
new one-shot action = one line. (We tried `/image` here but removed it — image analysis
belongs in the automatic vision pipeline, not a command, see §7.)

### `/send <name>` — persona-to-persona handoff
Routes the thread's last assistant message to *another named agent's* session (its own
model/docs/history); reply comes back here. `/do` superseded its original use
(planner→scheduler); `/send` now only earns its place for cross-*persona* handoff.

---

## 10. Prompt caching (Anthropic only)

`callAnthropic` puts `cache_control:{type:"ephemeral"}` on the **system block** and the
**last message**. Caching is a **prefix match** — the stable system prompt
(soul+persona+memory) is the cached part; repeat turns reuse it at ~10% input price.

- Minimum cacheable prefix: ~4096 tokens (Opus/Haiku) / ~2048 (Sonnet) — so it only pays
  off once the persona/memory docs are populated.
- **Workers AI (Kimi/Nemotron) is free** → nothing to cache for cost, no cache API.
- **Gemini vision is unique per image** → no reusable prefix → caching wouldn't help.
- So the only place caching matters is Claude, and it's done. The vision pipeline keeps
  it intact (system prefix unchanged; image never enters Claude's history).

---

## 11. The editable-docs system (src/bot.ts buildSystem)

The system prompt is assembled from layered docs, in this order:
```
soul → user profile → agents (how you behave) → tools → local_tools
     → area system → heartbeat → memory
```
- Global: `soul`, `user`, `tools`. Per-thread: `agents`, `memory`, `heartbeat`,
  `local_tools`.
- Editable in chat (`/soul`, `/agents`, `/remember`, `/memory`, `/forget`) or via the
  **mini app** (`/edit` → Telegram WebApp, HMAC-authed, served from `GET /`).
- `/compact` extracts key facts from history into `memory` via Haiku; auto-compact runs
  silently when history overflows 25 pairs (extract-then-drop).
- **A persona is just its `agents` doc.** That's why we didn't build a skill system —
  for a personal bot, "give an agent a skill" = write its `agents` doc.

---

## 12. Markdown → Telegram HTML (src/bot.ts)

Models reply in CommonMark; Telegram needs a `parse_mode`. We convert to Telegram's HTML
subset (`<b><i><s><code><pre><a>`):
- **Code blocks are extracted first** so their contents are never processed as markdown.
- `**bold**` (double-asterisk) → `<b>`; single `*italic*` → `<i>` (so headers in help
  text must use `**`).
- `_italic_` regex excludes newlines → multi-line `_…_` won't italicize (why we don't
  wrap long reasoning in `_…_`).
- **Tables** → aligned **monospace `<pre>`** (Telegram has no `<table>`), converted
  before escaping so the pipes survive.
- **Splitting is block-aware** — `splitMessage` groups text into atomic blocks and never
  cuts through a fenced code block or a markdown table (a split table wouldn't render).
  Chunks pack up to ~3500 chars; first chunk edits the placeholder, rest are follow-ups.
- **Image-analysis cutoff** was the Gemini vision call's `maxTokens` being too low (2048) —
  flash *thinks by default* and thinking counts against `maxOutputTokens`. Fixed by raising
  the ceiling to 8192 (a ceiling, not a target — headroom is free).
- `sendText`/`editText` fall back to plain text if Telegram rejects the HTML.

---

## 13. How the free tiers shaped the design

- **No Queues** → fast-ack + `ctx.waitUntil` (§3).
- **DO SQLite is free** → all state in one DO, no KV/D1.
- **Workers AI models are free** → run *execution* there (the frequent, fat-context,
  low-intelligence work); reserve paid Claude for *planning/reasoning*.
- **Gemini flash is cheap** → use it as the vision pre-processor, not the reasoner.

Throughline: **let the constraints pick the architecture.** Two-tier planner/executor,
Gemini-as-eyes, ack-then-work — each is a constraint turned into a design.

---

## 14. Model-specific gotchas (consolidated)

| Symptom | Cause | Fix |
|---|---|---|
| `/model think` → 400 | Opus 4.7/4.8 removed `budget_tokens` | `thinking:{type:"adaptive"}` + `output_config.effort` |
| effort param 400s | Haiku/Sonnet-4.5 don't support `effort` | only send effort on Sonnet 4.6 / Opus |
| Nemotron `tool_calls:[]` always | thinking-on → reasons instead of calling | prepend `detailed thinking off` to system |
| Kimi returns empty | reasoning ate the token budget | `chat_template_kwargs:{thinking:false}` |
| `/do` "too many tool steps" | plan needs > MAX_TOOL_STEPS add_tasks | raise the cap (now 25) |
| Workers AI `8001: Invalid input` | wrong tool/param format for the model | OpenAI-schema: `{type:"function",function:{…}}`, `max_completion_tokens`, `tool_choice` |
| image analysis ignores thread goal | generic vision prompt | wrap the thread's persona into the vision system |
| Gemini area errors with no key | `GEMINI_API_KEY` not set | `wrangler secret put GEMINI_API_KEY` (it's a separate paid Google API) |

---

## 15. Debugging methodology (the meta-lesson)

The Nemotron saga burned several deploy+test cycles guessing. What actually worked:

1. **`wrangler tail` + targeted `console.log` is the truth.** We added `[dbg]`,
   `[tool-loop]`, `[tool-result]`, `[raw-out]` logs and *saw* `tool_calls:[]` — which
   ended the guessing instantly. Then removed them once solved.
2. **Measure, don't assert.** "It seemed ok" meant the area switched, not that a tool
   fired. The first real `get_tasks` ran through the whole chain; isolate layers.
3. **The bot's tail won't show the MCP worker's logs** — service-binding RPC calls are a
   *separate* worker. Log the tool *result* in the bot to see what the RPC returned.
4. **One diagnostic log beats three guess-and-deploy cycles.** When an error is opaque,
   add the log first.

---

## 16. Open gaps / future work

- **`/do` idempotency** — duplicates tasks on re-run; add client request-ids or a
  "already applied?" guard.
- **Destructive ops** — `delete_task` exposed to the executor with no confirmation.
- **Tool granularity** — Todoist + Housework are bundled on `useTodoist`; a tool-registry
  (`tools:["todoist"]` per area) would allow per-area/per-tool selection.
- **Heartbeat / cron** — `heartbeat` doc + storage exist; no cron driving daily briefings
  yet (the free-tier reminder replacement).
- **Skill library** — deferred; personas live in `agents` docs. Revisit only if reuse
  across many agents becomes real (e.g. installing something like the Satori companion).
- **No tests / evals** — both workers are type-checked only; a tool-choice eval fixture
  would guard the executor when the model changes.
- **Vision history weight** — Gemini's full analysis is saved as an assistant turn; over
  long threads that adds up (mitigated by the 25-pair cap + Anthropic caching).

---

## 17. Command reference (current)

| Command | What |
|---|---|
| `/start`, `/help` | setup walkthrough (thread → name → model → behavior → memory → tools → handoff) |
| `/model <name> [level]` | set model area + reasoning level (low…max) |
| `/agent set|unset|list` | name a thread (config survives topic deletion) |
| `/soul`, `/agents` | identity (global) / behavior (per-thread); the persona |
| `/remember`, `/memory`, `/forget`, `/compact` | memory ops |
| `/do [instruction]` | execute to Todoist via the cheap stateless executor |
| `/send <name>` | hand the last reply to another named agent |
| `/edit` | open the mini-app editor |

Images need no command — drop a photo and Gemini analyzes it through the thread's goal;
reply with text and the thread's model takes over.

---
---

# PART II — Session 2 (multi-vendor, scoped tools, GitHub trackers, DO-backed health memory)

Everything below was built after Part I and **supersedes Part I where they conflict** (noted
per section). Part I's concepts still hold; the specifics here are newer.

## 18. OpenAI added — now four vendors

`VENDORS` gained `openai` (`callOpenAICompatible`, already existed). Key detail: GPT-5.x are
reasoning models, so the vendor entry sets **`tokenParam: "max_completion_tokens"`** (not
`max_tokens`). Areas: `gpt` (`gpt-5.5`, flagship) and `gpt-mini` (`gpt-5.4-mini`, cheap — good
for high-volume image testing). Needs `OPENAI_API_KEY` secret. All four vendors now: Anthropic,
Gemini, OpenAI, Workers AI.

## 19. Vision pipeline — CHANGED (supersedes §7)

§7 described a two-turn "Gemini eyes → Claude brain" pipeline. **That is currently disabled
(commented out in `agent.ts`).** Now: **an attached image goes straight to the thread's OWN
model** (Sonnet/GPT/Gemini all have vision) via `resolveTarget(area, hasImage)` + passing the
image to `generate()`. Reason: the user wanted to test whether Claude/GPT vision is good enough
on its own vs. routing through Gemini. The Gemini-eyes branch is preserved in a comment block —
flip back by restoring it.

**Cutoff bug fixed:** the old Gemini vision call capped at `maxTokens: 2048` truncated long
analyses — because **Gemini flash thinks by default and thinking counts against
`maxOutputTokens`**. Raised to 8192. Lesson (reinforces §5): a reasoning model's hidden thinking
eats the *output* budget; `maxTokens` is a *ceiling, not a target* (billed per token generated),
so headroom is free — give it.

## 20. Telegram tables + safe splitting (extends §12)

- **Telegram has no `<table>` tag.** Markdown tables are converted to **aligned monospace
  `<pre>`** (pad columns, render in a code block), done *before* HTML-escaping so the pipes
  survive.
- **2-column tables look bad** as monospace (sparse). For narrow data, prompt the model for a
  trend list / cards instead of a table.
- **`splitMessage` is now block-aware** — it groups text into atomic blocks and **never cuts
  through a fenced code block or a markdown table** (a split table won't render at all); only a
  single oversized block is hard-split.
- **Placeholder leak bug:** the old ` B0 ` space-delimited placeholders for extracted
  code/tables **leaked as literal "B0"/"B1"** when the surrounding whitespace didn't match the
  restore regex. Fixed with **private-use sentinel chars** (`String.fromCharCode(0xE000/0xE001)`).
- **Tooling lesson:** invisible/odd Unicode in source silently breaks the Edit tool's exact
  match. Keep source ASCII; build sentinels via `fromCharCode`, not literal glyphs.

## 21. Per-area tool scoping (supersedes §8's "bundled on `useTodoist`")

`ModelTarget.useTodoist: boolean` is gone — replaced by **`tools: string[]`**. `providers.ts`
has a **`TOOL_BUNDLES` registry**: `todoist`, `housework`, `posture`, `workout`. Each executor
area requests only the bundles it needs, and the tool loop builds the tool list + dispatches
from those bundles only.

**Why:** small models *mis-route* when given everything — a posture `/log` could fire
`add_task` and create a Todoist task. Scoping removes the wrong tools from the table entirely, so
mis-routing is impossible. This is the deferred "tool-registry refactor" from Part I, now done.

## 22. GitHub trackers — repo, paths, columns (extends §8/§16)

- **Dedicated repo `tg_bot_memories`** (was `personalnotes`). Separated from the user's Obsidian
  vault so the bot's auto-commits don't collide with hand edits (the `rejected (fetch first)`
  push error = two writers on one repo). **Rule: one repo, one writer.**
- **Paths flattened to root:** `Posture/Summary.md`, `Posture/weekly/<date>.md`,
  (`Health/CycleLog.md` — now abandoned, see §23).
- **Posture log columns:** added **Diagnosis** + **Top focus** (free-text, pipe-sanitized via the
  `cell()` helper). The `/log` executor extracts them; the gym `/persona` ends its analysis with
  labeled `Diagnosis:` / `Top focus:` lines so the executor has clean text to pull.
- **Empty repo gotcha:** a brand-new repo has no default branch → Contents API 404s. Add a README
  (one commit) first.
- **Token:** fine-grained PAT scoped to the *one* repo, Contents: read/write. **Re-scope (or
  re-issue) the token whenever `GITHUB_REPO` changes** — a token scoped to the old repo 404s.
- **Idempotent-by-date upsert** (drop all rows for the date, insert one) self-heals the duplicate
  rows a multi-calling model produces.

## 23. The health/TCM/cycle thread — DO-backed markdown memory (NEW, the big one)

A **conversational** TCM-practitioner / nutritionist / cycle-sync agent (`health` area, **Sonnet
4.6**, medium effort, vision) — *not* a logger. Its memory is **markdown stored in the DO**
(model-neutral, so the user can switch Claude↔GPT), three layers:

| Layer | DO key | Written by | Injected? |
|---|---|---|---|
| Baseline (uploaded health history) | `health:baseline:{key}` | `/baseline` (upload `.md`) | yes |
| Summary (trend table + running synthesis) | `health:summary:{key}` | `/checkin` | yes |
| Diagnosis notes (full per-consult) | `health:dx:{key}:{date}` | `/diagnosis` | latest only |

- **`injectHealth` flag** on the area → `handleMessage` reads all three from the DO (fast, local,
  no API) and prepends to the system prompt.
- **Implementation insight that avoids tool-writing-to-DO plumbing:** have the *model return
  structured text* and the *bot persist it*. `/diagnosis` + `/baseline` need no model (pure DO
  writes); `/checkin` runs a cheap **Haiku** pass that returns `ROW:` + `SYNTHESIS:`, which the DO
  method parses and saves. The tool loop is never involved.
- **Why DO over GitHub here:** speed (no per-turn GET) + the user said she won't browse raw files.
  Accepted tradeoff: **DO-only, no backup yet** (a nightly GitHub export was designed but
  deferred). Replaces the earlier GitHub `/logcycle` approach — that code (`CYCLE_TOOLS`,
  `getRecentCycleLog`, `log_cycle` in `github.ts`) is now **dead/unused** (left in place, cleanup
  later).
- Persona runs a **progressive intake interview** (TCM "Ten Questions"), reads tongue/face/hair
  photos via the thread model's vision.

## 24. Memory architecture — the design philosophy (NEW)

- **Three tiers:** HOT (always injected, compact — baseline + summary synthesis) · WARM (recent
  structured rows) · COLD (full archive, retrieved on demand — future).
- **Markdown everywhere = model-neutral.** This is the whole reason *not* to use a vendor's
  built-in memory: it must work identically across Claude/GPT/Gemini.
- **Offload time-series to structured logs** (the trend table) to keep the always-injected memory
  small — this is what delays needing a retrieval upgrade.
- **When to upgrade memory** (watch for these): answers get vague/cluttered (too many always-on
  facts) → add **retrieval**; want "what did I note months ago" → **semantic search** over the
  logs; want one agent to know another's context → **cross-thread memory**. Rough trigger: a
  thread's memory doc passing ~2–3k tokens, or 4–5 agents wanting shared context. The upgrade is
  **retrieval over the structured logs (a DO/SQLite index)**, not a rebuild.
- **DO vs GitHub for storage:** GitHub = durable / portable / versioned / browsable, but per-turn
  API latency + not queryable. DO = fast / local / queryable, but invisible + no free backup +
  stranded if the DO resets. **Resolution: GitHub as source-of-truth for data you want to
  own/browse; DO as a derived write-through cache when speed/query matters.** A mini-app can read
  either backend, so "I'll build a mini-app" does *not* favor DO.

## 25. Why NOT a vendor agent framework (NEW)

Considered the **Claude Agent SDK** and **OpenAI Agents SDK** (both give a managed agent loop +
built-in memory). Rejected for this bot:
- **Runtime:** both are Node/Python, server/local — **not Cloudflare Workers (V8 isolates).**
  (OpenAI's *Responses API* is HTTP so technically Worker-callable, unlike the SDK — but still…)
- **Vendor lock-in:** they're single-vendor; this bot is multi-vendor by design.
- **The decisive point — vendor-native memory siloes per vendor.** If the health thread's memory
  lived in OpenAI Responses state or Anthropic Managed-Agents memory, switching Claude↔GPT on
  that thread would **lose the memory**. The portable **markdown-in-DO** is exactly what survives
  model-switching. → roll your own thin memory layer.

## 26. Mental model: agent vs area vs persona (NEW — clarity that kept tripping us)

- **area** = which model + behavior + tools config (set by `/model <name>`). The *brain*.
- **agent (name)** = the storage *identity/folder* (set by `/agent set <name>`). Optional.
- **persona** = the `/persona` doc — behavior instructions. **Renamed from `/agents`** to stop the
  clash with `/agent` (the internal doc name is still `agents`).
- **keying:** state lives under `effectiveKey` = `chat:{chatId}:{threadId}`, or **`agent:{name}`**
  once named (`resolveSessionKey`).
- **GOTCHA:** naming a thread *after* conversing **orphans** prior state — history/area/docs stay
  under the old `chat:…` key; `agent:{name}` starts fresh and the area falls back to `kimi`. So
  you'd appear to "reset" and land on the wrong model. **Rule: `/agent set` FIRST, then
  `/model`/`/persona`/etc.**

## 27. Command reference (current — supersedes §17)

| Command | What |
|---|---|
| `/start`, `/help` | setup walkthrough |
| `/model <name> [level]` | set area (model+behavior+tools) + reasoning level. Areas: sonnet, opus, gemini, gpt, gpt-mini, kimi, health, admin (+ hidden do/log/plan executors) |
| `/agent set\|unset\|list` | name the thread (storage identity) |
| `/persona` | view/set this thread's behavior doc (was `/agents`) |
| `/soul` | global identity doc |
| `/remember`, `/memory`, `/forget`, `/compact` | memory ops |
| `/do [instruction]` | execute to Todoist + Housework (scoped executor) |
| `/log` / `/plan` | posture scores / weekly workout plan → GitHub `tg_bot_memories` |
| `/baseline` / `/checkin` / `/diagnosis` | health thread: set baseline · log trend+summary · save full consult (DO) |
| `/send <name>` | hand last reply to another named agent |
| `/edit` | mini-app editor (docs only — no health/DO viewer yet) |

Images: no command — an attached photo goes to the **thread's own model** (§19).

## 28. Updated open gaps (supersedes §16)

- **Health data is DO-only, no backup/export yet** (nightly GitHub export designed, deferred).
- **No viewer for DO health data** — the mini-app shows the editable docs only; a `/summary` view
  (or Health tabs in the mini-app) is proposed, not built.
- **Dead code:** `github.ts` still has the abandoned GitHub-cycle path (`CYCLE_TOOLS`,
  `getRecentCycleLog`, `log_cycle`/`get_cycle`) — unused, harmless, remove when convenient.
- **Secrets to set:** `OPENAI_API_KEY` (for gpt areas), `GITHUB_TOKEN` re-scoped to
  `tg_bot_memories`.
- **Caching:** confirmed Claude caching needs the prompt over the threshold (~2048 Sonnet / ~4096
  Opus) — small prompts silently don't cache. GPT/Gemini auto-cache. A `[cache]` usage log was
  added for diagnosis. 1h TTL available (`ttl:"1h"`, 2× write cost) but only worth it once over
  threshold. The health area's large injected prompt is where caching finally pays off.
- **Everything this session is deployed but UNCOMMITTED to git** (branch `claude/file-reading`).
- Prior gaps still open: `/do` idempotency (dup tasks on re-run), destructive-op confirmation, no
  tests/evals, heartbeat/cron not built, skill library deferred.
