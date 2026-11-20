vi.mock("@/services/ads-wallet/chatgpt-account-preview", () => ({
  previewChatgptAccount: (...args: unknown[]) => m.preview(...args),
}));
vi.mock("@/services/ads-wallet/funding-context", () => ({ readFundingContext: (...args: unknown[]) => m.funding(...args) }));
import { beforeEach, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ record: vi.fn(), stamp: vi.fn(), checkImage: vi.fn(), imagePath: vi.fn(), checkUpload: vi.fn(), deliver: vi.fn(), funding: vi.fn(), preview: vi.fn(), remaining: vi.fn(), lifetime: vi.fn(), ask: vi.fn() }));
vi.mock("@/services/approvals/approval-envelope", async original => ({
  ...await original<typeof import("@/services/approvals/approval-envelope")>(), founderAskFor: m.ask,
}));
vi.mock("@/services/growth/ads-no-friction-flag", () => ({ adsNoFrictionEnabled: m.lifetime }));
vi.mock("@/services/channels/chatgpt-ads/wallet-request", () => ({ remainingWalletRequest: m.remaining }));
vi.mock("@/services/chat-images/sign-own-image", async original => ({ ...await original<typeof import("@/services/chat-images/sign-own-image")>(), checkOwnImageForVendor: m.checkUpload }));
vi.mock("@/services/channels/exec-actions", () => ({
  recordChannelExecAction: m.record,
  approveChannelAction: vi.fn(),
}));
vi.mock("@/services/channels/direct-run", () => ({
  healChatRunStamp: (...a: unknown[]) => m.stamp(...a),
}));
vi.mock("@/services/channels/channel-actions", () => ({
  switchedChannelForRun: m.stamp,
}));
vi.mock("@/services/connectors/chatgpt-ads/generated-image", () => ({ checkGeneratedAdImage: m.checkImage, generatedAdImagePath: m.imagePath }));
vi.mock("@/services/reports/deliver-image", async (original) => ({
  ...(await original<typeof import("@/services/reports/deliver-image")>()),
  deliverImage: m.deliver,
}));
import { generateImageTool } from "@/services/tools/report/generate_image";
import { messagesToParams } from "@/services/agents/chat-history";
import { ExpectedToolError } from "@/services/tools/types";
import {
  callChatgptAdsTool,
  listChatgptAdsTools,
} from "@/services/mcp/internal/chatgpt-ads";
const start = Math.floor(Date.now() / 1000);
const input = {
  summary: "A bounded intent test",
  rationale: "Test the verified offer against the existing message",
  campaign: {
    name: "Intent test",
    daily_budget_micros: 25e6,
    bidding_type: "clicks",
    start_time: start,
    end_time: start + 86400,
    targeting: { locations: { countries: ["US"] } },
  },
  group: {
    name: "One intent",
    context_hints: ["Compare options"],
    strategy: "maximize_clicks",
  },
  ads: [
    {
      name: "Intent ad",
      title: "Compare options",
      body: "See the choices",
      target_url: "https://example.com",
      image_url: "https://example.com/img.png",
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  m.remaining.mockResolvedValue(false);
  m.ask.mockResolvedValue(null);
  m.lifetime.mockResolvedValue(false);
  m.preview.mockResolvedValue({ account: { currency_code: "USD" }, fundingSource: "wallet" });
  m.funding.mockResolvedValue({ status: "unavailable", reason: "Wallet unavailable" });
  m.stamp.mockResolvedValue("chatgpt_ads");
  m.record.mockResolvedValue({ id: "action" });
});
it("exposes approval proposals alongside the read tool", () => {
  expect(listChatgptAdsTools().map((t) => [t.tool_name, t.effect])).toEqual([
    ["read_performance", "read"],
    ["propose_new_campaign", "write"],
    ["propose_budget_change", "write"],
    ["propose_status", "write"],
  ]);
});
const { strategy: _strategy, ...groupWithoutStrategy } = input.group;
it.each([
  { campaign: { ...input.campaign, targeting: { locations: [{ type: "country", value: "US" }] } }, group: groupWithoutStrategy },
  { group: groupWithoutStrategy },
  { group: { ...groupWithoutStrategy, automatic_bidding: true, bid_strategy: "automatic" } },
  { campaign: { ...input.campaign, bidding_mode: "automatic", automatic_bidding: true }, group: groupWithoutStrategy },
  { group: { ...groupWithoutStrategy, bid_type: "automatic", bidding: "automatic" } },
  { campaign: { ...input.campaign, bid_strategy: "automatic" }, group: { ...groupWithoutStrategy, bid_mode: "automatic", automatic: true, bid_micros: null } },
])("returns the real nested schema for a failed relaunch attempt, then accepts the corrected automatic bid: %j", async malformed => {
  const result = await callChatgptAdsTool("tenant", "propose_new_campaign", { ...input, ...malformed });
  expect(result.ok).toBe(false);
  const error = JSON.parse(result.content);
  expect(error.error).toBe("invalid_input");
  expect(m.record).not.toHaveBeenCalled();
  expect(m.stamp).not.toHaveBeenCalled();
  const schema = listChatgptAdsTools().find(t => t.tool_name === "propose_new_campaign")!.input_schema;
  const properties = schema.properties as Record<string, unknown>;
  expect(Object.keys(error.field_schemas).length).toBeGreaterThan(0);
  for (const [field, actual] of Object.entries(error.field_schemas)) expect(actual).toEqual(properties[field]);

  const corrected = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", run_trigger: "handoff", emit_decision: vi.fn() }, "propose_new_campaign", input);
  expect(corrected.ok, corrected.content).toBe(true);
  expect(m.record).toHaveBeenCalledOnce();
  expect(m.record.mock.calls[0][0].execPayload.bundle.group).toEqual(input.group);
  expect(m.record.mock.calls[0][0].execPayload.bundle.group).not.toHaveProperty("max_bid_micros");
  expect(m.record.mock.calls[0][0].execPayload).not.toHaveProperty("top_up_authorized");
});
it("keeps fixed bidding explicit and returns an actionable alternative when its bid is missing", async () => {
  const result = await callChatgptAdsTool("tenant", "propose_new_campaign", { ...input, group: groupWithoutStrategy });
  const error = JSON.parse(result.content);
  expect(error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["group"], message: expect.stringContaining('group.strategy to "maximize_clicks"') })]));
  expect(error.field_schemas.group.properties.strategy.enum).toEqual(["fixed_bid", "maximize_clicks", "maximize_conversions"]);
  expect(m.record).not.toHaveBeenCalled();
});
it.each([
  null,
  [],
  { ...input, unexpected: true },
  { ...input, top_up_authorized: true },
  { ...input, top_up_authorized: false },
  { ...input, campaign: { ...input.campaign, end_time: start } },
  { ...input, campaign: { ...input.campaign, targeting: {} } },
  { ...input, ads: [{ ...input.ads[0], image_url: undefined }] },
])("returns the root schema for a whole-input validation error: %j", async malformed => {
  const result = await callChatgptAdsTool("tenant", "propose_new_campaign", malformed);
  expect(result.ok).toBe(false);
  expect(result.is_error).toBe(true);
  const error = JSON.parse(result.content);
  expect(error.error).toBe("invalid_input");
  expect(error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: [] })]));
  const schema = listChatgptAdsTools().find(t => t.tool_name === "propose_new_campaign")!.input_schema;
  expect(error.field_schemas.$).toEqual(schema);
  expect(m.stamp).not.toHaveBeenCalled();
  expect(m.preview).not.toHaveBeenCalled();
  expect(m.record).not.toHaveBeenCalled();
});
it("returns both root and field schemas when whole-input and field errors coexist", async () => {
  const result = await callChatgptAdsTool("tenant", "propose_new_campaign", {
    ...input,
    campaign: { ...input.campaign, targeting: {} },
    group: groupWithoutStrategy,
  });
  const error = JSON.parse(result.content);
  const schema = listChatgptAdsTools().find(t => t.tool_name === "propose_new_campaign")!.input_schema;
  expect(result.ok).toBe(false);
  expect(error.field_schemas.$).toEqual(schema);
  expect(error.field_schemas.group).toEqual((schema.properties as Record<string, unknown>).group);
  expect(m.record).not.toHaveBeenCalled();
});
it("reports conservative coverage and the actual shortfall before approval, not daily budget times days", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1792076400000);
  try {
    m.funding.mockResolvedValue({ status: "read", currency: "USD", balance_cents: 16882, reserved_cents: 0, available_cents: 16882 });
    const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", { ...input, campaign: { ...input.campaign, start_time: 1792134000, end_time: 1792738800 } });
    expect(result.ok, result.content).toBe(true);
    expect(JSON.parse(result.content).funding_preview).toMatchObject({ funding_source: "wallet", currency: "USD", estimated_required_cents: 50000, estimated_shortfall_cents: 33118 });
    expect(m.funding).toHaveBeenCalledWith("tenant");
    expect(m.record).toHaveBeenCalledOnce();
  } finally { now.mockRestore(); }
});
it("keeps an unavailable wallet shortfall unknown without preventing a review proposal", async () => {
  const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", input);
  expect(result.ok, result.content).toBe(true);
  expect(JSON.parse(result.content).funding_preview).toMatchObject({ zavi_ads_wallet: { status: "unavailable" }, estimated_shortfall_cents: null });
});
it("does not apply prepaid coverage or read the wallet for provider-funded proposals", async () => {
  m.preview.mockResolvedValue({ account: { currency_code: "USD" }, fundingSource: "provider" });
  const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", input);
  expect(result.ok, result.content).toBe(true);
  expect(JSON.parse(result.content).funding_preview).toMatchObject({ funding_source: "provider", estimated_required_cents: null, estimated_shortfall_cents: null, zavi_ads_wallet: null });
  expect(m.funding).not.toHaveBeenCalled();
});
it.each([
  { ...input.group, max_bid_micros: 1_500_000 },
  { ...input.group, max_bid_micros: null },
  { ...input.group, strategy: "maximize_conversions" },
  { ...input.group, strategy: "fixed_bid" },
])("does not relax bidding validation when returning corrections: %j", async group => {
  const result = await callChatgptAdsTool("tenant", "propose_new_campaign", { ...input, group });
  expect(result.ok).toBe(false);
  expect(m.record).not.toHaveBeenCalled();
});
it("uses the server tenant and switched channel rail, not a provider write", async () => {
  const legacy = vi.fn();
  const r = await callChatgptAdsTool(
    {
      tenant_id: "tenant",
      run_id: "run",
      run_trigger: "a2a",
      emit_decision: legacy,
    },
    "propose_new_campaign",
    input,
  );
  expect(r.ok).toBe(true);
  expect(m.record).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: "tenant",
      runId: "run",
      channelSlug: "chatgpt_ads",
      execClass: "chatgpt_ads.create_and_launch",
      execPayload: expect.objectContaining({ origin: "agent" }),
    }),
  );
  expect(legacy).not.toHaveBeenCalled();
  const body = m.record.mock.calls[0][0].body;
  expect(body.step.responsibility).toBe("client");
  expect(body.exact_change.rows).toEqual(
    expect.arrayContaining([
      { item: "Daily budget", before: "None", after: "$25/day" },
    ]),
  );
  expect(body.change_sentence).toContain("$25/day");
  expect(
    body.exact_change.rows.find((r: { item: string }) => r.item === "Ad 1")
      .after,
  ).toContain(input.ads[0].target_url);
});
it("a human command is left for the human approval path", async () => {
  await callChatgptAdsTool(
    {
      tenant_id: "tenant",
      run_id: "run",
      run_trigger: "chat",
      emit_decision: vi.fn(),
    },
    "propose_new_campaign",
    input,
  );
  expect(m.record.mock.calls[0][0].execPayload.origin).toBe(
    "user_initiated_chat",
  );
});
it.each([{ writes_suppressed: true }, { redo: true }])(
  "shadow and redo cannot create a new spend proposal",
  async (flags) => {
    await callChatgptAdsTool(
      { tenant_id: "tenant", run_id: "run", emit_decision: vi.fn(), ...flags },
      "propose_new_campaign",
      input,
    );
    expect(m.record).not.toHaveBeenCalled();
  },
);
it("a launch card shows the budget, schedule and children the launch turns on", async () => {
  const ws = await import("@/services/connectors/chatgpt-ads/workspace");
  vi.spyOn(ws, "readCampaignTree").mockResolvedValue({
    campaign: {
      id: "cmpn_test",
      name: "Old",
      status: "paused",
      updated_at: 5,
      start_time: start,
      end_time: start + 86400,
      budget: { daily_spend_limit_micros: 40e6 },
    },
    groups: [{ id: "ag", status: "paused" }],
    ads: [
      { id: "a1", status: "paused" },
      { id: "a2", status: "paused", review_status: "rejected" },
    ],
  } as never);
  const r = await callChatgptAdsTool(
    {
      tenant_id: "tenant",
      run_id: "run",
      run_trigger: "a2a",
      emit_decision: vi.fn(),
    },
    "propose_status",
    {
      campaign_id: "cmpn_test",
      status: "ACTIVE",
      summary: "Resume it",
      rationale: "Resume the verified experiment",
    },
  );
  expect(r.ok).toBe(true);
  const rows = m.record.mock.calls[0][0].body.exact_change.rows;
  expect(rows).toEqual(
    expect.arrayContaining([
      { item: "Budget", before: "Unchanged", after: "$40/day" },
      {
        item: "Also turned on",
        before: "Off",
        after: "1 ad group(s), 1 ad(s)",
      },
    ]),
  );
});

