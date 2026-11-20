
import type { Request, Response } from "express";
import crypto from "node:crypto";
import { requireStaff } from "@/services/auth/staff-middleware";
import { serviceClient } from "@/services/supabase";

const PLATFORM_ADMIN_TENANT_ID = "00000000-0000-0000-0000-000000000000";

function publicApiOrigin(): string {
  return (process.env.PUBLIC_API_ORIGIN || "https://api.zaviagent.com").trim();
}

function publicWebOrigin(): string {
  return (process.env.WEB_ORIGIN || "https://www.zaviagent.com").split(",")[0].trim();
}

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function buildManifest(): Record<string, unknown> {
  const api = publicApiOrigin();
  const web = publicWebOrigin();
  return {
    name: "Praxis Cofounder",
    url: web,
    description:
      "Zavi is an AI growth agent for your business. Its engineer agent reads operator's repos in an isolated sandbox and proposes minimal-diff PRs.",
    public: true,
    redirect_url: `${api}/api/connectors/github/manifest-callback`,
    callback_urls: [`${api}/api/connectors/github/callback`],
    setup_url: `${api}/api/connectors/github/callback`,
    setup_on_update: true,
    request_oauth_on_install: false,
    hook_attributes: {
      url: `${api}/api/webhooks/github`,
      active: true,
    },
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      metadata: "read",
    },
    default_events: ["pull_request", "push"],
  };
}

