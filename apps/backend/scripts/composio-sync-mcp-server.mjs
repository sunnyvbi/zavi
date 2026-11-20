#!/usr/bin/env node

import { railFor } from "@zavi/shared";

const BASE = "https://backend.composio.dev";
const APPLY = process.argv.includes("--apply");

function need(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`${name} missing (run with --env-file=.env from apps/backend)`);
    process.exit(1);
  }
  return v;
}
const KEY = need("COMPOSIO_API_KEY");
const SERVER = need("COMPOSIO_MCP_SERVER_ID");
const CONFIGS = need("COMPOSIO_AUTH_CONFIGS");

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "x-api-key": KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]} HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function toolSlugs(toolkit) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 20; i++) {
    const qs = new URLSearchParams({ toolkit_slug: toolkit, limit: "1000", ...(cursor ? { cursor } : {}) });
    const j = await call("GET", `/api/v3/tools?${qs}`);
    for (const t of j.items ?? []) if (typeof t.slug === "string") out.push(t.slug);
    cursor = j.next_cursor ?? null;
    if (!cursor) return out;
  }
  throw new Error(`tool listing for ${toolkit} truncated (page cap hit): aborting, nothing patched`);
}

const pairs = [];
for (const pair of CONFIGS.split(",")) {
  const eq = pair.indexOf("=");
  if (eq <= 0) continue;
  const toolkit = pair.slice(0, eq).trim().toLowerCase();
  const id = pair.slice(eq + 1).trim();
  if (toolkit && id) pairs.push({ toolkit, id });
}

const sid = encodeURIComponent(SERVER);
const cur = await call("GET", `/api/v3.1/mcp/${sid}`);
const ids = Array.isArray(cur.auth_config_ids) ? cur.auth_config_ids : [];
const kits = Array.isArray(cur.toolkits) ? cur.toolkits : [];
const tools = Array.isArray(cur.allowed_tools) ? cur.allowed_tools : [];
if (tools.length === 0) {
  console.error("server allowed_tools is empty/missing: refusing to patch (semantics unverified)");
  process.exit(1);
}

const nextIds = [...ids];
const nextKits = [...kits];
const have = new Set(tools);
const nextTools = [...tools];
const skipped = [];
console.log(`server ${SERVER}: ${ids.length} auth configs, ${kits.length} toolkits, ${tools.length} tools`);
for (const { toolkit, id } of pairs) {
  if (railFor(toolkit) !== "composio") {
    skipped.push(toolkit);
    continue;
  }
  const slugs = await toolSlugs(toolkit);
  const missing = slugs.filter((t) => !have.has(t));
  for (const t of missing) { have.add(t); nextTools.push(t); }
  const addId = !nextIds.includes(id);
  const addKit = !nextKits.includes(toolkit);
  if (addId) nextIds.push(id);
  if (addKit) nextKits.push(toolkit);
  console.log(
    `  ${toolkit.padEnd(24)} tools ${String(slugs.length).padStart(4)}  +${String(missing.length).padStart(4)} new` +
      `${addId ? "  +auth_config" : ""}${addKit ? "  +toolkit" : ""}`,
  );
}
if (skipped.length) console.log(`skipped (native rail): ${skipped.join(", ")}`);

const changed = nextIds.length !== ids.length || nextKits.length !== kits.length || nextTools.length !== tools.length;
console.log(
  `union: auth configs ${ids.length} -> ${nextIds.length}, toolkits ${kits.length} -> ${nextKits.length}, ` +
    `tools ${tools.length} -> ${nextTools.length}`,
);
if (!changed) {
  console.log("nothing to add.");
} else if (!APPLY) {
  console.log("dry-run: nothing sent. Re-run with --apply to PATCH the full union.");
} else {
  const body = { auth_config_ids: nextIds, toolkits: nextKits, allowed_tools: nextTools };
  try {
    await call("PATCH", `/api/v3.1/mcp/${sid}`, body);
  } catch (e) {
    const m = String(e.message).match(/Invalid tools provided for MCP server[^:]*:\s*(.+?)"\}/s);
    if (!m) throw e;
    const invalid = new Set(m[1].split(".")[0].split(",").map((t) => t.trim()).filter((t) => /^[A-Z0-9_]+$/.test(t)));
    body.allowed_tools = nextTools.filter((t) => !invalid.has(t));
    console.log(`dropping ${invalid.size} tools Composio's MCP server refuses; retrying`);
    await call("PATCH", `/api/v3.1/mcp/${sid}`, body);
  }
  console.log(`patched: ${body.auth_config_ids.length} auth configs, ${body.toolkits.length} toolkits, ${body.allowed_tools.length} tools.`);
}