const artifactId = "a51bf6d9-cb5b-4959-97ab-42bb8480319a";
it("reuses an uploaded photo from chat history in a proposal without a public URL", async () => {
  const tenant = "11111111-1111-4111-8111-111111111111";
  const imagePath = `${tenant}/33333333-3333-4333-8333-333333333333.jpg`;
  const sb = { storage: { from: () => ({ download: async () => ({ data: { arrayBuffer: async () => new Uint8Array([255, 216, 255]).buffer }, error: null }) }) } };
  const history = await messagesToParams([{ sender_role: "user", body: "Use my car photo", created_at: "2026-10-14T06:00:00Z", attachments: [{ path: imagePath, kind: "image" }] }], sb as never, tenant);
  const text = (history[0].content as Array<{ type: string; text?: string }>).find(b => b.type === "text")!.text!;
  const visiblePath = text.match(/image_path=([^;\s]+)/)![1];
  expect(visiblePath).toBe(imagePath);
  const { image_url: _url, ...ad } = input.ads[0];
  const result = await callChatgptAdsTool({ tenant_id: tenant, run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", { ...input, ads: [{ ...ad, image_path: visiblePath }] });
  expect(result.ok).toBe(true);
  expect(m.record.mock.calls[0][0].execPayload.bundle.ads[0]).toMatchObject({ image_path: imagePath });
  expect(m.checkUpload).toHaveBeenCalledWith(tenant, imagePath);
  expect(m.checkUpload.mock.invocationCallOrder[0]).toBeLessThan(m.record.mock.invocationCallOrder[0]);
  expect(m.record.mock.calls[0][0].execPayload.bundle.ads[0]).not.toHaveProperty("image_url");
  expect(m.deliver).not.toHaveBeenCalled();
});
it("does not record a proposal for a deleted uploaded photo", async () => {
  m.checkUpload.mockRejectedValue(new ExpectedToolError("image_unavailable", "Saved image is missing"));
  const { image_url: _url, ...ad } = input.ads[0];
  const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", { ...input, ads: [{ ...ad, image_path: "11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.jpg" }] });
  expect(JSON.parse(result.content).error).toBe("image_unavailable");
  expect(m.record).not.toHaveBeenCalled();
});
function generatedInput() {
  const { image_url: _url, ...ad } = input.ads[0];
  return { ...input, ads: [{ ...ad, image_artifact_id: artifactId }] };
}
it("carries the generator's artifact-only result into a proposal without a URL or another generation", async () => {
  m.deliver.mockResolvedValue({ images: [{ artifact_id: artifactId, filename: "upcar-chatgpt-rent-cheap.png", bytes: 2012885, cached: false }], generated: 1, cached: 0, skipped: [] });
  const generated = await generateImageTool.execute({ tenant_id: "tenant", run_id: "run", log: () => {} }, { prompts: [{ prompt: "A clean car on a residential street" }], aspect_ratio: "1:1", mode: "photo" });
  const proposal = generatedInput();
  proposal.ads[0].image_artifact_id = generated.images[0].artifact_id;
  const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", proposal);
  expect(result.ok).toBe(true);
  expect(m.checkImage).toHaveBeenCalledWith("tenant", artifactId);
  expect(m.checkImage.mock.invocationCallOrder[0]).toBeLessThan(m.record.mock.invocationCallOrder[0]);
  expect(m.deliver).toHaveBeenCalledOnce();
  const stored = m.record.mock.calls[0][0].execPayload.bundle.ads[0];
  expect(stored.image_artifact_id).toBe(artifactId);
  expect(stored).not.toHaveProperty("image_url");
  expect(stored).not.toHaveProperty("image_path");
});
it("shows the generated creative on the approval card, by path and never by signed URL", async () => {
  m.imagePath.mockResolvedValue(`tenant/run/car.png`);
  const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", generatedInput());
  expect(result.ok).toBe(true);
  expect(m.imagePath).toHaveBeenCalledWith("tenant", artifactId);
  expect(m.record.mock.calls[0][0].body.media).toEqual({ kind: "image", artifact_id: artifactId, storage_path: "tenant/run/car.png", bucket: "agent-artifacts", alt: input.ads[0].title });
});
it("advertises the generated artifact field in the nested ad schema", () => {
  const tool = listChatgptAdsTools().find(t => t.tool_name === "propose_new_campaign")!;
  const schema = tool.input_schema as any;
  expect(schema.properties.ads.items.properties.image_artifact_id).toEqual({ type: "string" });
});
it("rejects a missing or foreign generated image before recording a proposal", async () => {
  m.checkImage.mockRejectedValue(new ExpectedToolError("image_not_owned", "Unavailable in this workspace"));
  const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", generatedInput());
  expect(JSON.parse(result.content).error).toBe("image_not_owned");
  expect(m.record).not.toHaveBeenCalled();
});
it("returns a field-specific correction for the incident's artifact UUID in image_url", async () => {
  const result = await callChatgptAdsTool("tenant", "propose_new_campaign", { ...input, ads: [{ ...input.ads[0], image_url: artifactId }] });
  const error = JSON.parse(result.content);
  expect(error.error).toBe("invalid_input");
  expect(error.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path: ["ads", 0, "image_url"] })]));
  expect(error.message).toContain("image_artifact_id");
  expect(m.record).not.toHaveBeenCalled();
});
it.each([
  { ...input.ads[0], image_artifact_id: artifactId },
  { ...generatedInput().ads[0], image_path: "11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.jpg" },
  { name: "Ad name", title: "Ad title", body: "Ad body", target_url: "https://example.com" },
])("rejects missing or ambiguous image sources without a proposal", async ad => {
  const result = await callChatgptAdsTool("tenant", "propose_new_campaign", { ...input, ads: [ad] });
  expect(JSON.parse(result.content).error).toBe("invalid_input");
  expect(m.checkImage).not.toHaveBeenCalled();
  expect(m.record).not.toHaveBeenCalled();
});

