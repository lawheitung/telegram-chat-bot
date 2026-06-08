import type { Env } from "./types";
import type { AgentDO } from "./agent";

// ── Auth ────────────────────────────────────────────────────────────────────

// Verify Telegram WebApp initData and return the numeric user ID.
// Throws if the signature is invalid or the payload is malformed.
export async function verifyWebAppData(initData: string, botToken: string): Promise<number> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("missing hash");
  params.delete("hash");

  // data-check-string: sorted key=value pairs joined with \n
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const enc = new TextEncoder();

  // secret_key = HMAC-SHA256(bot_token, "WebAppData")
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const secretKeyBytes = await crypto.subtle.sign("HMAC", baseKey, enc.encode(botToken));

  // expected = HMAC-SHA256(data_check_string, secret_key)
  const signKey = await crypto.subtle.importKey(
    "raw", secretKeyBytes,
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", signKey, enc.encode(dataCheckString));
  const computed = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");

  if (computed !== hash) throw new Error("invalid signature");

  const user = JSON.parse(params.get("user") ?? "{}");
  if (!user.id) throw new Error("no user in initData");
  return Number(user.id);
}

// ── Session param encoding ───────────────────────────────────────────────────
// Telegram start_param allows: A-Z a-z 0-9 _ -
// sessionKey format: "chat:{chatId}" or "chat:{chatId}:{threadId}"
// We encode ":" as "-C-" and leading "-" in chatId as "N" so it roundtrips safely.

export function encodeSession(key: string): string {
  return key.replace(/-/g, "N").replace(/:/g, "-C-");
}

export function decodeSession(param: string): string {
  return param.replace(/-C-/g, ":").replace(/N(\d)/g, "-$1");
}

// ── API handler ─────────────────────────────────────────────────────────────

