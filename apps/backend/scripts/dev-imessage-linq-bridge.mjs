
import http from "node:http";
import crypto from "node:crypto";

const LINQ_BASE = "https://api.linqapp.com/api/partner/v3";
const env = (k, d = "") => (process.env[k] ?? d).trim();

const LINQ_API_KEY = env("LINQ_API_KEY");
const ZAVI_PAT = env("ZAVI_PAT");
const ZAVI_MCP_URL = env("ZAVI_MCP_URL", "https://api.zaviagent.com/mcp");
const WORKSPACE_URL = env("ZAVI_WORKSPACE_URL", "https://www.zaviagent.com/workspace");
const WEBHOOK_SECRET = env("LINQ_WEBHOOK_SECRET");
const PORT = Number(env("BRIDGE_PORT", "4600"));
const ALLOWED = new Set(
  env("IMESSAGE_ALLOWED_SENDERS")
    .split(",")
    .map((s) => s.replace(/[^\d+]/g, ""))
    .filter(Boolean),
);

const E164 = /^\+[1-9]\d{7,14}$/;

const POLL_MS = 4_000;
const RUN_TIMEOUT_MS = 10 * 60_000;
const TYPING_REFRESH_MS = 60_000;
const CHUNK_CHARS = 500;
const MAX_CHUNKS = 8;
const BUBBLE_GAP_MS = 900;
const HISTORY_TURNS = 3;

const missing = [
  ["LINQ_API_KEY", LINQ_API_KEY],
  ["ZAVI_PAT", ZAVI_PAT],
  ["IMESSAGE_ALLOWED_SENDERS", ALLOWED.size ? "x" : ""],
].filter(([, v]) => !v);
if (missing.length) {
  console.error(`[bridge] missing env: ${missing.map(([k]) => k).join(", ")}`);
  process.exit(1);
}

const mask = (h) => (h ? `${h.slice(0, 3)}…${h.slice(-2)}` : "?");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "[bridge]", ...a);

async function linq(method, path, body) {
  const res = await fetch(`${LINQ_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${LINQ_API_KEY}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`linq ${method} ${path} → ${res.status} ${t.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

const sendText = (chatId, text) =>
  linq("POST", `/chats/${chatId}/messages`, {
    message: { parts: [{ type: "text", value: text }] },
  });
const startTyping = (chatId) => linq("POST", `/chats/${chatId}/typing`).catch(() => {});
const stopTyping = (chatId) => linq("DELETE", `/chats/${chatId}/typing`).catch(() => {});

function verifySignature(headers, raw) {
  if (!WEBHOOK_SECRET) return true;
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const sigs = String(headers["webhook-signature"] ?? "");
  if (!id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ""), "base64");
  const expected = crypto.createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest();
  return sigs.split(" ").some((s) => {
    const got = Buffer.from(s.replace(/^v1,/, ""), "base64");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}

function parseInbound(evt) {
  if (evt?.event_type !== "message.received") return null;
  const d = evt.data ?? {};
  const inbound = d.direction ? d.direction === "inbound" : d.is_from_me === false;
  if (!inbound) return null;
  const msg = d.message ?? d;
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  return {
    messageId: String(msg.id ?? evt.event_id ?? ""),
    chatId: String(d.chat?.id ?? d.chat_id ?? ""),
    isGroup: Boolean(d.chat?.is_group ?? d.is_group),
    sender: String(d.sender_handle?.handle ?? d.from ?? d.from_handle ?? "").trim(),
    text: parts
      .filter((p) => p?.type === "text")
      .map((p) => p.value ?? "")
      .join("\n")
      .trim(),
    hasMedia: parts.some((p) => p && p.type !== "text"),
  };
}

let rpcId = 0;
async function mcpCall(name, args) {
  const res = await fetch(ZAVI_MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ZAVI_PAT}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`zavi mcp ${name} → ${res.status} ${raw.slice(0, 200)}`);
  const jsonText = raw.trimStart().startsWith("{")
    ? raw
    : raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .pop();
  const msg = JSON.parse(jsonText ?? "{}");
  if (msg.error) throw new Error(`zavi mcp ${name}: ${msg.error.message}`);
  const text = msg.result?.content?.[0]?.text ?? "{}";
  const data = JSON.parse(text);
  if (msg.result?.isError || data?.error) throw new Error(`zavi mcp ${name}: ${data?.error ?? text}`);
  return data;
}

const RUNNING = new Set(["queued", "running", "paused_awaiting_child"]);

async function askZavi(message) {
  const { run_id } = await mcpCall("zavi_ask", { message });
  log(`run ${run_id} started`);
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const run = await mcpCall("zavi_get_run_status", { run_id });
    if (RUNNING.has(run.status)) continue;
    log(`run ${run.run_id ?? run_id} → ${run.status}${run.delegated_from ? ` (via ${run.agent_slug})` : ""}`);
    return { run_id, run };
  }
  return { run_id, run: null };
}

function replyFor({ run_id, run }) {
  if (!run) return `Still working on that one. I'll keep going, and you can watch it at ${WORKSPACE_URL}`;
  if (String(run.status).startsWith("paused_awaiting_approval")) {
    return `I need your approval before I go ahead. Approve it in Zavi: ${WORKSPACE_URL}`;
  }
  const out = (run.result ?? "").trim();
  if (out) return out;
  if (run.status === "success") return "Done.";
  return `Sorry, that one failed on my side (${run.status}). Try again, or check ${WORKSPACE_URL} (run ${run_id.slice(0, 8)}).`;
}

function toPlainText(md) {
  return md
    .replace(/```[a-z]*\n?([\s\S]*?)```/g, "$1")
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}[ \t|:-]*\n?/gm, "")
    .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_, row) => row.split("|").map((c) => c.trim()).join(" · "))
    .replace(/^#{1,6}\s+(.*)$/gm, (_, h) => h.toUpperCase())
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]+)\]\((\S+?)\)/g, (_, t, u) => (t === u ? u : `${t} (${u})`))
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/^>\s?/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLong(p) {
  const out = [];
  let rest = p;
  while (rest.length > CHUNK_CHARS) {
    let cut = rest.lastIndexOf("\n", CHUNK_CHARS);
    if (cut < CHUNK_CHARS / 2) cut = rest.lastIndexOf(". ", CHUNK_CHARS) + 1;
    if (cut < CHUNK_CHARS / 2) cut = rest.lastIndexOf(" ", CHUNK_CHARS);
    if (cut <= 0) cut = CHUNK_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function chunk(text) {
  const pieces = text.split(/\n{2,}/).flatMap((p) => splitLong(p.trim())).filter(Boolean);
  const out = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last && last.length + 2 + piece.length <= CHUNK_CHARS) out[out.length - 1] = `${last}\n\n${piece}`;
    else out.push(piece);
  }
  if (out.length > MAX_CHUNKS) {
    out.length = MAX_CHUNKS;
    out[MAX_CHUNKS - 1] = `${out[MAX_CHUNKS - 1]}\n\n(That's the short version. Full answer in Zavi: ${WORKSPACE_URL})`;
  }
  return out;
}