it("fits a remaining-wallet request to actual coverage without a bid or a top-up", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(1792124327000);
  try {
    m.remaining.mockResolvedValue(true);
    m.funding.mockResolvedValue({ status: "read", currency: "USD", balance_cents: 16882, available_cents: 16882, reserved_cents: 0 });
    const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", run_trigger: "handoff", emit_decision: vi.fn() }, "propose_new_campaign", { ...input, campaign: { ...input.campaign, start_time: 1792177200, end_time: 1792436400 } });
    expect(result.ok, result.content).toBe(true);
    const output = JSON.parse(result.content);
    expect(output.funding_preview).toMatchObject({ status: "covered", estimated_required_cents: 15000, estimated_shortfall_cents: 0 });
    const filed = m.record.mock.calls[0][0];
    expect(filed.execPayload.bundle.group).toEqual(input.group);
    expect(filed.execPayload.bundle.campaign.start_time).toBe(1792177200);
    expect(filed.execPayload.bundle.campaign.end_time).toBe(1792124327 + 86400);
    expect(filed.execPayload.top_up_authorized).toBe(false);
    expect(filed.body.step.responsibility).toBe("client");
    expect(filed.execPayload).not.toHaveProperty("approval_envelope");
    expect(output.say_to_founder).toContain("Approval and fresh funding checks are still required");
  } finally { clock.mockRestore(); }
});
it("refuses when a wallet-only ask matches an older open card that keeps its own funding terms", async () => {
  m.remaining.mockResolvedValue(true);
  m.record.mockResolvedValue({ id: "older", replayed: false, kept: true });
  m.funding.mockResolvedValue({ status: "read", currency: "USD", available_cents: 16882, balance_cents: 16882, reserved_cents: 0 });
  const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", input);
  expect(result.ok).toBe(false);
  expect(result.content).toContain("no wallet-only card was filed");
});
it("does not file an unaffordable remaining-wallet proposal when even minimum coverage cannot fit", async () => {
  m.remaining.mockResolvedValue(true);
  m.funding.mockResolvedValue({ status: "read", currency: "USD", available_cents: 14999, balance_cents: 14999, reserved_cents: 0 });
  const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", input);
  expect(result.ok).toBe(false);
  expect(m.record).not.toHaveBeenCalled();
});

