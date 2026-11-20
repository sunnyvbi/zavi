#!/usr/bin/env node

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROD_REF = "wmycgyjsenvgtczlupoe";
export const STAGING_REF = "dgzgwclslzzzrjopbobp";
const SDK = "@anthropic-ai/claude-agent-sdk";

export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

function loadEnv(files) {
  const fromFiles = Object.assign({}, ...files.filter(existsSync).map((f) => parseEnv(readFileSync(f, "utf8"))));
  const fromShell = Object.fromEntries(Object.keys(fromFiles).concat(ENV_KEYS).filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  return { ...fromFiles, ...fromShell };
}

const ENV_KEYS = ["SUPABASE_URL", "SUPABASE_ANON_KEY", "QA_TEST_EMAIL", "QA_TEST_PASSWORD", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function parseUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { error: "is not a valid URL" }; }
  if (u.username || u.password) return { error: "must not contain user:password@" };
  return { url: u, host: u.hostname.toLowerCase().replace(/\.$/, "") };
}

export function unsafeUrl(raw) {
  const p = parseUrl(raw);
  if (p.error) return p.error;
  if (p.url.protocol === "https:") return null;
  if (p.url.protocol === "http:" && LOCAL_HOSTS.includes(p.host)) return null;
  return "must be https:// (or http://localhost), so no key or password is sent";
}

function endpoint(raw, path) {
  return new URL(path, parseUrl(raw).url.origin).href;
}

export function projectLabel(raw) {
  const { host = "" } = parseUrl(raw);
  if (host === `${PROD_REF}.supabase.co`) return "PROD";
  if (host === `${STAGING_REF}.supabase.co`) return "staging";
  if (LOCAL_HOSTS.includes(host)) return "local supabase";
  const ref = host.match(/^([a-z0-9]+)\.supabase\.co$/)?.[1];
  return ref ? `project ${ref}` : "unknown";
}

export function checkSdk(pinned, installed) {
  if (!pinned) return { status: "skip", detail: `${SDK} not in apps/backend/package.json` };
  if (!installed) return { status: "fail", detail: `${SDK} not installed. Run: npm install` };
  if (installed !== pinned.replace(/^[\^~]/, "")) {
    return { status: "fail", detail: `${SDK} installed ${installed}, pinned ${pinned}. Run: npm install (a stale install fails site builds with "does not support this model")` };
  }
  return { status: "ok", detail: `${SDK} ${installed}` };
}

async function errorText(res) {
  const body = await res.json().catch(() => ({}));
  return body.msg || body.message || body.error_description || body.error_code || body.error || `HTTP ${res.status}`;
}

export async function checkAnonKey(url, key, fetchImpl = fetch) {
  if (!url || !key) return { status: "fail", detail: "SUPABASE URL or anon key is empty" };
  if (unsafeUrl(url)) return { status: "fail", detail: `Supabase URL ${unsafeUrl(url)}` };
  const res = await fetchImpl(endpoint(url, "/auth/v1/settings"), { headers: { apikey: key }, redirect: "error" });
  if (res.ok) return { status: "ok", detail: `accepted by ${projectLabel(url)}` };
  return { status: "fail", detail: `${projectLabel(url)} rejected the anon key: ${await errorText(res)}. Ask Ravi for the current one.` };
}

export async function checkSignIn(url, key, email, password, fetchImpl = fetch) {
  if (!email || !password) return { status: "skip", detail: "QA_TEST_EMAIL / QA_TEST_PASSWORD not set" };
  if (!url) return { status: "fail", detail: "SUPABASE_URL is empty" };
  if (unsafeUrl(url)) return { status: "fail", detail: `SUPABASE_URL ${unsafeUrl(url)}` };
  const label = projectLabel(url);
  if (label === "PROD") return { status: "skip", detail: "never signs in to PROD from a local check" };
  if (label !== "staging" && label !== "local supabase") return { status: "skip", detail: `signs in only to staging or local supabase, not ${label}` };
  const res = await fetchImpl(endpoint(url, "/auth/v1/token?grant_type=password"), {
    method: "POST",
    redirect: "error",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (res.ok) return { status: "ok", detail: `QA_TEST_EMAIL signs in to ${projectLabel(url)}` };
  return { status: "fail", detail: `QA_TEST_EMAIL cannot sign in to ${projectLabel(url)}: ${await errorText(res)}. Ask Ravi for the current test account.` };
}

export async function runChecks({ backend, web, pinned, installed, signin = true, fetchImpl = fetch }) {
  const checks = [];
  const add = (name, r) => checks.push({ name, ...r });
  const safe = async (fn) => {
    try { return await fn(); } catch (e) { return { status: "fail", detail: `request failed: ${e.message}` }; }
  };

  add("agent sdk", checkSdk(pinned, installed));

  const bUrl = backend.SUPABASE_URL;
  const bLabel = projectLabel(bUrl);
  if (bUrl === undefined) add("backend project", { status: "fail", detail: "SUPABASE_URL missing from apps/backend/.env (copy apps/backend/.env.example)" });
  else if (bLabel === "PROD") add("backend project", { status: "fail", detail: "points at PROD. Local work uses staging (see CLAUDE.md)" });
  else add("backend project", { status: "ok", detail: bLabel });
  add("backend anon key", await safe(() => checkAnonKey(bUrl, backend.SUPABASE_ANON_KEY, fetchImpl)));

  const wUrl = web.NEXT_PUBLIC_SUPABASE_URL;
  if (wUrl === undefined) {
    add("web project", { status: "fail", detail: "NEXT_PUBLIC_SUPABASE_URL missing from apps/web/.env.local (copy apps/web/.env.local.example)" });
  } else {
    add("web project", wUrl.replace(/\/$/, "") === (bUrl || "").replace(/\/$/, "")
      ? { status: "ok", detail: `same project as backend (${projectLabel(wUrl)})` }
      : { status: "fail", detail: `web points at ${projectLabel(wUrl)}, backend at ${projectLabel(bUrl)}. Sessions minted by one are rejected by the other.` });
    add("web anon key", await safe(() => checkAnonKey(wUrl, web.NEXT_PUBLIC_SUPABASE_ANON_KEY, fetchImpl)));
  }

  add("test sign-in", signin
    ? await safe(() => checkSignIn(bUrl, backend.SUPABASE_ANON_KEY, backend.QA_TEST_EMAIL, backend.QA_TEST_PASSWORD, fetchImpl))
    : { status: "skip", detail: "--no-signin" });
  return checks;
}

function readVersion(file) {
  try { return JSON.parse(readFileSync(file, "utf8")).version; } catch { return undefined; }
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const be = join(root, "apps", "backend");
  const pkg = JSON.parse(readFileSync(join(be, "package.json"), "utf8"));
  const sdkPkg = [join(be, "node_modules", SDK, "package.json"), join(root, "node_modules", SDK, "package.json")].find(existsSync);
  const checks = await runChecks({
    backend: loadEnv([join(be, ".env"), join(be, "dev.env")]),
    web: loadEnv([join(root, "apps", "web", ".env.local"), join(root, "apps", "web", ".env.development.local")]),
    pinned: pkg.dependencies?.[SDK],
    installed: sdkPkg && readVersion(sdkPkg),
    signin: !process.argv.includes("--no-signin"),
  });
  const icon = { ok: "OK  ", warn: "WARN", fail: "FAIL", skip: "skip" };
  for (const c of checks) console.log(`${icon[c.status]}  ${c.name.padEnd(17)} ${c.detail}`);
  process.exitCode = checks.some((c) => c.status === "fail") ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