export async function githubManifestInit(req: Request, res: Response): Promise<void> {
  const staff = await requireStaff(req, res);
  if (!staff) return;

  const rawState = crypto.randomBytes(32).toString("base64url");
  const stateHash = sha256Hex(rawState);

  const { error } = await serviceClient().rpc("mint_oauth_state", {
    p_provider: "github_manifest",
    p_tenant_id: PLATFORM_ADMIN_TENANT_ID,
    p_user_id: staff.user_id,
    p_state_hash: stateHash,
    p_ttl_seconds: 600,
  });
  if (error) {
    res.status(500).json({ error: { code: "state_mint_failed", message: error.message } });
    return;
  }

  const manifest = JSON.stringify(buildManifest());
  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Praxis · Register GitHub App</title>
<style>
  body { font: 14px/1.5 -apple-system, sans-serif; max-width: 560px; margin: 4rem auto; padding: 0 1rem; color: #0f172a; }
  h1 { font-size: 22px; margin-bottom: 0.5rem; }
  p { color: #475569; }
  button { background: #0369a1; color: #fff; border: none; padding: 0.6rem 1rem; border-radius: 6px; font: inherit; cursor: pointer; }
  button:hover { background: #075985; }
  code { background: #f1f5f9; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 12.5px; }
  .meta { margin-top: 2rem; font-size: 12.5px; color: #64748b; }
</style>
</head><body>
<h1>Register Praxis Cofounder on GitHub</h1>
<p>One click. Manifest is pre-filled with permissions, callbacks, and webhook. After you click Create, GitHub redirects back here with the App credentials.</p>
<form id="f" action="https://github.com/settings/apps/new?state=${encodeURIComponent(rawState)}" method="post">
  <input type="hidden" name="manifest" value='${manifest.replace(/'/g, "&#39;")}'>
  <button type="submit">Create GitHub App →</button>
</form>
<p class="meta">name=<code>Praxis Cofounder</code> · redirect=<code>${publicApiOrigin()}/api/connectors/github/manifest-callback</code> · perms=<code>contents:write, pull_requests:write, metadata:read</code> · events=<code>pull_request, push</code></p>
</body></html>`;

  res.set("content-type", "text/html; charset=utf-8");
  res.set("cache-control", "no-store");
  res.status(200).send(html);
}

export async function githubManifestCallback(req: Request, res: Response): Promise<void> {
  const code = String(req.query.code ?? "");
  const rawState = String(req.query.state ?? "");

  if (!code) {
    res.status(400).json({ error: { code: "missing_code", message: "GitHub did not return ?code=" } });
    return;
  }
  if (!rawState) {
    res.status(400).json({ error: { code: "missing_state", message: "GitHub did not return ?state=" } });
    return;
  }

  const stateHash = sha256Hex(rawState);
  const { data: rows, error: cErr } = await serviceClient().rpc("consume_oauth_state", {
    p_provider: "github_manifest",
    p_state_hash: stateHash,
  });
  if (cErr) {
    res.status(500).json({ error: { code: "state_consume_failed", message: cErr.message } });
    return;
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    res.status(403).json({ error: { code: "invalid_state", message: "OAuth state invalid, expired, or replayed." } });
    return;
  }

  const exchangeRes = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "Zavi/1.0",
      },
    },
  );
  if (!exchangeRes.ok) {
    const text = await exchangeRes.text().catch(() => "");
    res.status(502).json({
      error: {
        code: "manifest_exchange_failed",
        message: `GitHub returned ${exchangeRes.status}: ${text.slice(0, 400)}`,
      },
    });
    return;
  }
  const json = (await exchangeRes.json()) as {
    id: number;
    slug: string;
    webhook_secret: string;
    pem: string;
    html_url: string;
  };

  const installUrl = `${json.html_url}/installations/new`;
  const apiOrigin = publicApiOrigin();
  const webOrigin = publicWebOrigin();
  const html = `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Praxis · GitHub App Created</title>
<style>
  body { font: 14px/1.55 -apple-system, sans-serif; max-width: 720px; margin: 3rem auto; padding: 0 1rem; color: #0f172a; }
  h1 { font-size: 22px; margin-bottom: 0.5rem; }
  h2 { font-size: 16px; margin: 1.75rem 0 0.5rem; }
  p { color: #475569; }
  pre { background: #f1f5f9; padding: 0.75rem 1rem; border-radius: 6px; font-size: 12.5px; line-height: 1.45; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  code { background: #f1f5f9; padding: 0.1rem 0.3rem; border-radius: 3px; font-size: 12.5px; }
  .warn { background: #fef3c7; border: 1px solid #fcd34d; padding: 0.75rem 1rem; border-radius: 6px; color: #78350f; font-size: 13px; }
  .ok { background: #dcfce7; border: 1px solid #86efac; padding: 0.75rem 1rem; border-radius: 6px; color: #14532d; font-size: 13px; margin-bottom: 1.5rem; }
  a { color: #0369a1; }
  button { background: #0f172a; color: #fff; border: none; padding: 0.4rem 0.7rem; border-radius: 4px; font: inherit; cursor: pointer; font-size: 11.5px; margin-top: 0.5rem; }
  button:hover { background: #1e293b; }
</style>
</head><body>
<div class="ok">App registered ✓ — id <code>${json.id}</code>, slug <code>${json.slug}</code>.</div>

<h1>Two more steps (~3 min)</h1>

<h2>1. Paste these 4 values into AWS Secrets Manager</h2>
<p>Region <code>us-west-1</code>, secret <code>praxis-envprod-1</code>:</p>
<pre id="env">GITHUB_APP_ID=${json.id}
GITHUB_APP_SLUG=${json.slug}
GITHUB_APP_WEBHOOK_SECRET=${json.webhook_secret}
GITHUB_APP_PRIVATE_KEY=${JSON.stringify(json.pem)}</pre>
<button onclick="navigator.clipboard.writeText(document.getElementById('env').innerText); this.textContent='Copied ✓'">Copy all</button>

<div class="warn" style="margin-top:1rem;">
  This page won't show these credentials again — state nonce is consumed, refresh = blank. If you lose them, delete the App at <a href="${json.html_url}">${json.html_url}</a> and re-run /api/connectors/github/manifest-init.
</div>

<h2>2. Restart the backend so it picks up the new env</h2>
<pre>ssh ubuntu@184.169.192.250 'docker restart praxis-backend'   # API host
ssh ubuntu@54.241.199.146 'docker restart praxis-backend'   # worker host</pre>

<h2>3. Install the App on a repo</h2>
<p><a href="${installUrl}">${installUrl}</a> — pick the repos engineer should reach (e.g. <code>rravi149/zavi</code> for self-dogfood).</p>

<h2>4. Trigger engineer</h2>
<p>Go to <a href="${webOrigin}/agents/engineer">${webOrigin}/agents/engineer</a>, type a task, click Run.</p>

<p style="margin-top:2rem;font-size:12.5px;color:#94a3b8;">Endpoint: <code>${apiOrigin}/api/connectors/github/manifest-callback</code></p>
</body></html>`;

  res.set("content-type", "text/html; charset=utf-8");
  res.set("cache-control", "no-store");
  res.status(200).send(html);
}