it.each(["run read failed", "lineage read failed", "connection rejected"])("files nothing when wallet request provenance cannot be verified: %s", async reason => {
  m.remaining.mockRejectedValue(new Error(reason));
  const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", input);
  expect(result.ok).toBe(false);
  expect(JSON.parse(result.content)).toMatchObject({ error: "chatgpt_ads_conflict", message: "Could not verify the original request's wallet constraint. Nothing was proposed. Try again." });
  expect(m.record).not.toHaveBeenCalled();
});

it.each(["Could you run $100 of ChatGPT ads with my remaining wallet balance?", "Would you please launch a $100 ChatGPT campaign with my remaining wallet balance?"])("sizes a polite request to $80 and retains the wallet-only restriction: %s", async text => {
  const { asksForWalletBalance } = await vi.importActual<typeof import("@/services/channels/chatgpt-ads/wallet-request")>("@/services/channels/chatgpt-ads/wallet-request");
  m.remaining.mockResolvedValue(asksForWalletBalance(text));
  m.lifetime.mockResolvedValue(true);
  m.funding.mockResolvedValue({ status: "read", currency: "USD", balance_cents: 8000, available_cents: 8000, reserved_cents: 0 });
  const { daily_budget_micros: _daily, ...campaign } = input.campaign;
  const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", {
    ...input, campaign: { ...campaign, lifetime_budget_micros: 100e6 }, group: { ...input.group, strategy: "fixed_bid", max_bid_micros: 1e6 },
  });
  expect(result.ok, result.content).toBe(true);
  expect(m.record.mock.calls[0][0].execPayload).toMatchObject({ top_up_authorized: false, bundle: { campaign: { lifetime_budget_micros: 80e6 } } });
  expect(m.record.mock.calls[0][0].execPayload).not.toHaveProperty("approval_envelope");
  expect(JSON.parse(result.content).say_to_founder).toContain("Approval and fresh funding checks are still required");
});

