import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { KIT } from "./paths.mjs";
import { client, isDev } from "./transport.mjs";

export const runId = () => randomBytes(3).toString("hex");

export function reporter(meta) {
  const steps = [];
  const add = (status, id, detail) => {
    steps.push({ id, status, ...(detail === undefined ? {} : { detail }) });
    if (process.env.KK_VERBOSE) process.stderr.write(`${status.padEnd(4)} ${id}${detail ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}\n`);
  };
  return {
    steps,
    pass: (id, d) => add("pass", id, d),
    fail: (id, d) => add("fail", id, d),
    skip: (id, d) => add("skip", id, d),
    warn: (id, d) => add("warn", id, d),
    async step(id, fn) {
      try {
        const v = await fn();
        add("pass", id, v?.detail);
        return v;
      } catch (e) {
        add("fail", id, e instanceof Fail ? e.message : `error: ${e?.name ?? ""} ${e?.message ?? e}${e?.reason ? ` (reason ${e.reason})` : ""}`);
        return undefined;
      }
    },
    finish(extra = {}) {
      const count = (s) => steps.filter((x) => x.status === s).length;
      const summary = { pass: count("pass"), fail: count("fail"), skip: count("skip"), warn: count("warn") };
      const ok = summary.fail === 0 && summary.pass > 0;
      const out = { ...meta, ...extra, ok, summary, steps, finished_at: new Date().toISOString() };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      return ok ? 0 : 1;
    },
  };
}

export class Fail extends Error {}
export const must = (cond, msg) => { if (!cond) throw new Fail(msg); };

export async function refused(fn, codes = ["not_allowed", "not_found"]) {
  let v;
  try {
    v = await fn();
  } catch (e) {
    const reason = String(e?.reason ?? "");
    if (/^turnstile/.test(reason)) throw new Fail(`refused by Turnstile (${reason}), not by the rule under test: disable Turnstile on QA hosts (RUNBOOK.md)`);
    if (e?.code === "rate_limited") throw new Fail(`refused by a rate limit (${reason}), not by the rule under test`);
    if (e?.code === "offline" || e?.code === "server") throw new Fail(`call failed (${e.code}: ${reason}), not a refusal`);
    if (!codes.includes(e?.code)) throw new Fail(`refused with ${e?.code}/${reason}, expected one of ${codes.join("|")}`);
    return { detail: `${e.code}/${reason}` };
  }
  if (v === null && codes.includes("not_found")) return { detail: "null (not visible)" };
  throw new Fail(`ALLOWED: ${JSON.stringify(v)?.slice(0, 200)}`);
}

export const ACTOR = { visitor: null, user: { role: "user" }, admin: { role: "admin" } };
export function allows(principals, member, isOwner) {
  return (principals ?? []).some((p) => p === "anyone" || (member !== null && (
    p === "signed_in" || (p === "owner" && isOwner) || (p === "admin" && member.role === "admin") || p === `role:${member.role}`)));
}

const stateFile = (conn) => `${KIT}/.state/${new URL(conn.origin).hostname}.json`;
function loadState(conn) {
  if (conn.dev) return {};
  try { return JSON.parse(readFileSync(stateFile(conn), "utf8")); } catch { return {}; }
}
function saveState(conn, st) {
  if (conn.dev) return;
  mkdirSync(`${KIT}/.state`, { recursive: true });
  writeFileSync(stateFile(conn), JSON.stringify(st, null, 2), { mode: 0o600 });
  chmodSync(stateFile(conn), 0o600);
}
export function forgetState(conn) {
  if (!conn.dev && existsSync(stateFile(conn))) writeFileSync(stateFile(conn), "{}", { mode: 0o600 });
}

export function testEmail(conn, tag) {
  if (conn.dev) return `kk-${tag}@example.com`;
  const base = process.env.POOLED_QA_EMAIL_BASE;
  if (!base || !/^[^@+\s]+@[^@\s]+$/.test(base)) throw new Error("POOLED_QA_EMAIL_BASE (user@domain of the QA mailbox) is required for real runs");
  const [u, d] = base.split("@");
  return `${u}+${tag}@${d}`.toLowerCase();
}
export const newPassword = () => `Kk-${randomBytes(12).toString("base64url")}`;

