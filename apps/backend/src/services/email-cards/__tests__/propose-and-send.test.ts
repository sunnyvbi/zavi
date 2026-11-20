import { describe, expect, it, vi } from "vitest";

const q = vi.hoisted(() => ({
  retry: false,
  actionRow: null as null | { tenant_id: string; exec_class: string | null; exec_status: string | null; exec_result: Record<string, unknown> | null },
  inngestSend: vi.fn(async (_e: unknown) => ({})),
  keep: vi.fn(async (_o: unknown) => true),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: (e: unknown) => q.inngestSend(e) } }));
vi.mock("../outcome", async (orig) => {
  const real = await orig<typeof import("../outcome")>();
  return {
    ...real,
    tellEmailSendOutcome: async (...a: Parameters<typeof real.tellEmailSendOutcome>) => (q.retry ? ("retry" as const) : real.tellEmailSendOutcome(...a)),
    keepEmailSendOutcomeLine: (o: unknown) => q.keep(o),
  };
});
vi.mock("../outcome-rebuild", async (orig) => {
  const real = await orig<typeof import("../outcome-rebuild")>();
  return { ...real, rebuildSendOutcome: (tenantId: string, ref: Parameters<typeof real.rebuildSendOutcome>[1]) => real.rebuildSendOutcome(tenantId, ref, { readAction: async () => q.actionRow }) };
});
import { makeProposeCampaignTool, type ProposeCampaignDeps } from "@/services/tools/email/propose_campaign";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { sendgridKeyDigest } from "@/services/connectors/email-campaign/credential";
import { emailSendBodySchema, executeEmailCampaignSend, parseEmailSendBody, type EmailSendDeps } from "@/services/connectors/email-campaign/execute-send";
import { buildEmailSendCardBody } from "@/services/tools/email-campaign/_exec-action";
import { BRIGHTLOOP_KEY, fakeSendgrid, type FakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";
import { executeBulkOutboundDispatch } from "@/services/comms/bulk-outbound/dispatch";
import { executeEmailCampaignSendAndTell } from "@/services/connectors/email-campaign/execute-send";
import { reconcileEmailSend } from "@/services/connectors/email-campaign/reconcile";
import { cardView, editEmailCardVersion, type CardDeps } from "../cards";
import { bulkSendOutcome, notifyEmailSendOutcome, type OutcomeDeps } from "../outcome";
import { emailSendOutcomeLine, renderEmailSendOutcomeEmail } from "@/email/templates/email-send-outcome";
import { harness as bulkHarness, LIST as ZLIST, VERSION as ZVERSION, DECISION as ZDECISION, TENANT as ZTENANT } from "@/services/comms/bulk-outbound/__tests__/harness";
import type { BulkWireMessage } from "@/services/comms/bulk-outbound/wire";
import { buildBulkPayload } from "@/services/comms/bulk-outbound/wire";
import { unsubscribeUrl } from "@/services/tools/email/safety-net";
import type { ListSummary } from "@/services/comms/bulk-outbound/lists";
import { UNSUBSCRIBE_HREF, type EmailContent, type EmailTemplate } from "@/services/email-templates/render";
import { AUTOPILOT_SEND_CAP, countAtSendRefusal, shaOf } from "../variants";
import { ExpectedToolError } from "@/services/tools/types";

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";
const DIGEST = sendgridKeyDigest(BRIGHTLOOP_KEY);
const SG_LIST = "6a1f0c2e-0000-4000-8000-00000000b001";
const ACTION = "44444444-4444-4444-8444-444444444444";

const BRIGHTLOOP_TEMPLATE: EmailTemplate = {
  logo_url: "https://cdn.brightloop.test/logo.png",
  brand_color: "#1a73e8",
  button_color: "#0b8043",
  font_key: "system",
  sign_off: "Thanks,\nThe Brightloop team",
  postal_address: "12 Harbor Way, Portland OR 97201",
  show_cards: false,
};
const EDITED_TEMPLATE: EmailTemplate = { ...BRIGHTLOOP_TEMPLATE, brand_color: "#c2185b", sign_off: "Cheers,\nBrightloop" };
const NORTHWIND_TEMPLATE: EmailTemplate = {
  logo_url: null,
  brand_color: "#2e7d32",
  button_color: "#2e7d32",
  font_key: "georgia",
  sign_off: "Northwind Clinic",
  postal_address: "400 Elm St, Dayton OH 45402",
  show_cards: false,
};

const version = (n: number, over: Partial<EmailContent> = {}): EmailContent => ({
  subject: `Version ${n}: shared workspaces are here`,
  preview_text: `Angle ${n}`,
  title: `Shared workspaces, angle ${n}`,
  paragraphs: [`Paragraph for angle ${n}.`],
  button: { label: "See what changed", url: "https://brightloop.test/changelog" },
  ...over,
});

function ctx() {
  const emit = vi.fn(async (_cls: string, _body: unknown) => ACTION);
  return { c: { tenant_id: "tenant-brightloop", log: () => {}, emit_decision: emit } as never, emit };
}

function sgDeps(sg: FakeSendgrid, over: Partial<ProposeCampaignDeps> = {}): Partial<ProposeCampaignDeps> {
  return {
    resolveTool: (async () => ({ tool: "sendgrid", sendgrid: { api_key: BRIGHTLOOP_KEY, key_digest: DIGEST } })) as unknown as ProposeCampaignDeps["resolveTool"],
    callFor: () => sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch),
    template: async () => BRIGHTLOOP_TEMPLATE,
    company: async () => ({ name: "Brightloop", website: "https://www.brightloop.test" }),
    testLists: async () => new Set<string>(),
    setting: async () => null,
    railOf: async () => "channel_actions",
    replaceCard: async () => true,
    redraftPlan: async () => null,
    now: () => new Date("2026-10-11T12:00:00Z"),
    reserveCard: async () => ({ ok: true as const, id: "res-1" }),
    releaseCard: async () => {},
    settleCard: async () => {},
    ...over,
  };
}

async function proposeSendgrid(sg: FakeSendgrid, variants: EmailContent[], over: Partial<ProposeCampaignDeps> = {}) {
  const { c, emit } = ctx();
  const out = await makeProposeCampaignTool(sgDeps(sg, over)).execute(c, { route: "sendgrid", audience_id: SG_LIST, variants });
  const [cls, raw] = emit.mock.calls[0];
  const { rationale: _r, ...body } = raw as Record<string, unknown>;
  return { out, cls, body };
}

function execDeps(sg: FakeSendgrid, over: Partial<EmailSendDeps> = {}): Partial<EmailSendDeps> {
  return {
    resolveAccount: (async () => {
      throw new Error("composio must not be called for SendGrid");
    }) as unknown as EmailSendDeps["resolveAccount"],
    exec: (async () => {
      throw new Error("composio must not be called for SendGrid");
    }) as unknown as EmailSendDeps["exec"],
    resolveSendgrid: async () => ({ api_key: BRIGHTLOOP_KEY, key_digest: DIGEST }),
    sendgridFetch: sg.fetch,
    readProgress: async () => null,
    recordProgress: async () => true,
    scheduleReconcile: async () => {},
    authorizeCgo: (async () => ({ verdict: "allow", reasons: [] })) as unknown as EmailSendDeps["authorizeCgo"],
    notifyAutopilotSend: (async () => true) as unknown as EmailSendDeps["notifyAutopilotSend"],
    testListKeys: async () => new Set<string>(),
    sleep: async () => {},
    paused: async () => false,
    ...over,
  };
}

const run = (body: unknown, approved_by_source: string | null = null) => ({
  id: ACTION,
  tenant_id: "tenant-brightloop",
  body,
  approved_by_source,
  exec_source: "channel_actions" as const,
  claim_id: "claim-1",
});