it("caps an explicit fixed-bid lifetime proposal at the remaining wallet without inventing its bid", async () => {
  m.remaining.mockResolvedValue(true);
  m.lifetime.mockResolvedValue(true);
  m.funding.mockResolvedValue({ status: "read", currency: "USD", balance_cents: 16882, available_cents: 16882, reserved_cents: 0 });
  const { daily_budget_micros: _daily, ...campaign } = input.campaign;
  const group = { ...input.group, strategy: "fixed_bid", max_bid_micros: 1_000_000 };
  const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", { ...input, campaign: { ...campaign, lifetime_budget_micros: 200e6 }, group });
  expect(result.ok, result.content).toBe(true);
  expect(m.record.mock.calls[0][0].execPayload.bundle.campaign.lifetime_budget_micros).toBe(168_820_000);
  expect(m.record.mock.calls[0][0].execPayload.bundle.group).toEqual(group);
  expect(JSON.parse(result.content).funding_preview).toMatchObject({ status: "covered", estimated_required_cents: 16882 });
});

it.each([8000, 12000])("preserves the direct dollar ask's approval after fitting it to a %i-cent wallet", async available => {
  const now = Date.parse("2026-10-16T04:18:47Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const { parseDirectAdAsk, shapeDirectAsk } = await import("@/services/growth/direct-ad-ask");
    const { envelopeDoor } = await import("@/services/approvals/envelope-door");
    const { verifyEnvelope } = await import("@/services/approvals/approval-envelope");
    const ask = parseDirectAdAsk("Run a $100 ChatGPT ad with my remaining wallet balance")!;
    const shape = shapeDirectAsk(ask, "2026-10-16");
    if (shape.kind !== "plan") throw new Error("Expected a bounded direct-ask plan");
    m.ask.mockResolvedValue({ plan: shape.plan, line: shape.line });
    m.remaining.mockResolvedValue(true);
    m.lifetime.mockResolvedValue(true);
    m.funding.mockResolvedValue({ status: "read", currency: "USD", balance_cents: available, available_cents: available, reserved_cents: 0 });
    const group = { ...input.group, strategy: "fixed_bid", max_bid_micros: 1_000_000 };
    const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", run_trigger: "chat", emit_decision: vi.fn() }, "propose_new_campaign", { ...input, group });
    expect(result.ok, result.content).toBe(true);
    const total = Math.min(100, available / 100);
    const filed = m.record.mock.calls[0][0];
    expect(filed.execPayload.bundle.campaign.lifetime_budget_micros).toBe(total * 1e6);
    expect(filed.execPayload.top_up_authorized).toBe(false);
    expect(filed.execPayload.bundle.group).toEqual(group);
    const output = JSON.parse(result.content);
    expect(output.funding_preview).toMatchObject({ status: "covered", estimated_required_cents: total * 100 });
    expect(output.say_to_founder).toContain(`Your request approves launching this campaign at $${total.toFixed(2)} total`);
    expect(output.say_to_founder).toContain("no card charge or wallet top-up");
    expect(output.say_to_founder).not.toContain("Approval and fresh funding checks are still required");
    const approve = vi.fn(async () => ({ ok: true }));
    const send = vi.fn(async () => undefined);
    const approval = await envelopeDoor(filed, "action", {
      enabled: async () => true, readEnvelope: async () => null,
      readFounderAsk: async () => ({ ask, shape, envelope_id: "ask:run", approver: { user_id: "owner", role: "owner", surface: "chat" } }),
      verify: (tenant, env, cls, payload) => verifyEnvelope(tenant, env, cls, payload, async () => "owner"),
      claim: async () => ({ ok: true }), setEnvelope: async () => ({ ok: true }), approve, send, supersede: async () => ({ ok: true }),
    });
    expect(approval.approved).toBe(true);
    expect(approve).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  } finally { clock.mockRestore(); }
});

