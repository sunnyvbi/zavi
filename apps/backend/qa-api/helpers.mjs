
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ENV_PATH = join(__dirname, "..", ".env");

export function loadEnv(path = ENV_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `qa-api: cannot read ${path}. Run from a checkout with apps/backend/.env present.`,
    );
  }
  const env = {};
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).replace(/^export\s+/, "").trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

export const TARGETS = {
  local: "http://localhost:3001",
  prod: "https://api.zaviagent.com",
};

export async function mintToken(env, email, password) {
  const url = `${env.SUPABASE_URL}/auth/v1/token?grant_type=password`;
  const r = await fetch(url, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) {
    throw new Error(
      `qa-api: token mint failed for ${email} (HTTP ${r.status}): ${JSON.stringify(body).slice(0, 200)}`,
    );
  }
  return { access_token: body.access_token, decoded: decodeJwt(body.access_token) };
}

export async function mintStaffToken(env) {
  const email = env.QA_STAFF_EMAIL;
  const password = env.QA_STAFF_PASSWORD;
  if (!email || !password) return null;
  const { access_token, decoded } = await mintToken(env, email, password);
  if (decoded?.app_metadata?.role !== "staff") {
    throw new Error(
      `qa-api: QA_STAFF_EMAIL ${email} minted but app_metadata.role !== 'staff' — staff routes will 401. ` +
        `Set the role via the Supabase admin API on a STAFF_EMAIL_ALLOWLIST account.`,
    );
  }
  return { access_token, decoded };
}

function decodeJwt(tok) {
  try {
    const [, payload] = tok.split(".");
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export async function http(base, { method = "GET", path, token, body, headers = {} } = {}) {
  const t0 = Date.now();
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && !h["Content-Type"]) h["Content-Type"] = "application/json";
  let res, text, json;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    text = await res.text();
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return {
      status: res.status,
      json,
      text,
      ms: Date.now() - t0,
      ok: res.ok,
      _wwwAuth: res.headers.get("www-authenticate") || null,
      _location: res.headers.get("location") || null,
    };
  } catch (e) {
    return { status: 0, json: undefined, text: String(e), ms: Date.now() - t0, ok: false, networkError: true };
  }
}

export async function pollUntil(fn, done, { timeoutMs = 90000, intervalMs = 2500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (done(last)) return { ...last, polled: true, timedOut: false };
    await sleep(intervalMs);
  }
  return { ...last, polled: true, timedOut: true };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function localInfraReason(res) {
  if (!res || res.status < 500) return null;
  const msg = (res.json?.error?.message || res.text || "").toString();
  const code = res.json?.error?.code || "";
  if (code.endsWith("_misconfigured") || /must be set|client_id.*client_secret/i.test(msg)) return "local env missing connector creds (set in prod; verify on --target prod)";
  return null;
}

export function runMarker() {
  return `qa-api-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function subsetMismatch(expected, actual, pathStr = "") {
  if (expected === undefined) return null;
  if (actual === undefined) return `missing ${pathStr || "(root)"}`;
  if (expected === null) return actual === null ? null : `${pathStr} expected null got ${j(actual)}`;
  if (typeof expected !== "object") {
    return expected === actual ? null : `${pathStr} expected ${j(expected)} got ${j(actual)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${pathStr} expected array got ${typeof actual}`;
    return null;
  }
  for (const k of Object.keys(expected)) {
    const m = subsetMismatch(expected[k], actual?.[k], pathStr ? `${pathStr}.${k}` : k);
    if (m) return m;
  }
  return null;
}

export function missingKeys(keys, obj) {
  if (!obj || typeof obj !== "object") return `response body not an object`;
  const miss = keys.filter((k) => !(k in obj));
  return miss.length ? `missing keys: ${miss.join(", ")}` : null;
}

const SECRET_KEY_RE = /(token|secret|password|api[_-]?key|service[_-]?role|dsn|access[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?key|refresh[_-]?token|vault)/i;
const SECRET_VAL_RE = /(eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|xox[bpoa]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|postgres(?:ql)?:\/\/[^"\s]+:[^"@\s]+@)/;
export function findLeakedSecret(value, pathStr = "$") {
  if (value == null) return null;
  if (typeof value === "string") {
    if (SECRET_VAL_RE.test(value)) return `${pathStr} looks like a raw secret: ${value.slice(0, 24)}…`;
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value)) {
    if (/_(at|on)$/i.test(k)) {
      const deeper = findLeakedSecret(v, `${pathStr}.${k}`);
      if (deeper) return deeper;
      continue;
    }
    if (SECRET_KEY_RE.test(k) && typeof v === "string" && v.length > 8 && !/^(redacted|null|connected|true|false)$/i.test(v)) {
      return `${pathStr}.${k} exposes a secret-shaped field: ${String(v).slice(0, 24)}…`;
    }
    const deeper = findLeakedSecret(v, `${pathStr}.${k}`);
    if (deeper) return deeper;
  }
  return null;
}

const j = (v) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};
