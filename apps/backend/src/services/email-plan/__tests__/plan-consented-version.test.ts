import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListSummary } from "@/services/comms/bulk-outbound/lists";
import type { EmailContent, EmailTemplate } from "@/services/email-templates/render";

const h = vi.hoisted(() => ({ lists: [] as unknown[] }));
vi.mock("@/services/comms/bulk-outbound/lists", async (orig) => ({
  ...(await orig<typeof import("@/services/comms/bulk-outbound/lists")>()),
  listSummaries: async () => h.lists,
}));
vi.mock("../preflight", async (orig) => ({ ...(await orig<typeof import("../preflight")>()), emailRunPreflight: async () => ({ verdict: "ok" }) }));

import { livePlanList } from "../plan";
import { draftBlocker } from "../draft-blocker";
import { makeProposeCampaignTool, type PlanRunContext, type ProposeCampaignDeps } from "@/services/tools/email/propose_campaign";
import { makeListEmailListsTool } from "@/services/tools/outbound/list_email_lists";

const T = "tenant-northwind";
const RUN = "55555555-5555-4555-8555-555555555555";
const ITEM = "11111111-1111-4111-8111-111111111111";
const LIST = "22222222-2222-4222-8222-222222222222";
const CONSENTED = "33333333-3333-4333-8333-333333333333";
const PENDING = "44444444-4444-4444-8444-444444444444";
const DECISION = "66666666-6666-4666-8666-666666666666";

const TEMPLATE: EmailTemplate = { logo_url: null, brand_color: "#2e7d32", button_color: "#2e7d32", font_key: "georgia", sign_off: "Northwind Clinic", postal_address: "400 Elm St, Dayton OH 45402", show_cards: false };
const content: EmailContent = { subject: "Flu shots are here", preview_text: "Walk in", title: "Flu shots", paragraphs: ["Walk in this week."], button: { label: "See hours", url: "https://northwind.test/hours" } };

const version = (id: string, consented: boolean, contact_count: number) => ({ id, source_kind: "csv" as const, source_label: "email", contact_count, created_at: "2026-10-07T00:00:00Z", consented });
const pendingImport = (): ListSummary => ({
  id: LIST,
  name: "Patients",
  created_at: "2026-10-01T00:00:00Z",
  latest: version(PENDING, false, 900),
  active: { id: CONSENTED, source_kind: "csv", contact_count: 40, sendable: 38, unsubscribed_or_bounced: 2 },
  needs_consent: true,
});
const neverConsented = (): ListSummary => ({ ...pendingImport(), active: null });

const bound: PlanRunContext = { found: true, mode: "planned_draft", item_id: ITEM, version: 1, stale: false, route: "zavi_list", list_id: LIST };

function propose(list: ListSummary, run: PlanRunContext = bound) {
  const read: Array<string | undefined> = [];
  const emit = vi.fn(async (_cls: string, _body: unknown) => DECISION);
  const attach = vi.fn(async () => ({ ok: true }));
  const release = vi.fn(async () => {});
  const tool = makeProposeCampaignTool({
    template: async () => TEMPLATE,
    company: async () => ({ name: "Northwind Clinic", website: null }),
    testLists: async () => new Set<string>(),
    checkSender: (async () => ({ ok: true, sender: { domain: "northwind.test", from_address: "hi@northwind.test", from_name: null }, postal_address: "400 Elm St" })) as unknown as ProposeCampaignDeps["checkSender"],
    lists: async () => [list],
    source: ((a: { versionId: string }) => {
      read.push(a.versionId);
      return { fetchCandidates: async () => [{ email: "a@x.test", opt_in_marketing: true }] };
    }) as unknown as ProposeCampaignDeps["source"],
    replyTo: async () => "owner@northwind.test",
    now: () => new Date("2026-10-11T12:00:00Z"),
    reserveCard: async () => ({ ok: true as const, id: "res-1" }),
    releaseCard: release,
    settleCard: async () => {},
    runContext: async () => run,
    attachPlanned: attach as unknown as ProposeCampaignDeps["attachPlanned"],
    railOf: async () => "decisions",
  });
  const run_ = () => tool.execute({ tenant_id: T, run_id: RUN, log: () => {}, emit_decision: emit } as never, { route: "zavi_list", list_id: LIST, variants: [content] } as never);
  return { run: run_, emit, attach, read, release };
}

