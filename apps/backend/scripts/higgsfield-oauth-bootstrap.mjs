#!/usr/bin/env node

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = resolve(HERE, "..", ".env");
const AS = "https://mcp.higgsfield.ai";
const MCP_URL = `${AS}/mcp`;
const PORT = Number(process.env.HF_OAUTH_PORT || 4571);
const REDIRECT = `http://localhost:${PORT}/callback`;

const b64url = (buf) => buf.toString("base64url");
const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)} (len ${s.length})` : "<empty>");

async function jsonFetch(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) throw new Error(`${url} -> ${res.status}: ${String(text).slice(0, 300)}`);
  return body;
}

async function discover() {
  const meta = await jsonFetch(`${AS}/.well-known/oauth-authorization-server`);
  for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
    if (!meta[k]) throw new Error(`authorization server metadata is missing ${k}`);
  }
  return meta;
}

function existingClient() {
  const clientId = readEnvKey("HIGGSFIELD_OAUTH_CLIENT_ID");
  if (!clientId) return null;
  const clientSecret = readEnvKey("HIGGSFIELD_OAUTH_CLIENT_SECRET");
  return { client_id: clientId, client_secret: clientSecret || undefined, reused: true };
}

async function register(meta) {
  const reg = await jsonFetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Zavi (platform)",
      redirect_uris: [REDIRECT],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
      scope: "openid email offline_access",
    }),
  });
  if (!reg.client_id) throw new Error("registration returned no client_id");
  return reg;
}

function awaitCode(expectedState) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<html><body style="font:16px system-ui;padding:3rem">
         <h2>${err ? "Authorization failed" : "Connected."}</h2>
         <p>${err ? String(err) : "You can close this tab and return to the terminal."}</p>
         </body></html>`,
      );
      server.close();
      if (err) return reject(new Error(`authorization failed: ${err}`));
      if (!code) return reject(new Error("callback carried no code"));
      if (state !== expectedState) return reject(new Error("state mismatch — aborting"));
      resolvePromise(code);
    });
    server.listen(PORT, () => {});
    server.on("error", reject);
    setTimeout(() => {
      server.close();
      reject(new Error("timed out after 5 minutes waiting for the browser redirect"));
    }, 5 * 60_000);
  });
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken, persist }) {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  if (clientSecret) form.set("client_secret", clientSecret);

  const meta = await discover();
  const tok = await jsonFetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (tok.refresh_token && tok.refresh_token !== refreshToken) {
    if (typeof persist === "function") await persist(tok.refresh_token);
    else writeEnv({ HIGGSFIELD_OAUTH_REFRESH_TOKEN: tok.refresh_token });
  }
  return tok;
}

async function probeBalance(accessToken) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "balance", arguments: {} },
  };
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text: text.slice(0, 600) };
}

function writeEnv(pairs) {
  let src = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8") : "";
  for (const [k, v] of Object.entries(pairs)) {
    if (!v) continue;
    const line = `${k}=${v}`;
    const re = new RegExp(`^${k}=.*$`, "m");
    src = re.test(src) ? src.replace(re, line) : `${src.replace(/\n*$/, "\n")}${line}\n`;
  }
  writeFileSync(ENV_PATH, src, { mode: 0o600 });
}