export async function completeLink(conn, z, link) {
  const u = new URL(link);
  must(u.origin === conn.origin, `auth link points at ${u.origin}, not this site (${conn.origin})`);
  const hop1 = await conn.raw("GET", u.pathname + u.search, { headers: { accept: "text/html" } });
  const loc1 = hop1.headers.get?.("location") ?? "";
  must(hop1.status >= 300 && hop1.status < 400 && loc1.startsWith("/auth/confirm#"), `callback hop 1: ${hop1.status} ${loc1.slice(0, 40)}`);
  const f1 = new URLSearchParams(loc1.split("#")[1]);
  must(!f1.get("error"), `callback hop 1 error: ${f1.get("error")}`);
  const q = `type=${encodeURIComponent(f1.get("type"))}&token_hash=${encodeURIComponent(f1.get("token_hash"))}&confirm=1`;
  const hop2 = await conn.raw("GET", `/api/auth/callback?${q}`, { headers: { accept: "text/html" } });
  const loc2 = hop2.headers.get?.("location") ?? "";
  const f2 = new URLSearchParams(loc2.split("#")[1] ?? "");
  must(hop2.status >= 300 && hop2.status < 400 && f2.get("access_token"), `callback hop 2: ${hop2.status} ${f2.get("error") ?? ""}`);
  const s = await z.auth.adoptSession(Object.fromEntries(f2.entries()));
  must(s, "callback returned an incomplete session");
  return s;
}

function persistOnChange(conn, z, key) {
  z.auth.onChange((s) => {
    const st = loadState(conn);
    st[key] = { ...(st[key] ?? {}), session: s };
    saveState(conn, st);
  });
}

async function resume(conn, z, cached) {
  if (!cached?.session) return false;
  try {
    await z.auth.adoptSession(cached.session);
    const t = await z.auth.accessToken();
    return !!t;
  } catch { return false; }
}

export async function user(conn, mailbox, key, { fresh = false, run = runId() } = {}) {
  const z = client(conn);
  const st = loadState(conn);
  const cached = !fresh && !conn.dev ? st[`user_${key}`] : null;
  if (cached && (await resume(conn, z, cached))) { persistOnChange(conn, z, `user_${key}`); return { z, email: cached.email, password: cached.password, key }; }
  if (cached?.email && cached?.password) {
    try { await z.auth.signIn({ email: cached.email, password: cached.password }); persistOnChange(conn, z, `user_${key}`); return { z, email: cached.email, password: cached.password, key }; } catch {  }
  }
  const email = testEmail(conn, `kk${key}${run}`);
  const password = newPassword();
  await signUpConfirmed(conn, mailbox, z, email, password);
  if (!conn.dev) { const s2 = loadState(conn); s2[`user_${key}`] = { email, password, session: z.auth.session() }; saveState(conn, s2); persistOnChange(conn, z, `user_${key}`); }
  return { z, email, password, key };
}

export async function signUpConfirmed(conn, mailbox, z, email, password) {
  const mark = mailbox ? await mailbox.mark(email) : 0;
  const r = await z.auth.signUp({ email, password });
  if (r.session) return r.session;
  must(mailbox, "sign-up needs email confirmation but no mailbox is configured (POOLED_QA_MAILBOX)");
  const link = await mailbox.waitForLink({ to: email, host: new URL(conn.origin).hostname, after: mark });
  return completeLink(conn, z, link);
}

export async function admin(conn, mailbox) {
  const z = client(conn);
  if (conn.dev) {
    await z.auth.signIn(conn.devAdmin);
    return { z, email: conn.devAdmin.email };
  }
  const email = process.env.POOLED_QA_ADMIN_EMAIL;
  if (!email) throw new Error("POOLED_QA_ADMIN_EMAIL (the QA founder account's email) is required for real runs");
  const st = loadState(conn);
  if (await resume(conn, z, st.admin)) { persistOnChange(conn, z, "admin"); return { z, email }; }
  if (process.env.POOLED_QA_ADMIN_PASSWORD) {
    try { await z.auth.signIn({ email, password: process.env.POOLED_QA_ADMIN_PASSWORD }); persistOnChange(conn, z, "admin"); return { z, email }; } catch {  }
  }
  must(mailbox, "admin sign-in needs a mailbox (POOLED_QA_MAILBOX) or POOLED_QA_ADMIN_PASSWORD");
  const mark = await mailbox.mark(email);
  await z.auth.signInWithMagicLink({ email });
  const link = await mailbox.waitForLink({ to: email, host: new URL(conn.origin).hostname, after: mark });
  await completeLink(conn, z, link);
  const s2 = loadState(conn); s2.admin = { session: z.auth.session() }; saveState(conn, s2);
  persistOnChange(conn, z, "admin");
  return { z, email };
}

export const visitor = (conn) => ({ z: client(conn) });
export { isDev };
