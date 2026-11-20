#!/usr/bin/env node

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

function envFromDotenv() {
  try {
    const txt = readFileSync(join(__dir, "..", ".env"), "utf8");
    const get = (k) => (txt.match(new RegExp(`^${k}=(.*)$`, "m")) || [])[1]?.trim();
    return { url: get("SUPABASE_URL"), key: get("SUPABASE_SERVICE_ROLE_KEY") };
  } catch {
    return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  }
}

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const tenant = arg("tenant");
  const domain = arg("domain");
  const agents = (arg("agents", "operator") || "").split(",").map((s) => s.trim()).filter(Boolean);
  const fromAddr = arg("from", null);
  const fromName = arg("from-name", null);
  if (!tenant || !domain || agents.length === 0) {
    console.error("usage: --tenant <uuid> --domain <d> --agents a,b [--from x] [--from-name y]");
    process.exit(1);
  }
  const { url, key } = envFromDotenv();
  if (!url || !key) {
    console.error("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { data: dom, error: dErr } = await sb
    .from("tenant_inbox_domain")
    .upsert({ tenant_id: tenant, domain, status: "active" }, { onConflict: "domain" })
    .select("id")
    .single();
  if (dErr) {
    console.error("domain upsert failed:", dErr.message);
    process.exit(1);
  }
  console.log(`✓ domain ${domain} → ${dom.id}`);

  for (const slug of agents) {
    const local = slug;
    const reply_to = `${local}@${domain}`;
    const { error: iErr } = await sb
      .from("tenant_agent_email_identity")
      .upsert(
        {
          tenant_id: tenant,
          agent_slug: slug,
          domain_id: dom.id,
          local_part: local,
          reply_to_address: reply_to,
          from_address: fromAddr,
          from_name: fromName,
          status: "active",
        },
        { onConflict: "domain_id,local_part" },
      );
    if (iErr) {
      console.error(`identity ${reply_to} failed:`, iErr.message);
      process.exit(1);
    }
    console.log(`✓ identity ${slug} → ${reply_to}`);
  }
  console.log("done. inbound to these addresses now resolves to this tenant.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
