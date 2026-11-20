#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

const SECRET_ID = process.env.PRAXIS_SECRET_ID || "praxis-envprod-1";
const REGION = process.env.AWS_REGION || "us-west-1";
const WRANGLER = ["-y", "wrangler@4.86.0"];
const NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;
export const POOLED_BACKEND_KEYS = [
  "SITE_AUTH_ALIAS_KEY", "SITE_GATEWAY_BROKER_SECRET", "SITE_SIGNER_KEK_PUBLIC_JWK",
  "ZAVI_SITE_GATEWAY_WORKER_NAME", "SITE_AUTH_HOOK_BASE_URL", "SITE_AUTH_BROKER_CALLBACK_URL",
  "SUPABASE_MGMT_TOKEN", "SUPABASE_ORG_ID", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_STATIC_API_TOKEN",
  "CLOUDFLARE_ZONE_ID", "ZAVI_STATIC_R2_BUCKET", "ZAVI_STATIC_KV_NAMESPACE_ID", "ZAVI_STATIC_WORKER_NAME",
];

const die = (m, code = 1) => {
  console.error(m);
  process.exit(code);
};
const rand = () => randomBytes(48).toString("base64url");

function aws(args, input) {
  const r = spawnSync("aws", [...args, "--region", REGION], { input, encoding: "utf8" });
  if (r.status !== 0) die(`aws ${args.slice(0, 2).join(" ")} failed (exit ${r.status}); nothing changed`);
  return r.stdout;
}

function readSecret() {
  const raw = aws(["secretsmanager", "get-secret-value", "--secret-id", SECRET_ID, "--query", "SecretString", "--output", "text"]);
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not an object");
    return obj;
  } catch {
    return die(`${SECRET_ID} is not a JSON object: add keys in the AWS console instead (values never go through this script then).`);
  }
}

function addKeys(add) {
  const cur = readSecret();
  for (const k of Object.keys(add)) {
    if (!NAME_RE.test(k)) die(`bad key name ${k}`);
    if (k in cur) die(`${k} already exists in ${SECRET_ID}: refusing to overwrite (rotate deliberately, by hand).`);
  }
  aws(["secretsmanager", "put-secret-value", "--secret-id", SECRET_ID, "--secret-string", "file:///dev/stdin"], JSON.stringify({ ...cur, ...add }));
  const after = readSecret();
  for (const k of Object.keys(add)) if (after[k] !== add[k]) die(`${k} did not read back from ${SECRET_ID}`);
  console.log(`OK: added ${Object.keys(add).join(", ")} to ${SECRET_ID} (values not shown). Restart/deploy the backend to load them.`);
}

function workerSecret(config, name, value) {
  if (!config || !existsSync(config)) die("--gateway-config <infra/site-gateway/wrangler.local.toml> is required");
  const r = spawnSync("npx", [...WRANGLER, "secret", "put", name, "--config", config], { input: value, stdio: ["pipe", "inherit", "inherit"] });
  if (r.status !== 0) die(`wrangler secret put ${name} failed; nothing else changed`);
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : "";
}

const cmd = process.argv[2];
if (cmd === "plan") {
  const cur = readSecret();
  for (const k of POOLED_BACKEND_KEYS) console.log(`${k in cur ? "present" : "MISSING"}  ${k}`);
  console.log(`SITE_BACKEND_POOLED: ${"SITE_BACKEND_POOLED" in cur ? "present (pooled is OFF only when it is exactly 0)" : "absent (pooled defaults ON)"}`);
} else if (cmd === "broker") {
  if ("SITE_GATEWAY_BROKER_SECRET" in readSecret()) die("SITE_GATEWAY_BROKER_SECRET already exists: refusing (the gateway and backend must hold the SAME value).");
  const v = rand();
  workerSecret(arg("gateway-config"), "BROKER_HMAC_SECRET", v);
  addKeys({ SITE_GATEWAY_BROKER_SECRET: v });
} else if (cmd === "alias") {
  addKeys({ SITE_AUTH_ALIAS_KEY: rand() });
} else if (cmd === "storage-proxy") {
  workerSecret(arg("gateway-config"), "STORAGE_PROXY_SECRET", rand());
  console.log("OK: STORAGE_PROXY_SECRET set on the gateway (value not shown).");
} else if (cmd === "aws-add") {
  const name = process.argv[3] ?? "";
  if (!NAME_RE.test(name)) die("usage: aws-add NAME < value");
  const chunks = [];
  process.stdin.on("data", (c) => chunks.push(c));
  process.stdin.on("end", () => {
    const v = Buffer.concat(chunks).toString("utf8").trim();
    if (!v) die("empty value on stdin");
    if (name === "SITE_SIGNER_KEK_PUBLIC_JWK") {
      const j = JSON.parse(v);
      if ("d" in j) die("that JWK has a private part (d): the backend gets the PUBLIC half only");
    }
    addKeys({ [name]: v });
  });
} else {
  die("usage: pooled-prod-secrets.mjs plan | broker --gateway-config <toml> | alias | storage-proxy --gateway-config <toml> | aws-add NAME < value", 2);
}