describe("proposing seals every version as bytes", () => {
  it("3 versions are rendered once with the saved template and sealed on ONE card", async () => {
    const sg = fakeSendgrid();
    const { out, cls, body } = await proposeSendgrid(sg, [version(1), version(2), version(3)]);
    expect(cls).toBe("email_campaign.create_and_send");
    expect(out).toMatchObject({ versions: 3, route: "sendgrid", audience: { member_count: 238 } });
    const parsed = parseEmailSendBody(body);
    expect(parsed).not.toBeNull();
    expect(emailSendBodySchema.strict().safeParse(body).success).toBe(true);
    expect(buildEmailSendCardBody(parsed!, null).title).toBe('Send "Version 1: shared workspaces are here" to Brightloop members');
    expect(parsed!.variants).toHaveLength(3);
    parsed!.variants!.forEach((v, i) => {
      expect(v.content.subject).toBe(`Version ${i + 1}: shared workspaces are here`);
      expect(v.html).toContain(`Shared workspaces, angle ${i + 1}`);
      expect(v.render_sha).toBe(shaOf(parsed!.renderer_version!, v.html, v.text));
      expect(v.html).toContain(UNSUBSCRIBE_HREF.sendgrid);
      expect(v.text).toContain("12 Harbor Way");
    });
    expect(parsed!.variants![0].html).toContain("utm_campaign=version-1-shared-workspaces-are-here-20261011");
    expect(parsed!.template_snapshot).toMatchObject({ brand_color: "#1a73e8", own_host: "www.brightloop.test", company_name: "Brightloop" });
    expect(parsed).toMatchObject({ sendgrid_sender_id: "41", sendgrid_suppression_group_id: "7", audience_count: 238 });
    expect(parsed!.chosen_variant).toBeUndefined();
    expect(body).not.toHaveProperty("body_text");
    expect(body).not.toHaveProperty("numbers");
  });

  it("with no saved template, drafts one from the brand, saves it, and renders the card with it", async () => {
    const sg = fakeSendgrid();
    const draftAndSave = vi.fn(async () => NORTHWIND_TEMPLATE);
    const { body } = await proposeSendgrid(sg, [version(1)], { template: async () => null, draftAndSave });
    expect(draftAndSave).toHaveBeenCalledWith("tenant-brightloop");
    expect(parseEmailSendBody(body)!.template_snapshot).toMatchObject({ brand_color: "#2e7d32", font_key: "georgia" });
    await expect(
      proposeSendgrid(fakeSendgrid(), [version(1)], { template: async () => null, draftAndSave: async () => { throw new Error("no brand"); } }),
    ).rejects.toMatchObject({ code: "email_template_missing" });
  });

  it("refuses a version with an unsafe link", async () => {
    const sg = fakeSendgrid();
    await expect(proposeSendgrid(sg, [version(1, { button: { label: "Go", url: "javascript:alert(1)" } })])).rejects.toMatchObject({
      code: "email_render_bad_url",
    });
  });
});

describe("a SendGrid card names the sender SendGrid really sends as", () => {
  it("a sender name the agent writes does not replace the verified sender's own name", async () => {
    const sg = fakeSendgrid();
    const { c, emit } = ctx();
    await makeProposeCampaignTool(sgDeps(sg)).execute(c, { route: "sendgrid", audience_id: SG_LIST, variants: [version(1)], from_name: "Acme Team" });
    expect(emit.mock.calls[0][1]).toMatchObject({ from_name: "Brightloop", from_email: "hello@brightloop.test", sendgrid_sender_id: "41" });
  });
});

describe("the card cap reservation follows the card", () => {
  it("a filed card settles its reservation on the card id", async () => {
    const settleCard = vi.fn(async () => {});
    const releaseCard = vi.fn(async () => {});
    await proposeSendgrid(fakeSendgrid(), [version(1)], { settleCard, releaseCard });
    expect(settleCard).toHaveBeenCalledWith("tenant-brightloop", "res-1", ACTION);
    expect(releaseCard).not.toHaveBeenCalled();
  });

  it("any failure before the card is emitted gives the slot back, a generic error included", async () => {
    const releaseCard = vi.fn(async () => {});
    const { c, emit } = ctx();
    const t = makeProposeCampaignTool(sgDeps(fakeSendgrid(), { releaseCard, template: async () => { throw new Error("db blip"); } }));
    await expect(t.execute(c, { route: "sendgrid", audience_id: SG_LIST, variants: [version(1)] })).rejects.toThrow("db blip");
    expect(emit).not.toHaveBeenCalled();
    expect(releaseCard).toHaveBeenCalledWith("tenant-brightloop", "res-1");
  });

  it("must catch: the card writer REFUSING the card (nothing filed) gives the slot back", async () => {
    const releaseCard = vi.fn(async () => {});
    const settleCard = vi.fn(async () => {});
    const emit = vi.fn(async () => {
      throw new ExpectedToolError("email_campaign_body_invalid", "not in the expected shape");
    });
    const t = makeProposeCampaignTool(sgDeps(fakeSendgrid(), { releaseCard, settleCard }));
    await expect(
      t.execute({ tenant_id: "tenant-brightloop", log: () => {}, emit_decision: emit } as never, { route: "sendgrid", audience_id: SG_LIST, variants: [version(1)] }),
    ).rejects.toMatchObject({ code: "email_campaign_body_invalid" });
    expect(releaseCard).toHaveBeenCalledWith("tenant-brightloop", "res-1");
    expect(settleCard).not.toHaveBeenCalled();
  });

  it("must catch G1: the emitter's typed no-write refusal (a gate, an {ok:false} RPC) gives the slot back too", async () => {
    const { EmitNoWriteError } = await import("@/services/agents/emit-no-write");
    const releaseCard = vi.fn(async () => {});
    const emit = vi.fn(async () => {
      throw new EmitNoWriteError("record_channel_exec_action refused: kill_switch");
    });
    const t = makeProposeCampaignTool(sgDeps(fakeSendgrid(), { releaseCard }));
    await expect(
      t.execute({ tenant_id: "tenant-brightloop", log: () => {}, emit_decision: emit } as never, { route: "sendgrid", audience_id: SG_LIST, variants: [version(1)] }),
    ).rejects.toThrow("kill_switch");
    expect(releaseCard).toHaveBeenCalledWith("tenant-brightloop", "res-1");
  });

  it("a failure once the card was emitted keeps the slot (the card may exist)", async () => {
    const releaseCard = vi.fn(async () => {});
    const settleCard = vi.fn(async () => {});
    const emit = vi.fn(async () => {
      throw new Error("answer lost");
    });
    const t = makeProposeCampaignTool(sgDeps(fakeSendgrid(), { releaseCard, settleCard }));
    await expect(
      t.execute({ tenant_id: "tenant-brightloop", log: () => {}, emit_decision: emit } as never, { route: "sendgrid", audience_id: SG_LIST, variants: [version(1)] }),
    ).rejects.toThrow("answer lost");
    expect(emit).toHaveBeenCalled();
    expect(releaseCard).not.toHaveBeenCalled();
    expect(settleCard).not.toHaveBeenCalled();
  });
});

