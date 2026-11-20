
import type { Request, Response } from "express";
import { requireAuth } from "@/services/auth/middleware";
import { serviceClient } from "@/services/supabase";
import {
  SLUG_RE,
  PROTOTYPE_BUCKET,
  prototypeLinkBaseUrl,
  shareablePreviewEnabled,
} from "@/services/agents/prototype-links";
import { htmlPreviewSchema, type HtmlPreview } from "@/agents/engineer/output-schema";
import { hardenPageHtml, SHARED_PAGES_BUCKET } from "@/services/shared-pages/page";

const RL_WINDOW_MS = 60_000;
const RL_MAX = 60;
const rlBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const b = rlBuckets.get(ip);
  if (!b || now > b.resetAt) {
    rlBuckets.set(ip, { count: 1, resetAt: now + RL_WINDOW_MS });
    return false;
  }
  b.count += 1;
  if (rlBuckets.size > 10_000) rlBuckets.clear();
  return b.count > RL_MAX;
}

export function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\u2028/g, "&#8232;")
    .replace(/\u2029/g, "&#8233;");
}

export type PrState = {
  state: "awaiting_approval" | "opened" | "merged";
  pr_number?: number;
  pr_url?: string;
};

async function livePrState(run_id: string): Promise<PrState> {
  try {
    const { data } = await serviceClient()
      .from("agent_runs")
      .select("parsed")
      .eq("id", run_id)
      .maybeSingle<{ parsed: Record<string, unknown> | null }>();
    const p = (data?.parsed ?? {}) as Record<string, unknown>;
    const pr_url = typeof p.pr_url === "string" ? p.pr_url : undefined;
    const pr_number = typeof p.pr_number === "number" ? p.pr_number : undefined;
    if (!pr_url) return { state: "awaiting_approval" };
    if (p.merged === true) return { state: "merged", pr_number, pr_url };
    return { state: "opened", pr_number, pr_url };
  } catch {
    return { state: "awaiting_approval" };
  }
}

