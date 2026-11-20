
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const authPath = path.join(os.homedir(), ".codex", "auth.json");
const envPath = path.join(__dirname, "..", ".env");

type AuthJson = {
  tokens?: { access_token?: string; account_id?: string };
};

function main() {
  if (!fs.existsSync(authPath)) {
    console.error(`No ${authPath} — run: npm install -g @openai/codex && codex login`);
    process.exit(1);
  }

  const auth = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthJson;
  const token = auth.tokens?.access_token?.trim();
  const accountId = auth.tokens?.account_id?.trim();
  if (!token || !accountId) {
    console.error("auth.json missing tokens.access_token or tokens.account_id");
    process.exit(1);
  }

  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  env = env
    .split("\n")
    .filter((l) => !/^CODEX_(ACCESS_TOKEN|ACCOUNT_ID)=/.test(l))
    .join("\n")
    .replace(/\n+$/, "");

  const block = [
    "",
    "# ── Codex subscription (synced from ~/.codex/auth.json) ─────────────────",
    "# Re-sync: npm run sync:codex-env -w @zavi/backend",
    `CODEX_ACCESS_TOKEN=${token}`,
    `CODEX_ACCOUNT_ID=${accountId}`,
    "",
  ].join("\n");

  fs.writeFileSync(envPath, env + block);
  console.log(`Synced CODEX_ACCESS_TOKEN + CODEX_ACCOUNT_ID → ${envPath}`);
}

main();