function readEnvKey(key) {
  if (!existsSync(ENV_PATH)) return "";
  const m = readFileSync(ENV_PATH, "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : "";
}

async function refreshMode() {
  if (!process.argv.includes("--force")) {
    console.error(
      [
        "REFUSED: --refresh consumes the refresh token PRODUCTION is using.",
        "",
        "  The server rotates on every use and revokes the old value. If prod then",
        "  replays the spent token, the whole token family is revoked and image",
        "  generation stops until someone re-authorizes in a browser.",
        "",
        "  Want the balance or recent jobs? Use the Higgsfield web UI.",
        "  Genuinely need a local token and accept taking prod down: --refresh --force",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.error("WARNING: --force given. This consumes the token production uses.\n");
  const clientId = readEnvKey("HIGGSFIELD_OAUTH_CLIENT_ID");
  const clientSecret = readEnvKey("HIGGSFIELD_OAUTH_CLIENT_SECRET");
  const refreshToken = readEnvKey("HIGGSFIELD_OAUTH_REFRESH_TOKEN");
  if (!clientId || !refreshToken) {
    console.error("missing HIGGSFIELD_OAUTH_CLIENT_ID / _REFRESH_TOKEN in .env — run without --refresh first");
    process.exit(1);
  }
  const tok = await refreshAccessToken({ clientId, clientSecret, refreshToken });
  process.stdout.write(tok.access_token || "");
}

async function seedMode() {
  const refreshToken = readEnvKey("HIGGSFIELD_OAUTH_REFRESH_TOKEN");
  if (!refreshToken) {
    console.error("no HIGGSFIELD_OAUTH_REFRESH_TOKEN in .env — run without --seed first to authorize");
    process.exit(1);
  }
  const url = readEnvKey("SUPABASE_URL");
  const key = readEnvKey("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env");
    process.exit(1);
  }

  const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/set_platform_secret`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      p_key: "higgsfield.oauth.refresh_token",
      p_value: refreshToken,
      p_meta: { seeded_at: new Date().toISOString(), seeded_by: "higgsfield-oauth-bootstrap" },
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`seed failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    if (text.includes("PGRST202")) {
      console.error("  -> the migration has not been applied yet; deploy first, then re-run --seed.");
    }
    process.exit(1);
  }
  console.log(`seeded higgsfield.oauth.refresh_token into platform_secrets (${mask(refreshToken)})`);
  console.log("the backend mints from this and rotates it in place from now on.");
}

async function main() {
  if (process.argv.includes("--refresh")) return refreshMode();
  if (process.argv.includes("--seed")) return seedMode();
  console.log("Higgsfield platform OAuth bootstrap\n");

  const meta = await discover();
  console.log(`  authorization server : ${meta.issuer || AS}`);

  const forceNew = process.argv.includes("--new-client");
  const reg = (!forceNew && existingClient()) || (await register(meta));
  if (reg.reused) {
    console.log(`  reusing client       : ${mask(reg.client_id)}  (already in .env + Secrets Manager)`);
    console.log("                         -> no Secrets Manager change needed after this run.");
  } else {
    console.log(`  registered NEW client: ${mask(reg.client_id)}`);
    console.log("                         -> you MUST mirror this id/secret into Secrets Manager,");
    console.log("                            or prod will authenticate as the wrong client.");
  }

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));

  const authUrl = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: reg.client_id,
    redirect_uri: REDIRECT,
    scope: "openid email offline_access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    prompt: "consent",
    resource: MCP_URL,
  })) {
    authUrl.searchParams.set(k, v);
  }

  console.log("\n  Open this in your browser and approve:\n");
  console.log(`  ${authUrl.toString()}\n`);
  console.log(`  Waiting on ${REDIRECT} …`);

  const code = await awaitCode(state);
  console.log("  got authorization code\n");

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: reg.client_id,
    code_verifier: verifier,
  });
  if (reg.client_secret) form.set("client_secret", reg.client_secret);

  const tok = await jsonFetch(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (!tok.access_token) throw new Error("token response carried no access_token");
  console.log(`  access_token  : ${mask(tok.access_token)}`);
  console.log(`  refresh_token : ${tok.refresh_token ? mask(tok.refresh_token) : "NONE RETURNED"}`);
  console.log(`  expires_in    : ${tok.expires_in ?? "unstated"}s`);

  if (!tok.refresh_token) {
    console.log(
      "\n  WARNING: no refresh token. The credential will expire and generation will\n" +
        "  break again. Do not ship this as a platform credential until a refresh\n" +
        "  token is issued (check that offline_access was actually granted).",
    );
  }

  console.log("\n  Probing MCP `balance` with the minted token …");
  const probe = await probeBalance(tok.access_token);
  console.log(`  HTTP ${probe.status}`);
  console.log(`  ${probe.text}\n`);

  writeEnv({
    HIGGSFIELD_OAUTH_CLIENT_ID: reg.client_id,
    HIGGSFIELD_OAUTH_CLIENT_SECRET: reg.client_secret,
    HIGGSFIELD_OAUTH_REFRESH_TOKEN: tok.refresh_token,
  });
  console.log(`  wrote credentials to ${ENV_PATH} (values masked above, never printed)`);
  console.log(
    "\n  Next steps, in order:\n" +
      "    1. Deploy, so migration 20260914090000_platform_secrets applies.\n" +
      "    2. node apps/backend/scripts/higgsfield-oauth-bootstrap.mjs --seed\n" +
      "       The backend reads the ROTATING refresh token from platform_secrets,\n" +
      "       NOT from the environment — a container cannot rewrite its own env, so\n" +
      "       an env-var copy would work once and then fail closed. Skipping this\n" +
      "       step leaves the MCP rail unconfigured and generation silently falls\n" +
      "       back to the empty Developer-API wallet.\n" +
      "    3. Mirror ONLY HIGGSFIELD_OAUTH_CLIENT_ID and _CLIENT_SECRET (the static\n" +
      "       half) into AWS Secrets Manager `praxis-envprod-1`, then restart the\n" +
      "       container — Secrets Manager does not push.",
  );
}

main().catch((e) => {
  console.error(`\nFAILED: ${e.message}`);
  process.exit(1);
});