export function renderShell(env: HtmlPreview, pr: PrState): string {
  const badge =
    pr.state === "merged"
      ? `Shipped as real PR ${pr.pr_number ? `#${pr.pr_number}` : ""} ✓`
      : pr.state === "opened"
        ? `Ships as real PR ${pr.pr_number ? `#${pr.pr_number}` : ""} — open`
        : "Real PR: awaiting owner approval";
  const badgeClass = pr.state === "merged" ? "merged" : pr.state === "opened" ? "open" : "waiting";
  const hasBefore = typeof env.html_before === "string" && env.html_before.length > 0;
  const cards = (env.rationale ?? [])
    .map(
      (r) =>
        `<div class="card"><div class="chg">${esc(r.change)}</div><div class="why">${esc(r.why)}</div></div>`,
    )
    .join("");
  const frame = (html: string, id: string, hidden: boolean) =>
    `<iframe id="${id}" class="proto${hidden ? " hidden" : ""}" sandbox="allow-scripts" srcdoc="${esc(html)}" title="prototype"></iframe>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, noarchive, nofollow">
<title>${esc(env.title)} — Zavi prototype</title>
<style>
  :root{color-scheme:light}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7fb;color:#111827}
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 20px;background:#fff;border-bottom:1px solid #e5e7eb;position:sticky;top:0}
  .logo{font-weight:800;font-size:15px;letter-spacing:.3px}
  .label{font-size:12px;padding:3px 10px;border-radius:999px;background:#eef2ff;color:#4338ca;font-weight:600}
  .badge{font-size:12px;padding:3px 10px;border-radius:999px;font-weight:700;margin-left:auto}
  .badge.merged{background:#dcfce7;color:#166534}
  .badge.open{background:#dbeafe;color:#1d4ed8}
  .badge.waiting{background:#f3f4f6;color:#6b7280}
  .badge a{color:inherit;text-decoration:none}
  main{max-width:1100px;margin:0 auto;padding:20px}
  h1{font-size:20px;margin:6px 0 2px}
  .summary{color:#4b5563;font-size:14px;margin:0 0 14px}
  .toggle{display:inline-flex;border:1px solid #d1d5db;border-radius:10px;overflow:hidden;margin-bottom:12px}
  .toggle button{border:0;background:#fff;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;color:#6b7280}
  .toggle button.active{background:#4f46e5;color:#fff}
  .note{font-size:11px;color:#9ca3af;margin:4px 0 10px}
  .proto{width:100%;height:72vh;border:1px solid #e5e7eb;border-radius:12px;background:#fff}
  .hidden{display:none}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin:18px 0}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px}
  .chg{font-weight:700;font-size:13px;margin-bottom:4px}
  .why{font-size:13px;color:#4b5563;line-height:1.45}
  footer{text-align:center;font-size:12px;color:#9ca3af;padding:24px}
  footer a{color:#4f46e5;text-decoration:none;font-weight:600}
</style></head>
<body>
<header>
  <span class="logo">Zavi</span>
  <span class="label">Prototype — not the live app</span>
  <span class="badge ${badgeClass}">${pr.pr_url ? `<a href="${esc(pr.pr_url)}" rel="noreferrer noopener">${esc(badge)}</a>` : esc(badge)}</span>
</header>
<main>
  <h1>${esc(env.title)}</h1>
  <p class="summary">${esc(env.summary)}</p>
  ${
    hasBefore
      ? `<div class="toggle"><button id="btn-before" onclick="show('before')">Before (current)</button><button id="btn-after" class="active" onclick="show('after')">After (proposed)</button></div>
<p class="note">"Before" is an approximate rendering of the current UI generated from the code — not a capture of the live site.</p>`
      : ""
  }
  ${hasBefore ? frame(env.html_before as string, "frame-before", true) : ""}
  ${frame(env.html, "frame-after", false)}
  ${cards ? `<div class="cards">${cards}</div>` : ""}
</main>
<footer>Generated by <a href="https://www.zaviagent.com" rel="noreferrer noopener">Zavi</a> — the change behind this prototype ships as a real pull request.</footer>
${
  hasBefore
    ? `<script>function show(w){var b=document.getElementById('frame-before'),a=document.getElementById('frame-after');var bb=document.getElementById('btn-before'),ba=document.getElementById('btn-after');var isB=w==='before';b.classList.toggle('hidden',!isB);a.classList.toggle('hidden',isB);bb.classList.toggle('active',isB);ba.classList.toggle('active',!isB);}</script>`
    : ""
}
</body></html>`;
}

export function renderWireframeShell(env: HtmlPreview): string {
  const cards = (env.rationale ?? [])
    .map(
      (r) =>
        `<div class="card"><div class="chg">${esc(r.change)}</div><div class="why">${esc(r.why)}</div></div>`,
    )
    .join("");
  const frame = `<iframe id="frame-wf" class="proto" sandbox="allow-scripts" srcdoc="${esc(env.html)}" title="wireframe"></iframe>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, noarchive, nofollow">
<title>${esc(env.title)} — Zavi wireframe</title>
<style>
  :root{color-scheme:light}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f6f7fb;color:#111827}
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 20px;background:#fff;border-bottom:1px solid #e5e7eb;position:sticky;top:0}
  .logo{font-weight:800;font-size:15px;letter-spacing:.3px}
  .label{font-size:12px;padding:3px 10px;border-radius:999px;background:#eef2ff;color:#4338ca;font-weight:600}
  main{max-width:1100px;margin:0 auto;padding:20px}
  h1{font-size:20px;margin:6px 0 2px}
  .summary{color:#4b5563;font-size:14px;margin:0 0 14px}
  .note{font-size:11px;color:#9ca3af;margin:4px 0 10px}
  .proto{width:100%;height:72vh;border:1px solid #e5e7eb;border-radius:12px;background:#fff}
  .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin:18px 0}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:12px 14px}
  .chg{font-weight:700;font-size:13px;margin-bottom:4px}
  .why{font-size:13px;color:#4b5563;line-height:1.45}
  footer{text-align:center;font-size:12px;color:#9ca3af;padding:24px}
  footer a{color:#4f46e5;text-decoration:none;font-weight:600}
</style></head>
<body>
<header>
  <span class="logo">Zavi</span>
  <span class="label">Interactive wireframe — simulated data, not the live app</span>
</header>
<main>
  <h1>${esc(env.title)}</h1>
  <p class="summary">${esc(env.summary)}</p>
  <p class="note">This is a clickable prototype built to feel the flow. The data shown is illustrative, not your real data.</p>
  ${frame}
  ${cards ? `<div class="cards">${cards}</div>` : ""}
</main>
<footer>Generated by <a href="https://www.zaviagent.com" rel="noreferrer noopener">Zavi</a></footer>
</body></html>`;
}

