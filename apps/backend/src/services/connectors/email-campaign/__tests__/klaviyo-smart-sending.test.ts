import { beforeEach, describe, expect, it } from "vitest";
import { EMAIL_PROVIDERS, resetKlaviyoMetricCache, type ProviderCall } from "@/services/connectors/email-campaign/providers";
import { deliveryOf, deliveryReason } from "@/services/email-results/delivery";

const TOOL_SCHEMA_KEYS = [
  "data__type", "data__attributes__name", "data__attributes__send__options", "data__attributes__tracking__options", "data__attributes__audiences__excluded",
  "data__attributes__audiences__included", "data__attributes__send__strategy__method", "data__attributes__campaign__messages__data",
];

const SKIP_METRIC = "U8Rn2S";
const RECEIVED_METRIC = "VVhfxm";
const SMART_SENDING = "01M6E3H1ECZN95F239CXVYRJJZ";
const BAD_ADDRESSES = "01M6E2E1DX04YG0G98WKAXCRKR";
const QUIET = "01M6E9QUIET00000000000000";
const skipped = (message: string, recipient_status: string, recipient_status_label: string) => ({ metric: SKIP_METRIC, $message: message, channel: "email", recipient_status, recipient_status_label, send_source: "campaign" });
const EVENTS = [
  skipped(SMART_SENDING, "NOT_SENT_THRESHOLD_VIOLATION", "Skipped: Smart Sending"),
  skipped(BAD_ADDRESSES, "INVALID_TO_EMAIL_ADDRESS_ERROR", "Skipped: Invalid Email Address"),
  skipped(BAD_ADDRESSES, "INVALID_TO_EMAIL_ADDRESS_ERROR", "Skipped: Invalid Email Address"),
  skipped(BAD_ADDRESSES, "INVALID_TO_EMAIL_ADDRESS_ERROR", "Skipped: Invalid Email Address"),
  { metric: RECEIVED_METRIC, $message: BAD_ADDRESSES },
];

function klaviyoFake() {
  const seen: Array<{ slug: string; args: Record<string, unknown> }> = [];
  const call = (async (slug: string, args: Record<string, unknown>) => {
    seen.push({ slug, args });
    const ok = (data: unknown) => ({ ok: true, status: 200, data, error: null });
    if (slug === "KLAVIYO_CREATE_CAMPAIGN") return ok({ data: { id: "KV1", type: "campaign", attributes: {} } });
    if (slug === "KLAVIYO_GET_METRICS") return ok({ data: [{ id: RECEIVED_METRIC, attributes: { name: "Received Email" } }, { id: SKIP_METRIC, attributes: { name: "Skipped Send" } }] });
    if (slug === "KLAVIYO_QUERY_METRIC_AGGREGATES") {
      const per = new Map<string, number>();
      for (const e of EVENTS) if (e.metric === args.data__attributes__metric__id) per.set(e.$message, (per.get(e.$message) ?? 0) + 1);
      return ok({ data: { attributes: { data: [...per].map(([id, n]) => ({ dimensions: [id], measurements: { count: [n] } })) } } });
    }
    return ok({ data: { attributes: { results: [] } } });
  }) as unknown as ProviderCall;
  return { call, seen };
}

const INPUT = { title: "Happy Diwali 057946fd", audience_id: "VYfr94", subject: "Happy Diwali", from_name: "Zavi", from_email: "hi@zaviagent.com", html: "<p>x</p>", text: "x" };

beforeEach(() => resetKlaviyoMetricCache());

describe("the campaign Zavi creates in Klaviyo", () => {
  it("turns Smart Sending off in the args that reach the create tool", async () => {
    const f = klaviyoFake();
    await EMAIL_PROVIDERS.klaviyo.createCampaign(f.call, INPUT as never);
    const create = f.seen.filter((s) => s.slug === "KLAVIYO_CREATE_CAMPAIGN");
    expect(create).toHaveLength(1);
    expect(create[0].args.data__attributes__send__options).toEqual({ use_smart_sending: false });
  });

  it("sends only keys the Composio tool schema declares", async () => {
    const f = klaviyoFake();
    await EMAIL_PROVIDERS.klaviyo.createCampaign(f.call, INPUT as never);
    expect(TOOL_SCHEMA_KEYS).toEqual(expect.arrayContaining(Object.keys(f.seen[0].args)));
  });
});

describe("real Skipped Send events on a campaign Klaviyo marked Sent", () => {
  it("the one Smart Sending skip is nobody reached, not Sent to 1", async () => {
    const r = await EMAIL_PROVIDERS.klaviyo.results(klaviyoFake().call, SMART_SENDING);
    expect(r).toMatchObject({ received: 0, skipped: 1 });
    const d = deliveryOf("klaviyo", { received: r.received, skipped: r.skipped }, null);
    expect(d).toEqual({ state: "nobody", people: 0, skipped: 1 });
    expect(deliveryReason("klaviyo", d)).toMatch(/skipped all 1 person on the list, so nobody received it/);
  });

  it("INVALID_TO_EMAIL_ADDRESS_ERROR counts the same way: 3 skipped, 1 received, never 4", async () => {
    const r = await EMAIL_PROVIDERS.klaviyo.results(klaviyoFake().call, BAD_ADDRESSES);
    const d = deliveryOf("klaviyo", { received: r.received, skipped: r.skipped }, null);
    expect(d).toEqual({ state: "reached", people: 1, skipped: 3 });
    expect(deliveryReason("klaviyo", d)).toContain("skipped 3 of 4 people, so 1 person received it");
  });

  it("no Received yet and no skip is not a skip", async () => {
    const r = await EMAIL_PROVIDERS.klaviyo.results(klaviyoFake().call, QUIET);
    const d = deliveryOf("klaviyo", { received: r.received ?? 0, skipped: r.skipped ?? 0 }, null);
    expect(d).toEqual({ state: "unconfirmed", people: null });
  });
});
