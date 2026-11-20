#!/usr/bin/env node

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const WRANGLER = ["-y", "wrangler@4.86.0"];
const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const ci = args.indexOf("--config");
const config = ci >= 0 ? args[ci + 1] : "";

if (!dry && (!config || !existsSync(config))) {
  console.error("usage: site-signer-kek.mjs --config <signer wrangler.local.toml> | --dry-run");
  process.exit(2);
}

if (!dry) {
  const list = spawnSync("npx", [...WRANGLER, "secret", "list", "--config", config], { encoding: "utf8" });
  if (list.status !== 0) {
    console.error("could not list the signer's secrets (is the signer Worker deployed and wrangler logged in?)");
    process.exit(1);
  }
  if (/"name":\s*"SITE_SIGNER_KEK"/.test(list.stdout) || /\bSITE_SIGNER_KEK\b/.test(list.stdout)) {
    console.error("SITE_SIGNER_KEK already exists on the signer: refusing to replace it (sealed shard keys would stop opening).");
    process.exit(1);
  }
}

const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const kid = `zavi-kek-${day}-${randomBytes(3).toString("hex")}`;
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub = { ...publicKey.export({ format: "jwk" }), kid };

if (!dry) {
  const priv = JSON.stringify({ ...privateKey.export({ format: "jwk" }), kid });
  const put = spawnSync("npx", [...WRANGLER, "secret", "put", "SITE_SIGNER_KEK", "--config", config], {
    input: priv,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (put.status !== 0) {
    console.error("wrangler secret put SITE_SIGNER_KEK failed; nothing else changed");
    process.exit(1);
  }
}

if ("d" in pub) throw new Error("refusing to print a private key");
console.log(dry ? "DRY RUN: nothing was stored. Public half of a throwaway KEK:" : "OK: SITE_SIGNER_KEK set on the signer. Add this PUBLIC JWK to praxis-envprod-1 as SITE_SIGNER_KEK_PUBLIC_JWK:");
console.log(JSON.stringify(pub));
