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

  const ALL_DOCS = ["soul", "user", "agents", "tools", "memory", "heartbeat", "local_tools"] as const;

  // GET /api/docs — load all docs for the session
  if (request.method === "GET") {
    const [soul, user, tools, agents, memory, heartbeat, local_tools] = await Promise.all([
      stub.loadDoc("soul"),
      stub.loadDoc("user"),
      stub.loadDoc("tools"),
      stub.loadDoc("agents", sessionKey),
      stub.loadDoc("memory", sessionKey),
      stub.loadDoc("heartbeat", sessionKey),
      stub.loadDoc("local_tools", sessionKey),
    ]);
    return new Response(JSON.stringify({ soul, user, tools, agents, memory, heartbeat, local_tools }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // POST /api/docs — save one doc
  if (request.method === "POST") {
    const { name, content } = (await request.json()) as { name: string; content: string };
    if (!(ALL_DOCS as readonly string[]).includes(name)) {
      return new Response(JSON.stringify({ error: "invalid doc name" }), {
        status: 400,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    await stub.saveDoc(name as typeof ALL_DOCS[number], content, sessionKey);
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
    padding: 12px 16px 24px;
  }
  h1 { font-size: 17px; font-weight: 600; margin-bottom: 12px; }
  .tabs {
    display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px;
  }
  .tab {
    padding: 6px 12px; border-radius: 20px; border: none; cursor: pointer;
    background: var(--tg-theme-secondary-bg-color, #f0f0f0);
    color: var(--tg-theme-text-color, #000);
    font-size: 13px; font-weight: 500;
  }
  .tab.active {
    background: #FE5F55;
    color: #fff;
  }
  .panel { display: none; }
  .panel.active { display: flex; flex-direction: column; gap: 10px; }
  .desc { font-size: 12px; opacity: 0.6; line-height: 1.4; }
  .badge {
    display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 8px;
    background: var(--tg-theme-secondary-bg-color, #eee);
    opacity: 0.7; margin-left: 4px; vertical-align: middle;
  }
  textarea {
    width: 100%; min-height: 180px; padding: 12px; border-radius: 10px; border: none;
    background: var(--tg-theme-secondary-bg-color, #f0f0f0);
    color: var(--tg-theme-text-color, #000);
    font-size: 14px; line-height: 1.5; resize: vertical; outline: none;
  }
  button.save {
    padding: 11px; border-radius: 10px; border: none; cursor: pointer;
    background: #FE5F55;
    color: #fff;
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
<div class="tabs" id="tab-bar"></div>
<div id="panels"></div>

<script>
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const initData = tg.initData;
// Fix: web_app keyboard buttons don't set start_param via SDK — read from URL query string
const urlParams = new URLSearchParams(location.search);
const session = tg.initDataUnsafe?.start_param || urlParams.get("startapp") || "";

// Show agent name in header if this session is a named agent
const decodedSession = session.replace(/-C-/g, ":").replace(/N(\d)/g, "-$1");
const agentName = decodedSession.startsWith("agent:") ? decodedSession.slice(6) : null;
if (agentName) document.querySelector("h1").textContent = "Agent: " + agentName;
const base = location.origin + "/api/docs" + (session ? "?session=" + encodeURIComponent(session) : "");

const DOCS = [
  { name: "soul",        label: "Soul",        scope: "global", desc: "Core identity and personality — applies to all chats" },
  { name: "user",        label: "User",        scope: "global", desc: "Your profile, preferences and facts about you — applies to all chats" },
  { name: "tools",       label: "Tools",       scope: "global", desc: "Global tools and capabilities available in all chats" },
  { name: "agents",      label: "Agents",      scope: "thread", desc: "Specialised agent behaviour for this thread specifically" },
  { name: "local_tools", label: "Local Tools", scope: "thread", desc: "Extra tools or overrides specific to this thread only" },
  { name: "heartbeat",   label: "Heartbeat",   scope: "thread", desc: "Recurring context or periodic instructions for this thread" },
  { name: "memory",      label: "Memory",      scope: "thread", desc: "Persistent facts the bot remembers in this thread" },
];

// Build tabs and panels
const tabBar  = document.getElementById("tab-bar");
const panels  = document.getElementById("panels");
DOCS.forEach((d, i) => {
  const tab = document.createElement("button");
  tab.className = "tab" + (i === 0 ? " active" : "");
  tab.textContent = d.label;
  tab.onclick = () => switchTab(d.name);
  tabBar.appendChild(tab);

  const panel = document.createElement("div");
  panel.id = "panel-" + d.name;
  panel.className = "panel" + (i === 0 ? " active" : "");
  panel.innerHTML = \`
    <p class="desc">\${d.desc} <span class="badge" style="\${d.scope==='global'?'background:#55FEC5;color:#000;opacity:1':''}">\${d.scope}</span></p>
    <textarea id="ta-\${d.name}" placeholder="Leave blank to disable…"></textarea>
    <button class="save" onclick="save('\${d.name}')">Save \${d.label}</button>
    <div class="status" id="st-\${d.name}"></div>
  \`;
  panels.appendChild(panel);
});

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
    DOCS.forEach(d => {
      document.getElementById("ta-" + d.name).value = data[d.name] ?? "";
    });
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
    t.classList.toggle("active", DOCS[i].name === name);
  });
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  document.getElementById("panel-" + name).classList.add("active");
}

load();
</script>
</body>
</html>`;
}
