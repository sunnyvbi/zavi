#!/usr/bin/env node

import crypto from "node:crypto";

const SECRET = process.env.SUPABASE_JWT_SECRET || "";
if (!SECRET) {
  console.error(
    "SUPABASE_JWT_SECRET not set.\n" +
      "Get it: Supabase Dashboard -> Project Settings -> API -> JWT Settings -> JWT Secret,\n" +
      "then: SUPABASE_JWT_SECRET='...' node apps/backend/scripts/mint-self-improve-ci-token.mjs",
  );
  process.exit(1);
}

const b64url = (s) => Buffer.from(s).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const ttlDays = Number(process.env.TTL_DAYS || 365);
if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
  console.error(`TTL_DAYS invalid: ${process.env.TTL_DAYS}`);
  process.exit(1);
}

const header = { alg: "HS256", typ: "JWT" };
const payload = {
  role: "self_improve_ci",
  iss: "supabase",
  iat: now,
  exp: now + ttlDays * 24 * 60 * 60,
};

const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
const sig = crypto.createHmac("sha256", SECRET).update(signingInput).digest("base64url");
const token = `${signingInput}.${sig}`;

process.stdout.write(token + "\n");
console.error(`\n[minted] role=self_improve_ci  exp=+${ttlDays}d`);
console.error('Set it:  gh secret set SELF_IMPROVE_READ_TOKEN --repo rravi149/zavi --body "<paste-token>"');