export function renderDocShell(env: HtmlPreview): string {
  const frame = `<iframe id="frame-doc" class="doc" sandbox="allow-same-origin" srcdoc="${esc(env.html)}" title="document"></iframe>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, noarchive, nofollow">
<title>${esc(env.title)}</title>
<style>
  html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#FBFCFD;color:#191919}
  body{display:flex;flex-direction:column}
  header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 18px;background:#fff;border-bottom:1px solid #e5e7eb;flex:0 0 auto}
  .name{font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60vw}
  .label{font-size:11px;padding:2px 9px;border-radius:999px;background:#eef2ff;color:#4338ca;font-weight:600}
  .doc{flex:1 1 auto;width:100%;border:0;background:#FBFCFD;display:block}
  footer{flex:0 0 auto;text-align:center;font-size:11px;color:#9ca3af;padding:8px}
</style></head>
<body>
<header><span class="name">${esc(env.title)}</span><span class="label">Document</span></header>
${frame}
<footer>Anyone with this link can open this page.</footer>
</body></html>`;
}

export function renderDeckShell(env: HtmlPreview): string {
  const frame = `<iframe id="frame-deck" class="deck" sandbox="allow-scripts" srcdoc="${esc(env.html)}" title="slide deck"></iframe>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, noarchive, nofollow">
<title>${esc(env.title)}</title>
<style>
  :root{color-scheme:light}
  html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    background:#EFEDE7;color:#191919}
  body{display:flex;flex-direction:column}
  header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 18px;background:#fff;
    border-bottom:1px solid #e5e7eb;flex:0 0 auto}
  .name{font-weight:700;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60vw}
  .label{font-size:11px;padding:2px 9px;border-radius:999px;background:#eef2ff;color:#4338ca;font-weight:600}
  .deck{flex:1 1 auto;width:100%;border:0;background:#EFEDE7;display:block}
  footer{flex:0 0 auto;text-align:center;font-size:11px;color:#9ca3af;padding:8px}
  footer a{color:#4f46e5;text-decoration:none;font-weight:600}
</style></head>
<body>
<header>
  <span class="name">${esc(env.title)}</span>
  <span class="label">Slide deck</span>
</header>
${frame}
<footer>Generated by <a href="https://www.zaviagent.com" rel="noreferrer noopener">Zavi</a></footer>
</body></html>`;
}

export const SHARED_PAGE_SHELL_CSP = "frame-ancestors 'none'; frame-src 'none'";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, e: string) => ENTITIES[e]);

