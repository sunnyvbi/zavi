
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountCall, resolveEmailTool } from "@/services/connectors/email-campaign/account";
import { runContentProbe } from "@/services/connectors/email-campaign/content-probe";
import { EMAIL_PROVIDERS, isEmailTool } from "@/services/connectors/email-campaign/providers";

async function main(): Promise<void> {
  const tenantId = process.env.PROBE_TENANT_ID ?? "";
  const tool = process.env.PROBE_TOOL ?? "";
  const listId = process.env.PROBE_LIST_ID ?? "";
  if (!tenantId || !isEmailTool(tool) || !listId) {
    console.error("set PROBE_TENANT_ID, PROBE_TOOL (mailchimp|klaviyo|sendgrid) and PROBE_LIST_ID");
    process.exit(2);
  }
  const account = await resolveEmailTool(tenantId, tool);
  const call = accountCall(account);
  const fixture = await runContentProbe(tool, {
    call,
    create: (t) =>
      EMAIL_PROVIDERS[t].createCampaign(call, {
        title: `Zavi content probe ${Date.now()}`,
        audience_id: listId,
        subject: "Zavi content probe",
        preview_text: null,
        from_name: "Zavi probe",
        from_email: "probe@example.test",
        reply_to: null,
        sender_id: process.env.PROBE_SENDER_ID ?? null,
        suppression_group_id: process.env.PROBE_GROUP_ID ?? null,
      }),
    remove: async (t, id) => {
      const slug = t === "mailchimp" ? "MAILCHIMP_DELETE_CAMPAIGN" : t === "klaviyo" ? "KLAVIYO_DELETE_CAMPAIGN" : "SENDGRID_DELETE_SINGLE_SEND";
      const args = t === "mailchimp" ? { campaign_id: id } : { id };
      const r = await call(slug, args);
      if (!r.ok) console.warn(`could not delete the probe draft ${id}: delete it in ${t} by hand`);
    },
  });
  const dir = join(__dirname, "../src/services/connectors/email-campaign/__fixtures__");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `content-probe-${tool}.json`);
  writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(`${tool}: ${fixture.verdict.status}; fixture written to ${out}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