const tool = (lists: ListSummary[]) =>
  makeListEmailListsTool({ lists: async () => lists, testLists: async () => new Set<string>(), checkSender: (async () => ({ ok: true, sender: { domain: "northwind.test", from_address: "hi@northwind.test", from_name: null } })) as never });
const read = (lists: ListSummary[]) => tool(lists).execute({ tenant_id: T } as never, {} as never);
const draftRun = async (lists: ListSummary[]) => ({
  status: "success",
  finished_at: "2026-10-11T12:00:00Z",
  payload: { email_plan: { route: "zavi_list", list_id: LIST } },
  tool_calls: [{ name: "mcp__server__outbound__list_email_lists", status: "ok", output_preview: JSON.stringify([{ type: "text", text: JSON.stringify(await read(lists)) }]) }],
});

describe("Flow 79 and 38: a list with a newer import still waiting on consent", () => {
  beforeEach(() => {
    h.lists = [];
  });

  it("must catch: planning takes the consented version instead of refusing", async () => {
    h.lists = [pendingImport()];
    expect(await livePlanList(T, "zavi_list", LIST)).toEqual({ ok: true, name: "Patients" });
  });

  it("a list with no consented version at all is still refused at planning", async () => {
    h.lists = [neverConsented()];
    expect(await livePlanList(T, "zavi_list", LIST)).toEqual({ ok: false, code: "list_not_consented" });
  });

  it("must catch: the planned draft seals the consented version, reads only its people, and the card shows its count", async () => {
    const p = propose(pendingImport());
    await p.run();
    expect(p.emit).toHaveBeenCalledTimes(1);
    const body = p.emit.mock.calls[0][1] as Record<string, unknown>;
    expect(body).toMatchObject({ list_version_id: CONSENTED, planned_send_id: ITEM, est_recipient_count: 1 });
    expect(JSON.stringify(body)).not.toContain(PENDING);
    expect(p.read).toEqual([CONSENTED]);
  });

  it("must catch: a planned draft's read of the lists does not end it with a blocker", async () => {
    expect(draftBlocker(await draftRun([pendingImport()]))).toBeNull();
    const out = await read([pendingImport()]);
    expect(out.lists[0]).toMatchObject({ ready_to_send: true, not_ready_because: null, can_be_emailed: 38, people: 40 });
    expect(out.lists[0].newer_import_waits).toMatch(/already confirmed/);
  });

  it("the lists read says nothing extra about a list with no waiting import", async () => {
    const out = await read([{ ...pendingImport(), latest: version(CONSENTED, true, 40), needs_consent: false }]);
    expect(out.lists[0].newer_import_waits).toBeUndefined();
  });

  it("control: a list nobody ever confirmed still ends a planned draft, and proposes nothing", async () => {
    expect(draftBlocker(await draftRun([neverConsented()]))).toBe("zavi_list_not_ready");
    const p = propose(neverConsented());
    await expect(p.run()).rejects.toMatchObject({ code: "list_not_consented" });
    expect(p.emit).not.toHaveBeenCalled();
    expect(p.read).toEqual([]);
  });

  it("control: an email that is not a planned one stays refused until the new import is confirmed", async () => {
    const p = propose(pendingImport(), { found: true, mode: null } as PlanRunContext);
    await expect(p.run()).rejects.toMatchObject({ code: "list_not_consented" });
    expect(p.emit).not.toHaveBeenCalled();
    expect(p.read).toEqual([]);
  });
});