export function sharedPageDescription(html: string, max = 150): string {
  const bodyAt = html.search(/<body[\s>]/i);
  const head = html.slice(0, bodyAt >= 0 ? Math.min(bodyAt, 20_000) : 20_000);
  const meta = scrubHtml(head, false).match(/<meta\s+name=["']description["']\s+content=(?:"([^"]*)"|'([^']*)')/i);
  const from = bodyAt >= 0 ? bodyAt : 0;
  const raw = meta ? decode(meta[1] ?? meta[2] ?? "") : decode(scrubHtml(html.slice(from, from + 20_000), true));
  const t = raw.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}\u2026`;
}

function scrubHtml(html: string, text: boolean): string {
  const lower = html.toLowerCase();
  let out = "";
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    const gt = html.indexOf(">", lt);
    if (gt < 0) break;
    const name = /^<([a-z]+)/.exec(lower.slice(lt, lt + 12))?.[1];
    if (name && /^(script|style|svg|template|noscript)$/.test(name)) {
      let close = lower.indexOf(`</${name}`, gt);
      while (close >= 0 && !/[ \t\n\f\r/>]/.test(lower[close + name.length + 2] ?? "")) {
        close = lower.indexOf(`</${name}`, close + 1);
      }
      if (close < 0) break;
      const end = lower.indexOf(">", close);
      if (end < 0) break;
      out += " ";
      i = end + 1;
    } else {
      out += text ? " " : html.slice(lt, gt + 1);
      i = gt + 1;
    }
  }
  return out;
}

const SIGNUP_URL = "https://www.zaviagent.com/signup?utm_source=shared_report";

export function renderSharedPageShell(title: string, html: string): string {
  const page = html.replace(/<!--zavi-report:[^>]{0,120}-->/g, "");
  const description = sharedPageDescription(page);
  const frame = `<iframe id="frame-page" class="page" sandbox="allow-scripts" srcdoc="${esc(hardenPageHtml(page))}" title="${esc(title)}"></iframe>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, noarchive, nofollow">
<title>${esc(title)}</title>
<meta property="og:title" content="${esc(title)}">
${description ? `<meta property="og:description" content="${esc(description)}">\n<meta name="description" content="${esc(description)}">\n` : ""}<meta property="og:type" content="article">
<meta property="og:site_name" content="Zavi">
<meta name="twitter:card" content="summary">
<style>
  html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#F7F6F3;color:#191919}
  body{display:flex;flex-direction:column}
  .page{flex:1 1 auto;width:100%;border:0;display:block;background:#fff}
  footer{flex:0 0 auto;display:flex;justify-content:center;gap:6px;flex-wrap:wrap;font-size:11.5px;color:#787268;padding:8px 16px;border-top:1px solid #E2DFD7}
  footer a{color:#191919;font-weight:600;text-decoration:none}
  @media (prefers-color-scheme:dark){html,body{background:#141413;color:#EDEBE6}footer{color:#9A948A;border-color:#34322E}footer a{color:#EDEBE6}}
</style></head>
<body>
${frame}
<footer><span>Anyone with this link can open this page.</span><span>Made with <a href="${SIGNUP_URL}" rel="noreferrer noopener" target="_blank">Zavi</a></span></footer>
</body></html>`;
}

async function publicSharedPage(
  sb: ReturnType<typeof serviceClient>,
  slug: string,
): Promise<{ title: string; html: string } | null> {
  const { data: rows } = await sb.rpc("get_public_shared_page", { p_slug: slug });
  const row = (Array.isArray(rows) ? rows[0] : rows) as
    | { tenant_id: string; title: string; storage_path: string }
    | null
    | undefined;
  if (!row) return null;
  if (
    !row.storage_path.startsWith(`${row.tenant_id}/`) ||
    !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.html$/.test(row.storage_path)
  ) {
    return null;
  }
  const { data: blob, error } = await sb.storage.from(SHARED_PAGES_BUCKET).download(row.storage_path);
  if (error || !blob) return null;
  return { title: row.title, html: await blob.text() };
}

export async function publicPrototypePage(req: Request, res: Response): Promise<void> {
  res.setHeader("X-Robots-Tag", "noindex, noarchive");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");

  const slug = String(req.params.slug ?? "");
  if (!SLUG_RE.test(slug)) {
    res.status(404).send("Not found");
    return;
  }
  const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.ip || "?";
  if (rateLimited(ip)) {
    res.status(429).send("Too many requests");
    return;
  }

  const sb = serviceClient();
  const { data: rows } = await sb.rpc("get_prototype_link_by_slug", { p_slug: slug });
  const row = Array.isArray(rows) ? rows[0] : rows;
  const link = row as
    | { id: string; run_id: string; artifact_path: string }
    | null
    | undefined;
  if (!link) {
    const page = await publicSharedPage(sb, slug);
    if (page) {
      res.setHeader("Content-Security-Policy", SHARED_PAGE_SHELL_CSP);
      res.status(200).type("html").send(renderSharedPageShell(page.title, page.html));
      return;
    }
  }
  if (!link || !link.artifact_path || link.artifact_path === "pending") {
    res.status(404).send("Not found");
    return;
  }

  if (!/^[0-9a-f-]{36}\/envelope\.json$/.test(link.artifact_path)) {
    res.status(404).send("Not found");
    return;
  }
  const { data: blob, error } = await sb.storage
    .from(PROTOTYPE_BUCKET)
    .download(link.artifact_path);
  if (error || !blob) {
    res.status(404).send("Not found");
    return;
  }

  let env: HtmlPreview;
  try {
    const parsed = htmlPreviewSchema.safeParse(JSON.parse(await blob.text()));
    if (!parsed.success) throw new Error("envelope invalid");
    env = parsed.data;
  } catch {
    res.status(404).send("Not found");
    return;
  }

  if (env.variant === "wireframe") {
    res.status(200).type("html").send(renderWireframeShell(env));
    return;
  }
  if (env.variant === "doc") {
    res.status(200).type("html").send(renderDocShell(env));
    return;
  }
  if (env.variant === "deck") {
    res.status(200).type("html").send(renderDeckShell(env));
    return;
  }

  const pr = await livePrState(link.run_id);
  res.status(200).type("html").send(renderShell(env, pr));
}

export async function getPrototypeLinkForRun(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const runId = String(req.params.runId ?? "");
  if (!runId) {
    res.status(400).json({ error: { code: "bad_run_id" } });
    return;
  }
  if (!(await shareablePreviewEnabled(auth.tenant_id))) {
    res.status(200).json({ status: "none" });
    return;
  }
  const { data } = await serviceClient()
    .from("engineer_prototype_links")
    .select("tenant_id, slug, status, expires_at, revoked_at")
    .eq("run_id", runId)
    .maybeSingle<{
      tenant_id: string;
      slug: string;
      status: string;
      expires_at: string;
      revoked_at: string | null;
    }>();
  if (!data || data.tenant_id !== auth.tenant_id) {
    res.status(200).json({ status: "none" });
    return;
  }
  const expired = new Date(data.expires_at).getTime() < Date.now();
  const status =
    data.status !== "published" ? data.status : expired ? "expired" : "published";
  res.status(200).json({
    status,
    ...(status === "published" ? { url: `${prototypeLinkBaseUrl()}/${data.slug}` } : {}),
  });
}

export async function revokePrototypeLink(req: Request, res: Response): Promise<void> {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const runId = String(req.params.runId ?? "");
  if (!runId) {
    res.status(400).json({ error: { code: "bad_run_id" } });
    return;
  }
  const { data, error } = await serviceClient()
    .from("engineer_prototype_links")
    .select("tenant_id")
    .eq("run_id", runId)
    .maybeSingle<{ tenant_id: string }>();
  if (!data || data.tenant_id !== auth.tenant_id) {
    res.status(404).json({ error: { code: "not_found" } });
    return;
  }
  const { error: updErr } = await serviceClient()
    .from("engineer_prototype_links")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("run_id", runId)
    .eq("tenant_id", auth.tenant_id);
  if (error || updErr) {
    res.status(500).json({ error: { code: "revoke_failed" } });
    return;
  }
  res.status(200).json({ status: "revoked" });
}
