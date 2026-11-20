import { beforeEach, describe, expect, it } from "vitest";
import type { ComposioExecResult } from "@/services/connectors/composio/api";
import { EMAIL_PROVIDERS, resetKlaviyoMetricCache, type ProviderCall } from "../providers";
import { keyRejectedText } from "../provider-errors";
import { KLAVIYO_ACTION_SCOPES, KLAVIYO_KEY_INSTRUCTION, KLAVIYO_KEY_SCOPES } from "../klaviyo-scopes";
import { PLAN_REFUSALS } from "@/services/email-plan/messages";
import { fakeKlaviyo } from "./fake-tools";

const ok = (data: unknown): ComposioExecResult => ({ ok: true, status: 200, data, error: null, outcome_unknown: false });

const AREA: Record<string, string> = { accounts: "Accounts", campaigns: "Campaigns", lists: "Lists", metrics: "Metrics", templates: "Templates" };

async function slugsTheProviderCalls(): Promise<Set<string>> {
  const tool = fakeKlaviyo();
  const seen = new Set<string>();
  const call: ProviderCall = async (slug, args) => {
    seen.add(slug);
    if (slug === "KLAVIYO_GET_METRICS") return ok({ data: [{ type: "metric", id: "M1", attributes: { name: "Placed Order" } }] });
    if (slug === "KLAVIYO_QUERY_CAMPAIGN_VALUES") return ok({ data: { type: "campaign-values-report", attributes: { results: [] } } });
    return tool.exec({ tool_slug: slug, user_id: "u", connected_account_id: "ca", arguments: args });
  };
  const k = EMAIL_PROVIDERS.klaviyo;
  await k.listAudiences(call);
  await k.listAudiencesPage(call, null);
  const audience = await k.getAudience(call, "L1");
  await k.listSentCampaignsPage(call, { since: "2026-01-01T00:00:00Z", cursor: null, limit: 50 });
  await k.defaultSender(call, audience!);
  const envelope = { subject: "Hi", preview_text: "p", from_name: "Acme", from_email: "hello@acme.test", reply_to: null };
  const id = await k.createCampaign(call, { title: "T1", audience_id: "L1", ...envelope });
  await k.findCampaignsByTitle(call, "T1");
  await k.getCampaign(call, id);
  await k.setContent(call, id, { title: "T1", html: "<p>x</p>", text: "x" });
  await k.setEnvelope(call, id, envelope);
  await k.readContent(call, id);
  await k.readiness(call, id);
  await k.liveRecipientCount(call, id, "L1", async () => {});
  await k.send(call, id);
  await k.getCampaign(call, id);
  await k.results(call, id);
  await k.resultsMany!(call, [id], "acct");
  return seen;
}

function requiredScopes(slugs: Set<string>): string[] {
  return [...new Set([...slugs].flatMap((s) => KLAVIYO_ACTION_SCOPES[s] ?? []))].sort();
}

function namesEveryScope(text: string, scopes: readonly string[]): void {
  const full = text.match(/Full access to ([A-Za-z ,]+?)(?: \(|\.|,? and Read)/)?.[1] ?? "";
  const read = text.match(/Read access to ([A-Za-z ,]+?)(?: \(|\.|,? and Full)/)?.[1] ?? "";
  for (const scope of scopes) {
    const [area, level] = scope.split(":");
    expect(text).toContain(scope);
    if (level === "write") expect(full, `${scope} needs Full access`).toContain(AREA[area]);
    else expect(`${full} ${read}`, `${scope} needs at least Read access`).toContain(AREA[area]);
  }
}

describe("the Klaviyo key instruction", () => {
  beforeEach(() => resetKlaviyoMetricCache());

  it("maps every action the provider calls to its Klaviyo scope", async () => {
    const slugs = await slugsTheProviderCalls();
    expect(slugs.size).toBeGreaterThanOrEqual(15);
    for (const slug of slugs) expect(KLAVIYO_ACTION_SCOPES[slug], `${slug} has no scope`).toBeDefined();
    expect(KLAVIYO_KEY_SCOPES).toEqual(requiredScopes(slugs));
  });

  it("asks for templates, metrics and accounts besides lists and campaigns", () => {
    expect([...KLAVIYO_KEY_SCOPES]).toEqual(["accounts:read", "campaigns:read", "campaigns:write", "lists:read", "metrics:read", "templates:read", "templates:write"]);
    expect(KLAVIYO_KEY_INSTRUCTION).toBe(
      "In Klaviyo, create a Private API key under Settings > API keys with Read access to Accounts, Lists and Metrics, and Full access to Campaigns and Templates (scopes accounts:read, campaigns:read, campaigns:write, lists:read, metrics:read, templates:read, templates:write).",
    );
  });

  it("is what the founder reads on a rejected Klaviyo key, on every surface", async () => {
    const scopes = requiredScopes(await slugsTheProviderCalls());
    for (const text of [keyRejectedText("Klaviyo"), PLAN_REFUSALS.tool_key_rejected]) {
      namesEveryScope(text, scopes);
      expect(text).toContain(KLAVIYO_KEY_INSTRUCTION);
    }
    expect(keyRejectedText("Mailchimp")).not.toMatch(/Klaviyo|scopes/);
  });
});