it("lowers the daily rate inside a founder's future window without moving the start or extending the end", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-16T04:00:00Z"));
  try {
    m.remaining.mockResolvedValue(true);
    m.funding.mockResolvedValue({ status: "read", currency: "USD", balance_cents: 30000, available_cents: 30000, reserved_cents: 0 });
    m.ask.mockResolvedValue({ plan: { channel_slug: "chatgpt_ads", budget_type: "daily", daily_usd: 100, total_usd: 400, start: "2026-10-17", end: "2026-10-19", days: 2, switched_from: null }, line: "Run the event campaign" });
    const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", run_trigger: "chat", emit_decision: vi.fn() }, "propose_new_campaign", input);
    expect(result.ok, result.content).toBe(true);
    expect(m.record.mock.calls[0][0].execPayload).toMatchObject({ top_up_authorized: false, bundle: { campaign: {
      start_time: Date.parse("2026-10-17T00:00:00Z") / 1000,
      end_time: Date.parse("2026-10-19T00:00:00Z") / 1000,
      daily_budget_micros: 25e6,
    } } });
    expect(JSON.parse(result.content).funding_preview.status).toBe("covered");
  } finally { clock.mockRestore(); }
});

it("refuses a future campaign when no covered plan fits its window instead of launching it now", async () => {
  const now = Date.parse("2026-10-16T04:00:00Z");
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    m.remaining.mockResolvedValue(true);
    m.funding.mockResolvedValue({ status: "read", currency: "USD", balance_cents: 15000, available_cents: 15000, reserved_cents: 0 });
    const result = await callChatgptAdsTool({ tenant_id: "tenant", run_id: "run", emit_decision: vi.fn() }, "propose_new_campaign", {
      ...input, campaign: { ...input.campaign, start_time: now / 1000 + 2 * 86400, end_time: now / 1000 + 3 * 86400 },
    });
    expect(result.ok).toBe(false);
    expect(JSON.parse(result.content).message).toContain("No covered campaign fits the original schedule");
    expect(m.record).not.toHaveBeenCalled();
  } finally { clock.mockRestore(); }
});

it("non-USD account + direct ask + no budget/dates: an explicit retry error, nothing filed", async () => {
  m.ask.mockResolvedValue({ plan: { channel_slug: "chatgpt_ads", budget_type: "lifetime", total_usd: 25, daily_usd: null, start: "2026-10-17", end: "2026-10-18", days: 1, switched_from: null }, line: "Running $25.00 on ChatGPT as one total for 1 day.", source: "ask" });
  m.preview.mockResolvedValue({ account: { currency_code: "EUR" }, fundingSource: "provider" });
  const { daily_budget_micros: _d, start_time: _s, end_time: _e, ...campaign } = input.campaign;
  const result = await callChatgptAdsTool("tenant", "propose_new_campaign", { ...input, campaign });
  expect(result.is_error).toBe(true);
  expect(result.content).toContain("not in USD");
  expect(result.content).toContain("start_time and end_time");
  expect(m.record).not.toHaveBeenCalled();
});
