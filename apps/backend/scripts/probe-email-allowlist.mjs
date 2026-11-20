#!/usr/bin/env node

import crypto from "node:crypto";

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const TO = arg("to");
const FROM = arg("from", "nobody@example-partner.com");
const URL_ = arg("url", "http://localhost:3001/api/webhooks/email");
const ONLY = arg("case", "all");
const SECRET = process.env.EMAIL_WEBHOOK_SECRET;

if (!TO) {
  console.error("--to <handle>@inbox.zaviagent.com is required (see Settings -> Email)");
  process.exit(1);
}
if (!SECRET) {
  console.error("EMAIL_WEBHOOK_SECRET not set. Run with: node --env-file=.env scripts/probe-email-allowlist.mjs ...");
  process.exit(1);
}

const fromDomain = FROM.split("@")[1];

const cfAr = (headerFrom, dkimD) =>
  `mx.cloudflare.net; dkim=pass header.d=${dkimD} header.s=20251104 header.b=Xxxx; ` +
  `dmarc=pass header.from=${headerFrom} policy.dmarc=none; ` +
  `spf=pass (mx.cloudflare.net: domain of ${FROM} designates 1.2.3.4 as permitted sender) ` +
  `smtp.mailfrom=${FROM}; arc=none`;

const CASES = {
  allowlisted: {
    why: "authentic outsider; passes ONLY if you added them in Settings -> Email",
    from: FROM,
    auth_results: cfAr(fromDomain, fromDomain),
    expect: "ok (once allowlisted) / sender_not_allowlisted (before)",
  },

  p0a_unaligned_dmarc: {
    why: "P0-A: real dmarc=pass, but for a DIFFERENT domain than the From",
    from: "ravi@upcar.ai",
    auth_results: "mx.cloudflare.net; dkim=pass header.d=evil.com; dmarc=pass header.from=evil.com",
    expect: "sender_unauthenticated",
  },

  p0b_forged_verdict: {
    why: "P0-B: attacker-authored verdict; no trusted auth_results field",
    from: "ravi@upcar.ai",
    auth_results: null,
    headers: { "authentication-results": ["mx.evil.com; dmarc=pass header.from=upcar.ai"] },
    expect: "sender_unauthenticated (fails closed)",
  },

  spf_only: {
    why: "spf=pass alone must never authenticate a From",
    from: FROM,
    auth_results: `mx.cloudflare.net; spf=pass smtp.mailfrom=${FROM}; dkim=none; dmarc=none`,
    expect: "sender_unauthenticated",
  },

  freemail_wildcard: {
    why: "even a planted gmail.com row grants nothing at match time",
    from: "stranger@gmail.com",
    auth_results: cfAr("gmail.com", "gmail.com"),
    expect: "sender_not_a_member / sender_not_allowlisted",
  },
};

async function post(name, c) {
  const envelope = {
    envelope_to: TO,
    from: c.from,
    envelope_from: c.from,
    auth_results: c.auth_results,
    to: [TO],
    cc: [],
    subject: `probe: ${name}`,
    message_id: `<probe-${crypto.randomUUID()}@example.com>`,
    text: "This is an allowlist gate probe. No agent run should result from a refused case.",
    html: "",
    headers: c.headers ?? {},
    raw_mime_ref: null,
    body_hash: crypto.randomUUID(),
    spam_verdict: "pass",
  };

  const body = JSON.stringify(envelope);
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig =
    "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");

  let res, json;
  try {
    res = await fetch(URL_, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-praxis-email-timestamp": ts,
        "x-praxis-email-signature": sig,
      },
      body,
    });
    json = await res.json().catch(() => ({}));
  } catch (e) {
    console.log(`\n  ${name}\n    ${c.why}\n    ERROR: ${e.message} (is the backend running on ${URL_}?)`);
    return;
  }

  const got = json.ignored ?? (json.ok ? "ok (ACCEPTED -> a run was enqueued)" : JSON.stringify(json));
  console.log(`\n  ${name}`);
  console.log(`    ${c.why}`);
  console.log(`    from:     ${c.from}`);
  console.log(`    expect:   ${c.expect}`);
  console.log(`    GOT:      ${got}`);
}

console.log(`\nProbing ${URL_}\n  inbox: ${TO}`);
for (const [name, c] of Object.entries(CASES)) {
  if (ONLY !== "all" && ONLY !== name) continue;
  await post(name, c);
}
console.log(
  "\nEvery case except `allowlisted` should be REFUSED. If p0a_/p0b_ come back `ok`,\n" +
    "a P0 has been reopened — stop and re-read src/email/sender-auth.ts.\n",
);