describe("What we learned on the card", () => {
  const view = (body: Record<string, unknown>) =>
    cardView("channel_actions", ACTION, { ok: true, class: "email_campaign.create_and_send", body, open: true, status: "pending", role: "owner", versions: 1, tests: [] });

  it("the exact lines the drafting run read go onto the card, with what happened", async () => {
    const items = [{ id: "l1", text: "Emails with a number in the subject got more clicks." }];
    const { body } = await proposeSendgrid(fakeSendgrid(), [version(1)], { learningsRead: async () => ({ status: "ok", items }) });
    expect(body.learnings_read).toEqual({ status: "ok", items });
    expect(view(body).learnings_read).toEqual({ status: "ok", items });
  });

  it("must catch: a run whose read could not be found says so (snapshot_failed), never claims lines; a failed read says read_failed", async () => {
    const failed = await proposeSendgrid(fakeSendgrid(), [version(1)], { learningsRead: async () => ({ status: "snapshot_failed", items: [] }) });
    expect(view(failed.body).learnings_read).toEqual({ status: "snapshot_failed", items: [] });
    const unread = await proposeSendgrid(fakeSendgrid(), [version(1)], { learningsRead: async () => ({ status: "read_failed", items: [] }) });
    expect(view(unread.body).learnings_read.status).toBe("read_failed");
    const threw = await proposeSendgrid(fakeSendgrid(), [version(1)], { learningsRead: async () => Promise.reject(new Error("down")) });
    expect(threw.body.learnings_read).toEqual({ status: "snapshot_failed", items: [] });
  });

  it("outside an agent run there is no field; an older card's bare list reads as ok", async () => {
    const none = await proposeSendgrid(fakeSendgrid(), [version(1)], { learningsRead: async () => null });
    expect("learnings_read" in none.body).toBe(false);
    expect(view(none.body).learnings_read).toEqual({ status: null, items: [] });
    expect(view({ ...none.body, learnings_read: [{ id: "a", text: "b" }] }).learnings_read).toEqual({ status: "ok", items: [{ id: "a", text: "b" }] });
  });
});

describe("the sender and unsubscribe group picked in settings", () => {
  const picks = (sender: string | null, group: string | null) => async (_t: string, field: string) =>
    field === "sendgrid_sender_id" ? sender : field === "sendgrid_suppression_group_id" ? group : null;

  it("are sealed on the card instead of the defaults", async () => {
    const sg = fakeSendgrid();
    sg.senders.push({ id: 52, from_email: "news@brightloop.test", from_name: "Brightloop News", verified: true });
    const { body } = await proposeSendgrid(sg, [version(1)], { setting: picks("52", "8") });
    expect(body).toMatchObject({ sendgrid_sender_id: "52", sendgrid_suppression_group_id: "8", from_email: "news@brightloop.test", from_name: "Brightloop News" });
  });

  it("a SendGrid read that fails is reported as a read failure, not as a pick that is gone", async () => {
    for (const failing of ["SENDGRID_VERIFIED_SENDERS", "SENDGRID_SUPPRESSION_GROUPS"]) {
      const sg = fakeSendgrid();
      const real = sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch);
      const callFor = (() => async (op: string, args: Record<string, unknown>) =>
        op === failing ? { ok: false, status: 503, data: null, error: "HTTP 503", outcome_unknown: false } : real(op as never, args)) as unknown as ProposeCampaignDeps["callFor"];
      await expect(proposeSendgrid(sg, [version(1)], { setting: picks("41", "7"), callFor })).rejects.toMatchObject({ code: "email_tool_read_failed" });
    }
  });

  it("a pick that is no longer in SendGrid proposes nothing", async () => {
    await expect(proposeSendgrid(fakeSendgrid(), [version(1)], { setting: picks("999", null) })).rejects.toMatchObject({ code: "email_sender_unknown" });
    await expect(proposeSendgrid(fakeSendgrid(), [version(1)], { setting: picks(null, "999") })).rejects.toMatchObject({ code: "email_sender_unknown" });
  });
});

describe("what is approved is what is sent", () => {
  it("a template edit after proposal does not change the sealed bytes, and the CHOSEN version's bytes go out", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1), version(2), version(3)]);
    const after = await proposeSendgrid(fakeSendgrid(), [version(1), version(2), version(3)], { template: async () => EDITED_TEMPLATE });
    const sealed = parseEmailSendBody(body)!;
    expect((after.body as { variants: Array<{ html: string }> }).variants[1].html).not.toBe(sealed.variants![1].html);

    const r = await executeEmailCampaignSend(run({ ...body, chosen_variant: 2 }), execDeps(sg));
    expect(r).toMatchObject({ ok: true });
    expect(sg.sends).toHaveLength(1);
    expect(sg.sends[0].html).toBe(sealed.variants![1].html);
    expect(sg.sends[0].plain).toBe(sealed.variants![1].text);
    expect(sg.sends[0].subject).toBe("Version 2: shared workspaces are here");
    expect(sg.sends[0].html).not.toContain("#c2185b");
    expect(sg.count("PUT", /\/schedule$/)).toBe(1);
  });

  it("a versions card with no chosen version, or bytes that do not match their seal, sends nothing", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1), version(2)]);
    const before = sg.requests.length;
    const none = await executeEmailCampaignSend(run(body), execDeps(sg));
    expect(none).toMatchObject({ ok: false, code: "email_version_not_chosen" });
    const variants = (body.variants as Array<{ html: string }>).map((v, i) => (i === 0 ? { ...v, html: v.html.replace("angle 1", "angle 9") } : v));
    const tampered = await executeEmailCampaignSend(run({ ...body, variants, chosen_variant: 1 }), execDeps(sg));
    expect(tampered).toMatchObject({ ok: false, code: "email_version_not_chosen" });
    expect(sg.requests).toHaveLength(before);
  });

  it("a body that mixes a text email with versions is refused by the one parser", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    expect(parseEmailSendBody({ ...body, body_text: "smuggled text" })).toBeNull();
  });
});

describe("test lists never get a real send", () => {
  it("refused at proposal (email tool and Zavi list) and again at send", async () => {
    const sg = fakeSendgrid();
    await expect(proposeSendgrid(sg, [version(1)], { testLists: async () => new Set([`sendgrid:${SG_LIST}`]) })).rejects.toMatchObject({ code: "email_test_list" });

    const { body } = await proposeSendgrid(sg, [version(1)]);
    const r = await executeEmailCampaignSend(run({ ...body, chosen_variant: 1 }), execDeps(sg, { testListKeys: async () => new Set([`sendgrid:${SG_LIST}`]) }));
    expect(r).toMatchObject({ ok: false, code: "email_test_list" });
    expect(sg.sends).toHaveLength(0);

    const z = zaviTool({ testLists: async () => new Set([`zavi_list:${ZLIST}`]) });
    await expect(z.t.execute(z.c, { route: "zavi_list", list_id: ZLIST, variants: [version(1)] })).rejects.toMatchObject({ code: "email_test_list" });
  });

  it("a Zavi-list send to a list marked after approve is refused before anything is frozen", async () => {
    const z = zaviTool();
    await z.t.execute(z.c, { route: "zavi_list", list_id: ZLIST, variants: [version(1)] });
    const h = bulkHarness();
    const body = { ...(z.emit.mock.calls[0][1] as Record<string, unknown>), chosen_variant: 1 };
    const r = await executeBulkOutboundDispatch({
      tenant_id: ZTENANT,
      decision_id: ZDECISION,
      approved_by: "user-a",
      body,
      deps: { ...h.deps, testListKeys: async () => new Set([`zavi_list:${ZLIST}`]) },
    });
    expect(r).toMatchObject({ ok: false, code: "email_test_list" });
    expect(h.ledger.sends.size).toBe(0);
    expect(h.wire).not.toHaveBeenCalled();
  });
});

describe("a list marked after approve, before the send", () => {
  const markedLater = () => {
    let n = 0;
    return async () => (++n === 1 ? new Set<string>() : new Set([`sendgrid:${SG_LIST}`, `zavi_list:${ZLIST}`]));
  };

  it("email tool: the last check before the send refuses it; nothing is sent", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    const r = await executeEmailCampaignSend(run({ ...body, chosen_variant: 1 }), execDeps(sg, { testListKeys: markedLater() }));
    expect(r).toMatchObject({ ok: false, code: "email_test_list" });
    expect(sg.sends.filter((x) => x.status !== "draft")).toHaveLength(0);
  });

  it("Zavi list: the check right before the first chunk holds the send for good; nobody is emailed", async () => {
    const z = zaviTool();
    await z.t.execute(z.c, { route: "zavi_list", list_id: ZLIST, variants: [version(1)] });
    const h = bulkHarness();
    const body = { ...(z.emit.mock.calls[0][1] as Record<string, unknown>), chosen_variant: 1 };
    const r = await executeBulkOutboundDispatch({ tenant_id: ZTENANT, decision_id: ZDECISION, approved_by: "user-a", body, deps: { ...h.deps, testListKeys: markedLater() } });
    expect(r).toMatchObject({ ok: false, code: "email_test_list" });
    expect(h.wire).not.toHaveBeenCalled();
    const send = [...h.ledger.sends.values()][0] as { status: string; hold_reason: string | null };
    expect(send).toMatchObject({ status: "held", hold_reason: "email_test_list" });
  });
});