export async function handleMiniAppApi(
  request: Request,
  env: Env,
  stub: ReturnType<DurableObjectNamespace<AgentDO>["get"]>,
): Promise<Response> {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  if (request.method === "OPTIONS") return new Response(null, { headers: cors });

  // Auth: initData must be in Authorization header
  const initData = request.headers.get("Authorization") ?? "";
  let userId: number;
  try {
    userId = await verifyWebAppData(initData, env.BOT_TOKEN);
  } catch {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Only allowed user IDs may proceed
  const allowed = env.ALLOWED_USER_IDS.split(",").map((s) => s.trim());
  if (!allowed.includes(String(userId))) {
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const url = new URL(request.url);
  const sessionParam = url.searchParams.get("session") ?? "";
  const sessionKey = sessionParam ? decodeSession(sessionParam) : undefined;

  // GET /api/docs — load all three docs for the session
  if (request.method === "GET") {
    const [soul, agents, memory] = await Promise.all([
      stub.loadDoc("soul"),
      stub.loadDoc("agents", sessionKey),
      stub.loadDoc("memory", sessionKey),
    ]);
    return new Response(JSON.stringify({ soul, agents, memory }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // POST /api/docs — save one doc
  if (request.method === "POST") {
    const { name, content } = (await request.json()) as { name: string; content: string };
    if (!["soul", "agents", "memory"].includes(name)) {
      return new Response(JSON.stringify({ error: "invalid doc name" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    await stub.saveDoc(name as "soul" | "agents" | "memory", content, sessionKey);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  return new Response("Method Not Allowed", { status: 405, headers: cors });
}

// ── HTML ─────────────────────────────────────────────────────────────────────

export function miniAppHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<title>Bot Settings</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: var(--tg-theme-bg-color, #fff);
    color: var(--tg-theme-text-color, #000);
    min-height: 100vh;
    padding: 16px;
  }
  h1 { font-size: 18px; font-weight: 600; margin-bottom: 16px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
  .tab {
    flex: 1; padding: 8px; border-radius: 8px; border: none; cursor: pointer;
    background: var(--tg-theme-secondary-bg-color, #f0f0f0);
    color: var(--tg-theme-text-color, #000);
    font-size: 14px; font-weight: 500;
  }
  .tab.active {
    background: var(--tg-theme-button-color, #2481cc);
    color: var(--tg-theme-button-text-color, #fff);
  }
  .panel { display: none; }
  .panel.active { display: flex; flex-direction: column; gap: 10px; }
  label { font-size: 13px; opacity: 0.7; }
  textarea {
    width: 100%; min-height: 200px; padding: 12px; border-radius: 10px; border: none;
    background: var(--tg-theme-secondary-bg-color, #f0f0f0);
    color: var(--tg-theme-text-color, #000);
    font-size: 14px; line-height: 1.5; resize: vertical;
    outline: none;
  }
  button.save {
    padding: 12px; border-radius: 10px; border: none; cursor: pointer;
    background: var(--tg-theme-button-color, #2481cc);
    color: var(--tg-theme-button-text-color, #fff);
    font-size: 15px; font-weight: 600;
  }
  button.save:disabled { opacity: 0.5; cursor: not-allowed; }
  .status { font-size: 13px; text-align: center; min-height: 18px; }
  .status.ok { color: #FE5F55; }
  .status.err { color: #f44336; }
</style>
</head>
<body>
<h1>Bot Settings</h1>
<div class="tabs">
  <button class="tab active" onclick="switchTab('soul')">Soul</button>
  <button class="tab" onclick="switchTab('agents')">Agents</button>
  <button class="tab" onclick="switchTab('memory')">Memory</button>
</div>

<div id="panel-soul" class="panel active">
  <label>Identity — who the bot is (global, all chats)</label>
  <textarea id="ta-soul" placeholder="e.g. You are a concise assistant…"></textarea>
  <button class="save" onclick="save('soul')">Save Soul</button>
  <div class="status" id="st-soul"></div>
</div>
<div id="panel-agents" class="panel">
  <label>Behaviour rules — how the bot acts in this chat</label>
  <textarea id="ta-agents" placeholder="e.g. Always reply in bullet points…"></textarea>
  <button class="save" onclick="save('agents')">Save Agents</button>
  <div class="status" id="st-agents"></div>
</div>
<div id="panel-memory" class="panel">
  <label>Persistent memory — facts about you in this chat</label>
  <textarea id="ta-memory" placeholder="e.g. - prefers metric units…"></textarea>
  <button class="save" onclick="save('memory')">Save Memory</button>
  <div class="status" id="st-memory"></div>
</div>

<script>
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const initData = tg.initData;
const session  = tg.initDataUnsafe?.start_param ?? "";
const base     = location.origin + "/api/docs" + (session ? "?session=" + session : "");

async function apiFetch(method, body) {
  const res = await fetch(base, {
    method,
    headers: { "Authorization": initData, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function load() {
  try {
    const data = await apiFetch("GET");
    document.getElementById("ta-soul").value    = data.soul    ?? "";
    document.getElementById("ta-agents").value  = data.agents  ?? "";
    document.getElementById("ta-memory").value  = data.memory  ?? "";
  } catch (e) {
    setStatus("soul", "Failed to load: " + e.message, true);
  }
}

async function save(name) {
  const btn = document.querySelector("#panel-" + name + " button.save");
  btn.disabled = true;
  setStatus(name, "Saving…", false);
  try {
    const content = document.getElementById("ta-" + name).value;
    await apiFetch("POST", { name, content });
    setStatus(name, "Saved ✓", false);
  } catch (e) {
    setStatus(name, "Error: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function setStatus(name, msg, isErr) {
  const el = document.getElementById("st-" + name);
  el.textContent = msg;
  el.className = "status " + (isErr ? "err" : "ok");
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t, i) => {
    const names = ["soul", "agents", "memory"];
    t.classList.toggle("active", names[i] === name);
  });
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.getElementById("panel-" + name).classList.add("active");
}

load();
</script>
</body>
</html>`;
}