const seen = new Set();
const history = new Map();
const queues = new Map();

function withHistory(chatId, text) {
  const turns = history.get(chatId) ?? [];
  if (!turns.length) return text;
  const ctx = turns
    .map((t) => `User: ${t.user.slice(0, 500)}\nZavi: ${t.zavi.slice(0, 800)}`)
    .join("\n\n");
  return `(This is an iMessage conversation. Earlier turns, for context:)\n\n${ctx}\n\n(New message from the user:)\n${text}`;
}

async function handle(m) {
  if (m.hasMedia && !m.text) {
    await sendText(m.chatId, "I can only read text over iMessage for now. Send it as a message, or drop the file into Zavi on the web.");
    return;
  }
  if (!m.text) return;

  await startTyping(m.chatId);
  const keepTyping = setInterval(() => startTyping(m.chatId), TYPING_REFRESH_MS);
  let answer;
  try {
    answer = replyFor(await askZavi(withHistory(m.chatId, m.text)));
  } catch (e) {
    log(`ask failed: ${e.message}`);
    answer = "Something went wrong reaching Zavi. Please send that again in a minute.";
  } finally {
    clearInterval(keepTyping);
    await stopTyping(m.chatId);
  }

  const plain = toPlainText(answer);
  const parts = chunk(plain);
  for (const [i, p] of parts.entries()) {
    if (i) await new Promise((r) => setTimeout(r, BUBBLE_GAP_MS));
    await sendText(m.chatId, p);
  }
  log(`replied ${parts.length} message(s), ${plain.length} chars`);

  const turns = [...(history.get(m.chatId) ?? []), { user: m.text, zavi: plain }];
  history.set(m.chatId, turns.slice(-HISTORY_TURNS));
}

function onEvent(evt) {
  const m = parseInbound(evt);
  if (!m || !m.chatId) return;
  if (m.messageId && seen.has(m.messageId)) return;
  if (m.messageId) seen.add(m.messageId);
  if (m.isGroup) {
    log(`ignored group message in ${m.chatId}`);
    return;
  }
  if (!E164.test(m.sender) || !ALLOWED.has(m.sender)) {
    log(`ignored sender ${mask(m.sender)} (not in IMESSAGE_ALLOWED_SENDERS)`);
    return;
  }
  log(`message from ${mask(m.sender)} (${m.text.length} chars)`);
  const prev = queues.get(m.chatId) ?? Promise.resolve();
  const next = prev.then(() => handle(m)).catch((e) => log(`handle failed: ${e.message}`));
  queues.set(m.chatId, next);
}

http
  .createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/linq")) {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      if (!verifySignature(req.headers, raw)) {
        log("rejected: bad webhook signature");
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200).end("ok");
      try {
        onEvent(JSON.parse(raw));
      } catch (e) {
        log(`bad payload: ${e.message}`);
      }
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    log(`listening on http://127.0.0.1:${PORT}/linq → ${ZAVI_MCP_URL}`);
    log(`answering ${ALLOWED.size} allowed number(s); signatures ${WEBHOOK_SECRET ? "enforced" : "off (localhost only)"}`);
  });