describe("the list is counted again right before the send", () => {
  it("a list that grew more than 10% since approve is not sent; within 10% it is", async () => {
    const grown = fakeSendgrid();
    const { body } = await proposeSendgrid(grown, [version(1)]);
    grown.lists[0].contact_count = 238 + 30;
    const r = await executeEmailCampaignSend(run({ ...body, chosen_variant: 1 }), execDeps(grown));
    expect(r).toMatchObject({ ok: false, code: "email_list_grew" });
    expect(r.error).toMatch(/grew from 238 to 268/);
    expect(grown.count("PUT", /\/schedule$/)).toBe(0);

    const ok = fakeSendgrid();
    ok.lists[0].contact_count = 238 + 20;
    expect(await executeEmailCampaignSend(run({ ...body, chosen_variant: 1 }), execDeps(ok))).toMatchObject({ ok: true });
  });

  it("the count stamped at approve wins over the count on the card; Autopilot stops above its cap", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    sg.lists[0].contact_count = 300;
    expect(await executeEmailCampaignSend(run({ ...body, chosen_variant: 1, approved_count: 290 }), execDeps(sg))).toMatchObject({ ok: true });
    expect(countAtSendRefusal({ approved: 1_000, live: 1_001, byAutopilot: true })).toMatch(/Autopilot/);
    expect(countAtSendRefusal({ approved: 1_000, live: 1_001, byAutopilot: false })).toBeNull();
    expect(countAtSendRefusal({ approved: 950, live: AUTOPILOT_SEND_CAP, byAutopilot: true })).toBeNull();
  });

  const countPath = /\/v3\/marketing\/lists\/[^/]+\/contacts\/count$/;
  const listPath = /\/v3\/marketing\/lists\/[^/]+$/;

  it("the list grows after the first read and the last count cannot be read: nothing is sent", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    const base = sg.fetch;
    sg.fetch = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (countPath.test(path)) return new Response(JSON.stringify({ errors: [{ message: "unavailable" }] }), { status: 503, headers: { "content-type": "application/json" } });
      const res = await base(input, init);
      if (listPath.test(path)) sg.lists[0].contact_count = 900;
      return res;
    }) as unknown as typeof fetch;
    const r = await executeEmailCampaignSend(run({ ...body, chosen_variant: 1 }), execDeps(sg));
    expect(r).toMatchObject({ ok: false, code: "email_count_unreadable" });
    expect(r.error).toContain("Nothing was sent");
    expect(sg.count("PUT", /\/schedule$/)).toBe(0);
    expect(sg.sends.filter((x) => x.status !== "draft")).toHaveLength(0);
  });

  it("a send SendGrid asks to retry is not retried when the list grew and its count cannot be read", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    sg.failOnce.set("PUT /v3/marketing/singlesends/{id}/schedule", 429);
    const base = sg.fetch;
    let counts = 0;
    sg.fetch = (async (input: string | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (countPath.test(path) && ++counts > 1) {
        sg.lists[0].contact_count = 900;
        return new Response(JSON.stringify({ errors: [{ message: "unavailable" }] }), { status: 503, headers: { "content-type": "application/json" } });
      }
      return base(input, init);
    }) as unknown as typeof fetch;
    const r = await executeEmailCampaignSend(run({ ...body, chosen_variant: 1 }), execDeps(sg));
    expect(counts).toBe(2);
    expect(r).toMatchObject({ ok: false, code: "exec_partial", not_sent: true });
    expect(r.error).toContain("did not say how many people");
    expect(sg.sends.filter((x) => x.status !== "draft")).toHaveLength(0);
  });

  it("an Autopilot planned send whose list grew says the planned send did not go out and what to do", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    sg.lists[0].contact_count = 400;
    const r = await executeEmailCampaignSend(
      run({ ...body, chosen_variant: 1, approved_count: 238, planned_send_id: "plan-item-1", plan_version: 1 }, "cgo"),
      execDeps(sg),
    );
    expect(r).toMatchObject({ ok: false, code: "email_list_grew", held_for_founder: true });
    expect(r.error).toContain("did not send this planned email");
    expect(r.error).toContain("grew from 238 to 400");
    expect(r.error).toContain("will not go out on its own");
    expect(r.error).toContain("Send it yourself");
    expect(r.error).not.toContain("Approve it again");
    expect(sg.count("PUT", /\/schedule$/)).toBe(0);

    const plain = countAtSendRefusal({ approved: 238, live: 400, byAutopilot: true });
    expect(plain).toContain("Approve it again");
    expect(countAtSendRefusal({ approved: 238, live: 400, byAutopilot: false, planned: true })).toBe(plain);
    expect(countAtSendRefusal({ approved: 238, live: 260, byAutopilot: true, planned: true })).toBeNull();
  });
});

function northwindList(over: Partial<ListSummary> = {}): ListSummary {
  return {
    id: ZLIST,
    name: "Patients who opted in",
    created_at: "2026-10-07T00:00:00Z",
    latest: { id: ZVERSION, source_kind: "csv", source_label: "email", contact_count: 3, created_at: "2026-10-07T00:00:00Z", consented: true },
    active: { id: ZVERSION, source_kind: "csv", contact_count: 3, sendable: 3, unsubscribed_or_bounced: 0 },
    needs_consent: false,
    ...over,
  } as ListSummary;
}

function zaviTool(over: Partial<ProposeCampaignDeps> = {}, lists: ListSummary[] = [northwindList()]) {
  const emit = vi.fn(async (_cls: string, _body: unknown) => ZDECISION);
  const c = { tenant_id: ZTENANT, log: () => {}, emit_decision: emit } as never;
  const t = makeProposeCampaignTool({
    template: async () => NORTHWIND_TEMPLATE,
    company: async () => ({ name: "Northwind Clinic", website: null }),
    testLists: async () => new Set<string>(),
    checkSender: (async () => ({ ok: true, sender: { domain: "acme.com", from_address: "hello@acme.com", from_name: null }, postal_address: "400 Elm St" })) as unknown as ProposeCampaignDeps["checkSender"],
    lists: async () => lists,
    source: () => ({
      async fetchCandidates() {
        return [
          { email: "a@x.com", opt_in_marketing: true },
          { email: "b@x.com", opt_in_marketing: true },
          { email: "c@x.com", opt_in_marketing: true },
        ];
      },
    }),
    replyTo: async () => "founder@acme.com",
    now: () => new Date("2026-10-11T12:00:00Z"),
    reserveCard: async () => ({ ok: true as const, id: "res-1" }),
    releaseCard: async () => {},
    settleCard: async () => {},
    ...over,
  });
  return { t, c, emit };
}

