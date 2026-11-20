const fs = require("fs");
const path = require("path");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const OUT = process.env.PRAXIS_DOTENV_PATH || path.join("/app/apps/backend", ".env");
const roleSecretId = process.env.PRAXIS_SECRETS_SECRET_ID;
const overlaySecretId = process.env.PRAXIS_SECRETS_OVERLAY_ID || "";

const COMMON_SECRET_MAP = {
  production: "praxis-env-common-prod",
  staging: "praxis-env-common-staging",
};

function jsonToDotenv(obj) {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    const val = typeof v === "object" ? JSON.stringify(v) : String(v);
    lines.push(`${k}=${escapeDotenvValue(val, k)}`);
  }
  return `${lines.join("\n")}\n`;
}

function escapeDotenvValue(val, key = "?") {
  if (val === "") return '""';
  if (val.includes("\r") && !val.includes('"') && !/\\[nr]/.test(val)) {
    return `"${val.replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
  }
  const needsQuotes = /[\n\r#"'`\\]/.test(val) || /^\s/.test(val) || /\s$/.test(val);
  if (!needsQuotes) return val;
  for (const q of ["'", "`"]) {
    if (!val.includes(q)) return `${q}${val}${q}`;
  }
  const lead = /^["'`]/.test(val) ? val[0] : null;
  if (!/[\n\r#]/.test(val) && !/^\s|\s$/.test(val) && (lead === null || val.indexOf(lead, 1) === -1)) return val;
  if (!val.includes('"') && !/\\[nr]/.test(val)) return `"${val}"`;
  console.warn(`docker-load-secrets: ${key} has no exact dotenv form (quotes plus #, newline or \\n); it may be misread`);
  return `"${val.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function parseSecret(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
    }
  }
  const result = {};
  for (const line of raw.split("\n")) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const eqIdx = stripped.indexOf("=");
    if (eqIdx === -1) continue;
    const key = stripped.slice(0, eqIdx).trim();
    let value = stripped.slice(eqIdx + 1);
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

function overlayProblem(role, overlay) {
  const serve = String(overlay.INNGEST_SERVE_HOST || "").replace(/\/+$/, "");
  const sync = String(overlay.INNGEST_SELF_SYNC_URL || "");
  if (!serve || !sync) return "must set INNGEST_SERVE_HOST and INNGEST_SELF_SYNC_URL";
  if (sync !== `${serve}/api/inngest`) return `INNGEST_SELF_SYNC_URL must be ${serve}/api/inngest`;
  const shared = String(role.INNGEST_SERVE_HOST || "").replace(/\/+$/, "");
  if (shared && serve === shared) return "INNGEST_SERVE_HOST is the same as the shared secret's (the API host)";
  return null;
}

function mergeSecretLayers(common, role, overlay) {
  return { ...common, ...role, ...(overlay || {}) };
}

async function fetchSecret(client, secretId) {
  try {
    const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
    return out.SecretString || null;
  } catch (err) {
    if (err.name === "ResourceNotFoundException") return null;
    throw err;
  }
}

async function main() {
  if (!roleSecretId) {
    console.error("docker-load-secrets: PRAXIS_SECRETS_SECRET_ID not set");
    process.exit(1);
  }
  const client = new SecretsManagerClient({});
  const commonEnv = process.env.EXECUTION_ENV || process.env.NODE_ENV;
  const commonSecretId = commonEnv ? COMMON_SECRET_MAP[commonEnv] : null;

  let commonVars = {};
  if (commonSecretId) {
    const commonRaw = await fetchSecret(client, commonSecretId);
    if (commonRaw) {
      commonVars = parseSecret(commonRaw);
      console.log(`docker-load-secrets: common (${commonSecretId}) — ${Object.keys(commonVars).length} vars`);
    } else {
      console.log(`docker-load-secrets: common (${commonSecretId}) not found, skipping`);
    }
  }

  const roleRaw = await fetchSecret(client, roleSecretId);
  if (!roleRaw) {
    console.error(`docker-load-secrets: role secret (${roleSecretId}) has no SecretString`);
    process.exit(1);
  }
  const roleVars = parseSecret(roleRaw);
  console.log(`docker-load-secrets: role (${roleSecretId}) — ${Object.keys(roleVars).length} vars`);

  let overlayVars = {};
  if (overlaySecretId) {
    const overlayRaw = await fetchSecret(client, overlaySecretId);
    if (!overlayRaw) {
      console.error(`docker-load-secrets: overlay secret (${overlaySecretId}) not found or empty`);
      process.exit(1);
    }
    overlayVars = parseSecret(overlayRaw);
    const problem = overlayProblem(roleVars, overlayVars);
    if (problem) {
      console.error(`docker-load-secrets: overlay (${overlaySecretId}) ${problem}`);
      process.exit(1);
    }
    console.log(`docker-load-secrets: overlay (${overlaySecretId}) — ${Object.keys(overlayVars).length} vars`);
  }

  const merged = mergeSecretLayers(commonVars, roleVars, overlayVars);
  const content = jsonToDotenv(merged);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, content, { mode: 0o600 });
  console.log(`docker-load-secrets: wrote ${OUT} — ${Object.keys(merged).length} total vars`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("docker-load-secrets:", err);
    process.exit(1);
  });
}

module.exports = { escapeDotenvValue, jsonToDotenv, parseSecret, mergeSecretLayers, overlayProblem };