describe("a Zavi list keeps its sealed version, and its fanout sends the frozen bytes", () => {
  it("seals the confirmed list version, freezes the chosen version's bytes, and each person gets them with only their unsubscribe link filled in", async () => {
    const z = zaviTool();
    await z.t.execute(z.c, { route: "zavi_list", list_id: ZLIST, variants: [version(1), version(2)] });
    const [cls, raw] = z.emit.mock.calls[0];
    expect(cls).toBe("bulk_outbound.send");
    const proposed = raw as { list_version_id: string; variants: Array<{ html: string; text: string; render_sha: string }>; template?: unknown };
    expect(proposed.list_version_id).toBe(ZVERSION);
    expect(proposed.template).toBeUndefined();
    expect(proposed.variants[1].html).toContain(UNSUBSCRIBE_HREF.zavi_list);
    expect(proposed.variants[1].html).toContain("Northwind Clinic");

    const h = bulkHarness();
    const r = await executeBulkOutboundDispatch({ tenant_id: ZTENANT, decision_id: ZDECISION, approved_by: "user-a", body: { ...proposed, chosen_variant: 2 }, deps: { ...h.deps, testListKeys: async () => new Set<string>() } });
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });
    const send = [...h.ledger.sends.values()][0];
    expect(send.list_version_id).toBe(ZVERSION);
    expect(send.subject).toBe("Version 2: shared workspaces are here");
    expect(send.body_html).toBe(proposed.variants[1].html);
    expect(send.render_sha).toBe(proposed.variants[1].render_sha);

    const msg = h.wire.mock.calls[0][0] as BulkWireMessage;
    expect(msg.bodyHtml).toBe(proposed.variants[1].html);
    const payload = buildBulkPayload(msg) as { content: Array<{ type: string; value: string }> };
    const html = payload.content.find((p) => p.type === "text/html")!.value;
    const text = payload.content.find((p) => p.type === "text/plain")!.value;
    expect(html).not.toContain(UNSUBSCRIBE_HREF.zavi_list);
    const url = unsubscribeUrl(msg.unsubToken);
    expect(html.split(url.replace(/&/g, "&amp;")).join(UNSUBSCRIBE_HREF.zavi_list)).toBe(proposed.variants[1].html);
    expect(text.split(url).join(UNSUBSCRIBE_HREF.zavi_list)).toBe(proposed.variants[1].text);
    expect(text).toContain(url);
  });

  it("a versions card with no chosen version freezes nothing", async () => {
    const z = zaviTool();
    await z.t.execute(z.c, { route: "zavi_list", list_id: ZLIST, variants: [version(1)] });
    const h = bulkHarness();
    const r = await executeBulkOutboundDispatch({ tenant_id: ZTENANT, decision_id: ZDECISION, approved_by: "user-a", body: z.emit.mock.calls[0][1], deps: { ...h.deps, testListKeys: async () => new Set<string>() } });
    expect(r).toMatchObject({ ok: false, code: "email_version_not_chosen" });
    expect(h.ledger.sends.size).toBe(0);
  });
});

describe("another workspace's list is never reachable", () => {
  it("a Zavi list id from another workspace is not found; an email-tool list id the tenant's own tool does not have is refused", async () => {
    const z = zaviTool({}, [northwindList({ id: "99999999-9999-4999-8999-999999999999" })]);
    await expect(z.t.execute(z.c, { route: "zavi_list", list_id: ZLIST, variants: [version(1)] })).rejects.toMatchObject({ code: "list_not_found" });
    expect(z.emit).not.toHaveBeenCalled();

    const sg = fakeSendgrid();
    const { c, emit } = ctx();
    const err = await makeProposeCampaignTool(sgDeps(sg))
      .execute(c, { route: "sendgrid", audience_id: "other-workspace-list", variants: [version(1)] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ExpectedToolError);
    expect(err.code).toBe("email_audience_missing");
    expect(emit).not.toHaveBeenCalled();
  });

  it("a SendGrid card never reaches a list the connected key's account does not hold", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    const other = "SG.otherWorkspaceKey01.otherSecret_abcdefghijklmnopqrs";
    sg.key = other;
    sg.lists = [];
    const r = await executeEmailCampaignSend(
      run({ ...body, chosen_variant: 1 }),
      execDeps(sg, { resolveSendgrid: async () => ({ api_key: other, key_digest: sendgridKeyDigest(other) }) }),
    );
    expect(r).toMatchObject({ ok: false, code: "email_audience_missing" });
    expect(sg.count("PUT", /schedule$/)).toBe(0);
  });
});

describe("a chat redraft replaces the old card", () => {
  it("files the new card, then closes the old one with a pointer to it", async () => {
    const sg = fakeSendgrid();
    const replaceCard = vi.fn(async () => true);
    const { c, emit } = ctx();
    const old = { rail: "channel_actions" as const, id: "55555555-5555-4555-8555-555555555555" };
    const out = await makeProposeCampaignTool(sgDeps(sg, { replaceCard })).execute(c, { route: "sendgrid", audience_id: SG_LIST, variants: [version(1)], replaces: old, changes: ["subject", "preview_text", "title", "paragraphs", "button"] });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(replaceCard).toHaveBeenCalledWith("tenant-brightloop", old, { rail: "channel_actions", id: ACTION });
    expect(out).toMatchObject({ replaced_previous: true, card: { rail: "channel_actions", id: ACTION } });
  });

  it("an already-decided old card is left alone, and a failed close never undoes the new card", async () => {
    const sg = fakeSendgrid();
    const old = { rail: "decisions" as const, id: "55555555-5555-4555-8555-555555555555" };
    const left = await makeProposeCampaignTool(sgDeps(sg, { replaceCard: async () => false })).execute(ctx().c, { route: "sendgrid", audience_id: SG_LIST, variants: [version(1)], replaces: old, changes: ["subject", "preview_text", "title", "paragraphs", "button"] });
    expect(left).toMatchObject({ replaced_previous: false });
    expect(String(left.note)).toMatch(/already decided/);
    const failed = await makeProposeCampaignTool(sgDeps(sg, { replaceCard: async () => { throw new Error("db"); } })).execute(ctx().c, { route: "sendgrid", audience_id: SG_LIST, variants: [version(1)], replaces: old, changes: ["subject", "preview_text", "title", "paragraphs", "button"] });
    expect(failed).toMatchObject({ action_id: ACTION, replaced_previous: false });
  });
});

describe("editing a version on the card", () => {
  async function cardBody() {
    return (await proposeSendgrid(fakeSendgrid(), [version(1), version(2)])).body;
  }
  function rpcFor(body: Record<string, unknown>, open = true) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc = (async (_t: string, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "email_card_view_state") return { ok: true, class: "email_campaign.create_and_send", body, open, status: "pending", role: "member", versions: 2, tests: [] };
      if (name === "edit_email_card_variant") return { ok: true };
      throw new Error(name);
    }) as CardDeps["rpc"];
    return { rpc, calls };
  }

  it("re-renders with the card's OWN template snapshot and sends the read body as the guard", async () => {
    const body = await cardBody();
    const { rpc, calls } = rpcFor(body);
    const edited = version(2, { subject: "A sharper subject" });
    expect(await editEmailCardVersion("tenant-brightloop", "channel_actions", ACTION, 2, "u-member", edited, { rpc })).toEqual({ ok: true });
    const w = calls.find((c) => c.name === "edit_email_card_variant")!.args as { p_sealed: { html: string; text: string; render_sha: string }; p_expected_body: unknown; p_variant: number };
    expect(w.p_variant).toBe(2);
    expect(w.p_expected_body).toBe(body);
    expect(w.p_sealed.html).toContain("background-color:#0b8043");
    expect(w.p_sealed.html).toContain("Thanks,<br>The Brightloop team");
    expect(w.p_sealed.html).not.toContain("Cheers");
    expect(w.p_sealed.html).toContain("A sharper subject");
    expect(w.p_sealed.render_sha).toBe(shaOf("email-r1", w.p_sealed.html, w.p_sealed.text));
    expect(w.p_sealed.html).not.toBe((body.variants as Array<{ html: string }>)[1].html);
  });

  it("refuses an unsafe link, a missing field, a decided card, and a version that does not exist", async () => {
    const body = await cardBody();
    const { rpc, calls } = rpcFor(body);
    expect(await editEmailCardVersion("t", "channel_actions", ACTION, 1, "u", version(1, { button: { label: "Go", url: "javascript:alert(1)" } }), { rpc })).toMatchObject({ ok: false, code: "bad_content" });
    expect(await editEmailCardVersion("t", "channel_actions", ACTION, 1, "u", { subject: "only" }, { rpc })).toMatchObject({ ok: false, code: "bad_content" });
    expect(await editEmailCardVersion("t", "channel_actions", ACTION, 3, "u", version(1), { rpc })).toMatchObject({ ok: false, code: "bad_variant" });
    expect(await editEmailCardVersion("t", "channel_actions", ACTION, 1, "u", version(1), { rpc: rpcFor(body, false).rpc })).toMatchObject({ ok: false, code: "not_open" });
    expect(calls.some((c) => c.name === "edit_email_card_variant")).toBe(false);
  });
});

describe("who is told how a send ended", () => {
  function tellDeps(over: Partial<OutcomeDeps> = {}) {
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const claimed = new Set<string>();
    const released: string[] = [];
    const deps: Partial<OutcomeDeps> = {
      readCard: async () => ({ body: { variants: [{ content: { subject: "Version 2: shared workspaces are here" } }], chosen_variant: 1, list_name: "Patients who opted in" }, approved_by: "u-admin", approved_by_source: null }),
      claim: async (_t, rail, id, outcome, _line, kind) => {
        const k = `${rail}:${id}:${outcome}:${kind ?? ""}`;
        if (claimed.has(k)) return false;
        claimed.add(k);
        return true;
      },
      release: async (_t, rail, id, outcome, kind) => {
        released.push(`${rail}:${id}:${outcome}:${kind ?? ""}`);
        claimed.delete(`${rail}:${id}:${outcome}:${kind ?? ""}`);
      },
      emailOf: async (u) => (u === "u-admin" ? "admin@northwind.test" : null),
      ownerEmail: async () => "owner@northwind.test",
      send: async (to, subject, _h, text) => {
        sent.push({ to, subject, text });
      },
      startResults: async () => undefined,
      ...over,
    };
    return { deps, sent, claimed, released };
  }

  it("a send that throws gives the claim back, so the next teller of the same end emails the approver exactly once", async () => {
    const attempts: string[] = [];
    let fail = true;
    const { deps, sent, claimed, released } = tellDeps();
    const send = deps.send!;
    deps.send = async (to, subject, html, text) => {
      attempts.push(to);
      if (fail) {
        fail = false;
        throw new Error("SendGrid 503");
      }
      await send(to, subject, html, text);
    };
    const o = { tenant_id: ZTENANT, rail: "decisions" as const, card_id: ZDECISION, outcome: "failed" as const, sent: 40, total: 120, reason: "The sending domain stopped verifying." };
    const k = `decisions:${ZDECISION}:failed:`;
    expect(await notifyEmailSendOutcome(o, deps)).toBe(false);
    expect(sent).toHaveLength(0);
    expect(await notifyEmailSendOutcome(o, deps)).toBe(true);
    expect(await notifyEmailSendOutcome(o, deps)).toBe(false);
    expect(attempts).toEqual(["admin@northwind.test", "admin@northwind.test"]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "admin@northwind.test", subject: "Stopped part way: Version 2: shared workspaces are here" });
    expect(released).toEqual([k]);
    expect(claimed.has(k)).toBe(true);
  });

  it("a delivered telling keeps its claim: a second teller of the same end never emails again", async () => {
    const { deps, sent, claimed, released } = tellDeps();
    const o = { tenant_id: ZTENANT, rail: "channel_actions" as const, card_id: ZDECISION, outcome: "failed" as const, sent: null, reason: "x", kind: "audience_mismatch" as const };
    expect(await notifyEmailSendOutcome(o, deps)).toBe(true);
    expect(await notifyEmailSendOutcome(o, deps)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(released).toEqual([]);
    expect(claimed.has(`channel_actions:${ZDECISION}:failed:audience_mismatch`)).toBe(true);
  });

  it("nobody to email gives the claim back, so a later teller that finds the approver emails them exactly once", async () => {
    let address: string | null = null;
    const attempts: string[] = [];
    const { deps, sent, released, claimed } = tellDeps({ emailOf: async () => address });
    const send = deps.send!;
    deps.send = async (to, subject, html, text) => {
      attempts.push(to);
      await send(to, subject, html, text);
    };
    const o = { tenant_id: ZTENANT, rail: "decisions" as const, card_id: ZDECISION, outcome: "sent" as const, sent: 3, total: 3 };
    const { tellEmailSendOutcome } = await vi.importActual<typeof import("../outcome")>("../outcome");
    expect(await tellEmailSendOutcome(o, deps)).toBe("skipped");
    expect(released).toEqual([`decisions:${ZDECISION}:sent:`]);
    expect(claimed.has(`decisions:${ZDECISION}:sent:`)).toBe(false);
    address = "admin@northwind.test";
    expect(await notifyEmailSendOutcome(o, deps)).toBe(true);
    expect(await notifyEmailSendOutcome(o, deps)).toBe(false);
    expect(attempts).toEqual(["admin@northwind.test"]);
    expect(sent.map((m) => m.to)).toEqual(["admin@northwind.test"]);
  });

  it("a release that fails is swallowed: the telling still answers false and never throws", async () => {
    const releaseCalls: string[] = [];
    const { deps, sent } = tellDeps({
      send: async () => {
        throw new Error("SendGrid 503");
      },
      release: async (_t, _r, id) => {
        releaseCalls.push(id);
        throw new Error("database down");
      },
    });
    const o = { tenant_id: ZTENANT, rail: "decisions" as const, card_id: ZDECISION, outcome: "failed" as const, sent: 0, reason: "x" };
    await expect(notifyEmailSendOutcome(o, deps)).resolves.toBe(false);
    expect(releaseCalls).toEqual([ZDECISION]);
    expect(sent).toHaveLength(0);
  });

  it("results start where the end is told: a send, or a stop after people were emailed; never blocking the email", async () => {
    const started: unknown[] = [];
    const { deps, sent } = tellDeps({
      startResults: async (o) => {
        started.push([o.outcome, o.sent]);
        throw new Error("database down");
      },
    });
    await notifyEmailSendOutcome({ tenant_id: ZTENANT, rail: "decisions", card_id: ZDECISION, outcome: "sent", sent: 3 }, deps);
    await notifyEmailSendOutcome({ tenant_id: ZTENANT, rail: "decisions", card_id: ZDECISION, outcome: "failed", sent: 40, total: 120, reason: "x" }, deps);
    await notifyEmailSendOutcome({ tenant_id: ZTENANT, rail: "channel_actions", card_id: ZDECISION, outcome: "failed", sent: 0, reason: "x" }, deps);
    expect(started).toEqual([["sent", 3], ["failed", 40]]);
    expect(sent).toHaveLength(3);
  });

  it("the approver is emailed once per outcome, with the count and a link to the card", async () => {
    const { deps, sent } = tellDeps();
    const o = { tenant_id: ZTENANT, rail: "decisions" as const, card_id: ZDECISION, outcome: "sent" as const, sent: 3, total: 3 };
    expect(await notifyEmailSendOutcome(o, deps)).toBe(true);
    expect(await notifyEmailSendOutcome(o, deps)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "admin@northwind.test", subject: "Sent: Version 2: shared workspaces are here" });
    expect(sent[0].text).toContain('was sent to 3 people on "Patients who opted in"');
    expect(sent[0].text).toContain(`/workspace/email-cards/decisions/${ZDECISION}`);
  });

  it("an Autopilot send emails the owner; a partial failure says how far it got and why", async () => {
    const { deps, sent } = tellDeps({ readCard: async () => ({ body: { variants: [{ content: { subject: "S" } }], list_name: "L" }, approved_by: "u-owner", approved_by_source: "cgo" }) });
    await notifyEmailSendOutcome({ tenant_id: ZTENANT, rail: "decisions", card_id: ZDECISION, outcome: "failed", sent: 40, total: 120, reason: "The sending domain stopped verifying." }, deps);
    expect(sent[0].to).toBe("owner@northwind.test");
    expect(sent[0].text).toContain('stopped after 40 of 120 people on "L". The sending domain stopped verifying.');
  });

  it("a different-list email and a plain failure of the same card are each sent once; the different-list one never says it finished sending", async () => {
    const { deps, sent } = tellDeps();
    const mismatch = { tenant_id: ZTENANT, rail: "decisions" as const, card_id: ZDECISION, outcome: "failed" as const, sent: null, reason: "SendGrid is sending this campaign to a different list than the card.", kind: "audience_mismatch" as const };
    const plain = { tenant_id: ZTENANT, rail: "decisions" as const, card_id: ZDECISION, outcome: "failed" as const, sent: 0, reason: "Nothing was sent." };
    expect(await notifyEmailSendOutcome(mismatch, deps)).toBe(true);
    expect(await notifyEmailSendOutcome(plain, deps)).toBe(true);
    expect(await notifyEmailSendOutcome(mismatch, deps)).toBe(false);
    expect(sent.map((s) => s.subject)).toEqual(["Check your email tool: Version 2: shared workspaces are here", "Not sent: Version 2: shared workspaces are here"]);
    const html = renderEmailSendOutcomeEmail({ outcome: "failed", subject: "S", listName: "L", sent: null, total: null, reason: "x", cardUrl: "https://x.test", byAutopilot: false, kind: "audience_mismatch" }).html;
    expect(html).not.toContain("finished sending");
    expect(html).toContain("going out to a different list");
  });

  it("the executor routes a same-name campaign already going out to another list through the different-list outcome", async () => {
    const told: unknown[] = [];
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    const payload: Record<string, unknown> = { ...body, chosen_variant: 1 };
    const { campaignTitleFor, messageOf, parseEmailSendBody } = await import("@/services/connectors/email-campaign/execute-send");
    const parsed = parseEmailSendBody(payload)!;
    const picked = messageOf(parsed);
    if (!picked.ok) throw new Error("no version");
    sg.sends.push({ id: "ss-same-name", name: campaignTitleFor(ACTION, picked.m.subject), status: "triggered", list_ids: ["some-other-list"], segment_ids: [], subject: null, html: null, plain: null, sender_id: null, suppression_group_id: null, created_at: new Date().toISOString() });
    const alerts: string[] = [];
    const r = await executeEmailCampaignSendAndTell(run(payload), execDeps(sg, { reportAudience: async (_t, id) => void alerts.push(id) }), async (o) => told.push(o));
    expect(r).toMatchObject({ ok: false, code: "exec_partial", audience_mismatch: true });
    expect(alerts).toEqual([ACTION]);
    expect(told).toEqual([expect.objectContaining({ outcome: "failed", kind: "audience_mismatch" })]);
  });

  it("a text-only card is not told here", async () => {
    const { deps, sent } = tellDeps({ readCard: async () => ({ body: { template: { subject: "s", body_text: "b" } }, approved_by: "u-admin", approved_by_source: null }) });
    expect(await notifyEmailSendOutcome({ tenant_id: ZTENANT, rail: "decisions", card_id: ZDECISION, outcome: "sent", sent: 1 }, deps)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("the executor tells on a send and on a refusal, never on an unclear outcome", async () => {
    const told: unknown[] = [];
    const tell = async (o: unknown) => told.push(o);
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    await executeEmailCampaignSendAndTell(run({ ...body, chosen_variant: 1 }), execDeps(sg), tell);
    expect(told).toEqual([{ tenant_id: "tenant-brightloop", rail: "channel_actions", card_id: ACTION, outcome: "sent", sent: 238 }]);
    await executeEmailCampaignSendAndTell(run(body), execDeps(fakeSendgrid()), tell);
    expect(told[1]).toMatchObject({ outcome: "failed", sent: 0 });
    told.length = 0;
    const r = await executeEmailCampaignSendAndTell(
      run({ ...body, chosen_variant: 1 }),
      execDeps(fakeSendgrid(), { readProgress: async () => ({ campaign_id: "ss-1", stage: "send_requested" }) as never }),
      tell,
    );
    expect(r).toMatchObject({ ok: false, outcome_unknown: true });
    expect(told).toEqual([]);
  });

  it("no outcome email while unknown; a campaign going to another list gets its own email, once", async () => {
    const told: unknown[] = [];
    const tell = async (o: unknown) => told.push(o);
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    const prior = { campaign_id: "ss-earlier", stage: "content_set" } as never;
    const unread = await executeEmailCampaignSendAndTell(
      run({ ...body, chosen_variant: 1 }),
      execDeps(sg, { readProgress: async () => prior, resolveSendgrid: async () => null }),
      tell,
    );
    expect(unread).toMatchObject({ ok: false, outcome_unknown: true });
    expect(told).toEqual([]);
    sg.sends.push({ id: "ss-earlier", name: "x", status: "triggered", list_ids: ["some-other-list"], segment_ids: [], subject: null, html: null, plain: null, sender_id: null, suppression_group_id: null, created_at: new Date().toISOString() });
    const other = await executeEmailCampaignSendAndTell(run({ ...body, chosen_variant: 1 }), execDeps(sg, { readProgress: async () => prior, reportAudience: async () => undefined }), tell);
    expect(other).toMatchObject({ ok: false, code: "exec_partial", audience_mismatch: true });
    expect(told).toEqual([
      { tenant_id: "tenant-brightloop", rail: "channel_actions", card_id: ACTION, outcome: "failed", sent: null, reason: expect.stringMatching(/different list than the card/), kind: "audience_mismatch" },
    ]);
    const line = emailSendOutcomeLine({ outcome: "failed", subject: "S", listName: "L", sent: null, total: null, reason: other.error ?? null, kind: "audience_mismatch" });
    expect(line).toBe('Your email "S" was not sent to "L" by Zavi. SendGrid is sending this campaign to a different list than the card. Zavi did not start that send and will not send this card again. Check it in SendGrid.');
    expect(line).not.toMatch(/was not sent\./);
  });

  it("a deferred unknown outcome is told once it resolves: still a draft = not sent; another list = its own email", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    const payload: Record<string, unknown> = { ...body, chosen_variant: 1 };
    sg.sends.push({ id: "ss-earlier", name: "x", status: "draft", list_ids: [String(payload.audience_id)], segment_ids: [], subject: null, html: null, plain: null, sender_id: null, suppression_group_id: null, created_at: new Date().toISOString() });
    const told: Array<Record<string, unknown>> = [];
    const deps = {
      resolveSendgrid: async () => ({ api_key: BRIGHTLOOP_KEY, key_digest: DIGEST }),
      sendgridFetch: sg.fetch,
      settle: (async () => ({ ok: true, replayed: false })) as never,
      notifyAutopilotSend: (async () => true) as never,
      reportAudience: async () => undefined,
      tell: async (o: unknown) => told.push(o as Record<string, unknown>),
    };
    const target = {
      tenant_id: "tenant-brightloop",
      exec_class: "email_campaign.create_and_send",
      exec_status: "failed",
      exec_result: { code: "exec_outcome_unknown" },
      exec_payload: payload,
      exec_progress: { campaign_id: "ss-earlier", stage: "content_set" },
      approved_by_source: null,
      lease_expired: false,
    };
    expect(await reconcileEmailSend(ACTION, target, { finalPass: false }, deps)).toEqual({ done: true, outcome: "interrupted" });
    expect(told).toEqual([expect.objectContaining({ card_id: ACTION, outcome: "failed", sent: 0, reason: expect.stringMatching(/Nothing was sent/) })]);
    told.length = 0;
    sg.sends[sg.sends.length - 1].status = "triggered";
    sg.sends[sg.sends.length - 1].list_ids = ["some-other-list"];
    expect(await reconcileEmailSend(ACTION, target, { finalPass: false }, deps)).toEqual({ done: true, outcome: "audience_mismatch" });
    expect(told).toEqual([expect.objectContaining({ outcome: "failed", kind: "audience_mismatch", sent: null })]);
  });

  it("a send that was requested and whose campaign is gone is told as unknown, never as not sent", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    const told: Array<Record<string, unknown>> = [];
    const deps = {
      resolveSendgrid: async () => ({ api_key: BRIGHTLOOP_KEY, key_digest: DIGEST }),
      sendgridFetch: sg.fetch,
      settle: (async () => ({ ok: true, replayed: false })) as never,
      notifyAutopilotSend: (async () => true) as never,
      reportAudience: async () => undefined,
      tell: async (o: unknown) => told.push(o as Record<string, unknown>),
    };
    const target = {
      tenant_id: "tenant-brightloop",
      exec_class: "email_campaign.create_and_send",
      exec_status: "failed",
      exec_result: { code: "exec_outcome_unknown" },
      exec_payload: { ...body, chosen_variant: 1 },
      exec_progress: { campaign_id: "ss-gone", stage: "send_requested" },
      approved_by_source: null,
      lease_expired: false,
    };
    expect(await reconcileEmailSend(ACTION, target, { finalPass: true }, deps)).toEqual({ done: true, outcome: "not_sent" });
    expect(told).toEqual([expect.objectContaining({ card_id: ACTION, outcome: "unknown", sent: null, reason: expect.stringMatching(/could not confirm/) })]);
  });

  it("the executor's own teller queues a retry when the notice does not go out, and keeps the line when it cannot queue", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    q.retry = true;
    q.actionRow = { tenant_id: "tenant-brightloop", exec_class: "email_campaign.create_and_send", exec_status: "dispatching", exec_result: null };
    q.inngestSend.mockClear();
    q.keep.mockClear();
    try {
      const r = await executeEmailCampaignSendAndTell(run({ ...body, chosen_variant: 1 }), execDeps(sg));
      expect(r).toMatchObject({ ok: true });
      expect(q.inngestSend).toHaveBeenCalledTimes(1);
      expect(q.inngestSend).toHaveBeenCalledWith({
        id: `email-send-outcome-tell:channel_actions:${ACTION}:sent:`,
        name: "email-send-outcome/tell.requested",
        data: { tenant_id: "tenant-brightloop", rail: "channel_actions", card_id: ACTION, outcome: "sent" },
      });
      expect(q.keep).not.toHaveBeenCalled();
      q.inngestSend.mockRejectedValueOnce(new Error("inngest down"));
      await executeEmailCampaignSendAndTell(run({ ...body, chosen_variant: 1 }), execDeps(fakeSendgrid()));
      expect(q.keep).toHaveBeenCalledTimes(1);
      expect(q.keep).toHaveBeenCalledWith(expect.objectContaining({ tenant_id: "tenant-brightloop", rail: "channel_actions", card_id: ACTION, outcome: "sent", sent: 238 }));
    } finally {
      q.retry = false;
      q.actionRow = null;
    }
  });

  it("reconcile's own teller queues a retry of a settled end whose notice did not go out", async () => {
    const sg = fakeSendgrid();
    const { body } = await proposeSendgrid(sg, [version(1)]);
    const payload: Record<string, unknown> = { ...body, chosen_variant: 1 };
    sg.sends.push({ id: "ss-earlier", name: "x", status: "draft", list_ids: [String(payload.audience_id)], segment_ids: [], subject: null, html: null, plain: null, sender_id: null, suppression_group_id: null, created_at: new Date().toISOString() });
    q.retry = true;
    q.actionRow = { tenant_id: "tenant-brightloop", exec_class: "email_campaign.create_and_send", exec_status: "failed", exec_result: { code: "exec_partial", not_sent: true } };
    q.inngestSend.mockClear();
    q.keep.mockClear();
    try {
      const deps = {
        resolveSendgrid: async () => ({ api_key: BRIGHTLOOP_KEY, key_digest: DIGEST }),
        sendgridFetch: sg.fetch,
        settle: (async () => ({ ok: true, replayed: false })) as never,
        notifyAutopilotSend: (async () => true) as never,
        reportAudience: async () => undefined,
      };
      const target = {
        tenant_id: "tenant-brightloop",
        exec_class: "email_campaign.create_and_send",
        exec_status: "failed",
        exec_result: { code: "exec_outcome_unknown" },
        exec_payload: payload,
        exec_progress: { campaign_id: "ss-earlier", stage: "content_set" },
        approved_by_source: null,
        lease_expired: false,
      };
      expect(await reconcileEmailSend(ACTION, target, { finalPass: false }, deps)).toEqual({ done: true, outcome: "interrupted" });
      expect(q.inngestSend).toHaveBeenCalledWith({
        id: `email-send-outcome-tell:channel_actions:${ACTION}:failed:`,
        name: "email-send-outcome/tell.requested",
        data: { tenant_id: "tenant-brightloop", rail: "channel_actions", card_id: ACTION, outcome: "failed" },
      });
      expect(q.keep).not.toHaveBeenCalled();
    } finally {
      q.retry = false;
      q.actionRow = null;
    }
  });

  it("the send path refuses a text-only card (no sealed versions), whoever approved it, and sends nothing", async () => {
    const sg = fakeSendgrid();
    const legacy = {
      tool: "sendgrid",
      credential: { kind: "sendgrid_key", key_digest: DIGEST },
      audience_id: SG_LIST,
      audience_name: "Brightloop members",
      audience_count: 238,
      subject: "Old text email",
      preview_text: null,
      body_text: "Hello",
      from_name: "Brightloop",
      from_email: "hello@brightloop.test",
      reply_to: null,
      sendgrid_sender_id: "41",
      sendgrid_suppression_group_id: "7",
    };
    for (const source of [null, "cgo"]) {
      const r = await executeEmailCampaignSendAndTell(run(legacy, source), execDeps(sg), async () => undefined);
      expect(r).toMatchObject({ ok: false, code: "email_redraft_required" });
    }
    expect(sg.requests).toHaveLength(0);
  });

  it("a Zavi-list send is told at its end only", () => {
    expect(bulkSendOutcome(ZTENANT, ZDECISION, "done", { sent: 3, total: 3 }, "x")).toMatchObject({ outcome: "sent", sent: 3 });
    expect(bulkSendOutcome(ZTENANT, ZDECISION, "done", { sent: 0, total: 3 }, "why")).toMatchObject({ outcome: "failed", sent: 0, total: 3, reason: "why" });
    expect(bulkSendOutcome(ZTENANT, ZDECISION, "held", { sent: 1, total: 3 }, "why")).toMatchObject({ outcome: "failed", sent: 1, total: 3, reason: "why" });
    expect(bulkSendOutcome(ZTENANT, ZDECISION, "more", { sent: 1, total: 3 }, "x")).toBeNull();
    expect(bulkSendOutcome(ZTENANT, ZDECISION, "held", { sent: 1, total: 3, hold_reason: "email_paused" }, "why")).toBeNull();
    for (const hold of ["abuse_complaints", "abuse_bounces", "provider_refused", "bulk_check_failed"]) {
      expect(bulkSendOutcome(ZTENANT, ZDECISION, "held", { sent: 1, total: 3, hold_reason: hold }, "why")).toMatchObject({ outcome: "failed", sent: 1, total: 3, reason: "why" });
      expect(bulkSendOutcome(ZTENANT, ZDECISION, "refused", null, "why", hold)).toMatchObject({ outcome: "failed", sent: 0, reason: "why" });
    }
    expect(bulkSendOutcome(ZTENANT, ZDECISION, "held", { sent: 1, total: 3, hold_reason: "list_archived" }, "why")).toMatchObject({ outcome: "failed" });
    expect(bulkSendOutcome(ZTENANT, ZDECISION, "refused", null, "why", "consent_missing")).toMatchObject({ outcome: "failed", sent: 0 });
    expect(bulkSendOutcome(ZTENANT, ZDECISION, "waiting_for_tomorrow", { sent: 1, total: 3 }, "x")).toBeNull();
    expect(emailSendOutcomeLine({ outcome: "failed", subject: "S", listName: "L", sent: 0, total: null, reason: "Nothing was sent." })).toBe('Your email "S" to "L" was not sent. Nothing was sent.');
  });
});
