import { beforeEach, describe, expect, it, vi } from "vitest";
import { sendgridHttpCall } from "@/services/connectors/email-campaign/providers-sendgrid";
import { sendgridKeyDigest } from "@/services/connectors/email-campaign/credential";
import { BRIGHTLOOP_KEY, fakeSendgrid } from "@/services/connectors/email-campaign/__tests__/fake-sendgrid";
import { makeProposeCampaignTool, LIVE_PROPOSE_CAMPAIGN_DEPS, type ProposeCampaignDeps } from "@/services/tools/email/propose_campaign";
import { sealVariants, shaOf, type SealedVariant, type TemplateSnapshot } from "@/services/email-cards/variants";
import type { EmailTemplate } from "@/services/email-templates/render";

type Row = Record<string, unknown> & { id: string; tenant_id: string };

const db: { channel_actions: Row[]; channel_action_events: Row[]; decisions: Row[] } = { channel_actions: [], channel_action_events: [], decisions: [] };

function field(r: Row, k: string): unknown {
  const [col, key] = k.split("->>");
  return key === undefined ? r[col] : (r[col] as Record<string, unknown> | null | undefined)?.[key];
}

function query(table: keyof typeof db) {
  const filters: Array<(r: Row) => boolean> = [];
  const rows = () => db[table].filter((r) => filters.every((f) => f(r)));
  const q = {
    select: () => q,
    eq: (k: string, v: unknown) => {
      filters.push((r) => field(r, k) === v);
      return q;
    },
    in: (k: string, vs: unknown[]) => {
      filters.push((r) => vs.includes(field(r, k)));
      return q;
    },
    is: (k: string, v: null) => {
      filters.push((r) => (field(r, k) ?? null) === v);
      return q;
    },
    maybeSingle: async () => ({ data: rows()[0] ? structuredClone(rows()[0]) : null, error: null }),
    limit: async (n: number) => ({ data: rows().slice(0, n), error: null }),
  };
  return q;
}

vi.mock("@/services/tenant-client", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    tenantRpc: async (tenantId: string, name: string, args: Record<string, string>) => {
      if (name !== "replace_email_card") throw new Error(`unexpected rpc ${name}`);
      const c = db.channel_actions.find((r) => r.id === args.p_id && r.tenant_id === tenantId);
      if (!c) return { data: { ok: false, code: "not_found" }, error: null };
      Object.assign(c, { status: "rejected", exec_payload: { ...(c.exec_payload as object), replaced_by: { rail: args.p_new_rail, id: args.p_new_id } } });
      return { data: { ok: true, replaced: true }, error: null };
    },
    tenantClient: () => ({ from: (t: keyof typeof db) => query(t) }),
  };
});

type Deps = ProposeCampaignDeps;

process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "test-digest-secret-0123456789abcdef";
const DIGEST = sendgridKeyDigest(BRIGHTLOOP_KEY);
const SG_LIST = "6a1f0c2e-0000-4000-8000-00000000b001";
const TENANT = "tenant-brightloop";
const FOREIGN = "tenant-someone-else";
const OLD = "9f1efc8f-287f-4e2a-87e2-0ce89bb78700";
const NEW = "e970e26b-7733-4d43-a05d-1ec2cb1bb208";

const OLD_TEMPLATE: EmailTemplate = {
  logo_url: null,
  brand_color: "#111827",
  button_color: "#111827",
  font_key: "system",
  sign_off: "The Brightloop team",
  postal_address: "12 Harbor Way, Portland OR 97201",
  show_cards: false,
};
const LIVE_TEMPLATE: EmailTemplate = { ...OLD_TEMPLATE, brand_color: "#e11d48", button_color: "#0b8043", sign_off: "Cheers, Brightloop" };

const OLD_CONTENT = [
  {
    subject: "Lemon tarts this weekend only",
    preview_text: "Pick a size and a delivery day.",
    title: "Our lemon tarts are back this weekend",
    paragraphs: ["Our lemon tarts are back this weekend.", "Pick a size and a delivery day, and we will take care of the rest. Local delivery is included."],
    button: { label: "Order your tarts", url: "https://www.brightloop.test/tarts" },
  },
  {
    subject: "Lemon tarts are back",
    preview_text: "Two days, then they are gone.",
    title: "Baked this morning",
    hero: { big: "Lemon tarts", small: "Saturday and Sunday" },
    paragraphs: ["Fresh lemon curd, butter pastry.", "Order by Friday night."],
    button: { label: "Get yours", url: "https://www.brightloop.test/tarts?v=2" },
  },
];

let oldSealed: { variants: SealedVariant[]; template_snapshot: TemplateSnapshot; renderer_version: string };
const emitted: Array<Record<string, unknown>> = [];
let cardBodyCalls = 0;
let released = 0;
let reserved = 0;

function deps(): Partial<Deps> {
  const sg = fakeSendgrid();
  return {
    resolveTool: (async () => ({ tool: "sendgrid", sendgrid: { api_key: BRIGHTLOOP_KEY, key_digest: DIGEST } })) as unknown as Deps["resolveTool"],
    callFor: () => sendgridHttpCall(BRIGHTLOOP_KEY, sg.fetch),
    template: async () => LIVE_TEMPLATE,
    company: async () => ({ name: "Brightloop", website: "https://www.brightloop.test" }),
    testLists: async () => new Set<string>(),
    setting: async () => null,
    railOf: async () => "channel_actions",
    replaceCard: LIVE_PROPOSE_CAMPAIGN_DEPS.replaceCard,
    redraftPlan: async () => null,
    cardBody: async (tenantId, card) => {
      cardBodyCalls++;
      return LIVE_PROPOSE_CAMPAIGN_DEPS.cardBody(tenantId, card);
    },
    now: () => new Date("2026-10-29T12:00:00Z"),
    reserveCard: async () => {
      reserved++;
      return { ok: true as const, id: "res-1" };
    },
    releaseCard: async () => {
      released++;
    },
    settleCard: async () => {},
    learningsRead: async () => null,
  };
}

function storeOldCard(tenant_id: string, over: Record<string, unknown> = {}) {
  db.channel_actions.push({
    id: OLD,
    tenant_id,
    exec_class: "email_campaign.create_and_send",
    status: "pending",
    exec_status: null,
    approved_by: null,
    exec_payload: { tool: "sendgrid", audience_id: SG_LIST, audience_name: "Newsletter", audience_count: 3, ...structuredClone(oldSealed), ...over },
  });
}

const writer = vi.fn(async (_cls: string, body: Record<string, unknown>) => {
  emitted.push(structuredClone(body));
  db.channel_actions.push({ id: NEW, tenant_id: TENANT, status: "pending", exec_status: null, approved_by: null, exec_payload: body });
  return NEW;
});

const WHOLE = ["subject", "preview_text", "title", "paragraphs", "button"];

const propose = (
  variants: Array<Record<string, unknown>>,
  replaces: { rail: "channel_actions"; id: string } | null = { rail: "channel_actions", id: OLD },
  changes: string[] | null = ["subject", "paragraphs"],
) =>
  makeProposeCampaignTool(deps()).execute({ tenant_id: TENANT, log: () => {}, emit_decision: writer } as never, {
    route: "sendgrid",
    audience_id: SG_LIST,
    variants,
    ...(replaces ? { replaces } : {}),
    ...(changes ? { changes } : {}),
  } as never) as Promise<{ replaced_previous: boolean; note: string }>;

function titleSwap(html: string, from: string, to: string): string {
  const a = `<title>${from}</title>`;
  expect(html.split(a)).toHaveLength(2);
  return html.replace(a, `<title>${to}</title>`);
}

beforeEach(() => {
  db.channel_actions = [];
  db.channel_action_events = [];
  db.decisions = [];
  emitted.length = 0;
  cardBodyCalls = 0;
  released = 0;
  reserved = 0;
  writer.mockClear();
  oldSealed = sealVariants(OLD_TEMPLATE, OLD_CONTENT, {
    route: "sendgrid",
    companyName: "Brightloop",
    ownHost: "www.brightloop.test",
    now: new Date("2026-10-28T09:00:00Z"),
    slugSuffix: "mx80cgkttg",
  });
});

describe("a subject-only redraft keeps the stored body word for word", () => {
  it("every version keeps its content, text and html byte for byte; only the subject and the campaign tag change", async () => {
    storeOldCard(TENANT);
    const out = await propose([{ subject: "Saturday only" }, { subject: "Saturday only, version B" }]);

    expect(writer).toHaveBeenCalledTimes(1);
    const body = emitted[0] as { variants: SealedVariant[]; template_snapshot: TemplateSnapshot; renderer_version: string };
    expect(body.variants).toHaveLength(2);
    const oldSlug = oldSealed.template_snapshot.campaign_slug;
    const newSlug = body.template_snapshot.campaign_slug;
    expect(newSlug).not.toBe(oldSlug);
    const subjects = ["Saturday only", "Saturday only, version B"];
    body.variants.forEach((v, i) => {
      const old = oldSealed.variants[i];
      expect(old.text.split(oldSlug).length).toBeGreaterThan(1);
      expect(v.content).toStrictEqual({ ...old.content, subject: subjects[i] });
      expect(v.text).toBe(old.text.split(oldSlug).join(newSlug));
      expect(v.html).toBe(titleSwap(old.html, old.content.subject, subjects[i]).split(oldSlug).join(newSlug));
      expect(v.render_sha).toBe(shaOf(body.renderer_version, v.html, v.text));
    });
    expect(body.variants[1].content.hero).toStrictEqual(OLD_CONTENT[1].hero);
    expect(body.template_snapshot).toStrictEqual({ ...oldSealed.template_snapshot, campaign_slug: newSlug });
    expect(body.variants[0].html).not.toContain(LIVE_TEMPLATE.sign_off);
    expect(out.replaced_previous).toBe(true);
    expect(db.channel_actions.find((r) => r.id === OLD)).toMatchObject({ status: "rejected" });
  });

  it("a field given is used, the ones left out are kept", async () => {
    storeOldCard(TENANT);
    await propose([{ subject: "Saturday only", paragraphs: ["Only Saturday now."] }]);
    const body = emitted[0] as { variants: SealedVariant[] };
    expect(body.variants).toHaveLength(1);
    expect(body.variants[0].content).toStrictEqual({ ...OLD_CONTENT[0], subject: "Saturday only", paragraphs: ["Only Saturday now."] });
    expect(body.variants[0].content).not.toHaveProperty("hero");
  });

  it("an approved old card gives its fields but never its campaign tag", async () => {
    storeOldCard(TENANT, { chosen_variant: 1, approved_count: 3 });
    await propose([{ subject: "Saturday only" }]);
    const body = emitted[0] as { variants: SealedVariant[]; template_snapshot: TemplateSnapshot };
    expect(body.variants[0].content).toStrictEqual({ ...OLD_CONTENT[0], subject: "Saturday only" });
    expect(body.template_snapshot.campaign_slug).not.toBe(oldSealed.template_snapshot.campaign_slug);
    expect(body.template_snapshot.campaign_slug).toMatch(/^saturday-only-20261029-[a-z0-9]{10}$/);
    expect(body.variants[0].text).not.toContain(oldSealed.template_snapshot.campaign_slug);
  });

  it("an open old card nobody approved never lends its campaign tag either, so two open cards never share one utm_campaign", async () => {
    storeOldCard(TENANT);
    await propose([{ subject: "Saturday only" }]);
    const body = emitted[0] as { variants: SealedVariant[]; template_snapshot: TemplateSnapshot };
    const oldSlug = oldSealed.template_snapshot.campaign_slug;
    expect(oldSlug).toMatch(/^lemon/);
    expect(body.template_snapshot.campaign_slug).not.toBe(oldSlug);
    expect(body.template_snapshot.campaign_slug).toMatch(/^saturday-only-20261029-[a-z0-9]{10}$/);
    expect(body.variants[0].text).not.toContain(oldSlug);
    expect(body.variants[0].html).not.toContain(oldSlug);
    expect(body.variants[0].text).toContain(`utm_campaign=${body.template_snapshot.campaign_slug}`);
  });

  it("another workspace's card with the same id is never read: nothing is filed and the slot is given back", async () => {
    storeOldCard(FOREIGN);
    await expect(propose([{ subject: "Saturday only" }])).rejects.toMatchObject({ code: "email_replaced_not_found" });
    expect(cardBodyCalls).toBe(1);
    expect(writer).not.toHaveBeenCalled();
    expect(released).toBe(1);
  });

  it("a version the old card does not have cannot be kept: refused, nothing filed", async () => {
    storeOldCard(TENANT);
    await expect(propose([{ subject: "A" }, { subject: "B" }, { subject: "C" }])).rejects.toMatchObject({ code: "email_replaced_version_missing" });
    expect(writer).not.toHaveBeenCalled();
    expect(released).toBe(1);
  });

  it("a partial version without replaces is refused before any slot is taken", async () => {
    await expect(propose([{ subject: "Saturday only" }], null)).rejects.toMatchObject({ code: "email_content_incomplete" });
    expect(reserved).toBe(0);
    expect(writer).not.toHaveBeenCalled();
  });

  it("a whole redraft is rendered with the live template and never reads the old card", async () => {
    storeOldCard(TENANT);
    await propose([{ ...OLD_CONTENT[0], subject: "Saturday only" }], undefined, WHOLE);
    const body = emitted[0] as { variants: SealedVariant[]; template_snapshot: TemplateSnapshot };
    expect(cardBodyCalls).toBe(0);
    expect(body.template_snapshot.sign_off).toBe(LIVE_TEMPLATE.sign_off);
    expect(body.variants[0].text).not.toBe(oldSealed.variants[0].text);
  });
});

describe("a redraft changes only the fields the founder asked for, even when the model rewrites the whole email", () => {
  const MIRRORED = [
    { ...OLD_CONTENT[0], subject: "Fresh lemon tarts, Saturday only", title: "Fresh lemon tarts, Saturday only" },
    { ...OLD_CONTENT[1], subject: "Baked this morning", title: "Baked this morning" },
  ];

  beforeEach(() => {
    oldSealed = sealVariants(OLD_TEMPLATE, MIRRORED, {
      route: "sendgrid",
      companyName: "Brightloop",
      ownHost: "www.brightloop.test",
      now: new Date("2026-10-28T09:00:00Z"),
      slugSuffix: "mx80cgkttg",
    });
  });

  it("a whole version with a reworded title and button keeps the old title and button word for word, and says so", async () => {
    storeOldCard(TENANT);
    const out = await propose(
      [
        { ...MIRRORED[0], subject: "Lemon tarts are back this Saturday", title: "Lemon tarts are back", button: { url: "https://www.brightloop.test/tarts", label: "Order now" } },
        { ...MIRRORED[1], subject: "Still warm, Saturday", title: "Still warm", hero: { big: "Tarts", small: "Saturday" } },
      ],
      undefined,
      ["subject"],
    );
    expect(cardBodyCalls).toBe(1);
    expect(writer).toHaveBeenCalledTimes(1);
    const body = emitted[0] as { variants: SealedVariant[]; template_snapshot: TemplateSnapshot; renderer_version: string };
    const oldSlug = oldSealed.template_snapshot.campaign_slug;
    const newSlug = body.template_snapshot.campaign_slug;
    const subjects = ["Lemon tarts are back this Saturday", "Still warm, Saturday"];
    body.variants.forEach((v, i) => {
      const old = oldSealed.variants[i];
      expect(v.content).toStrictEqual({ ...MIRRORED[i], subject: subjects[i] });
      expect(v.text).toBe(old.text.split(oldSlug).join(newSlug));
      expect(v.html).toBe(titleSwap(old.html, old.content.subject, subjects[i]).split(oldSlug).join(newSlug));
      expect(v.render_sha).toBe(shaOf(body.renderer_version, v.html, v.text));
    });
    expect(body.variants[0].html).not.toContain("Lemon tarts are back<");
    expect(body.variants[0].html).not.toContain("Order now");
    expect(body.variants[1].html).not.toContain("Still warm<");
    expect(body.template_snapshot.sign_off).toBe(OLD_TEMPLATE.sign_off);
    expect(out.note).toContain("Kept title, button, hero word for word");
    expect(out.replaced_previous).toBe(true);
  });

  it("a field echoed unchanged is not reported as kept", async () => {
    storeOldCard(TENANT);
    const out = await propose([{ ...MIRRORED[0], subject: "Saturday only" }], undefined, ["subject"]);
    expect((emitted[0] as { variants: SealedVariant[] }).variants[0].content).toStrictEqual({ ...MIRRORED[0], subject: "Saturday only" });
    expect(out.note).not.toContain("Kept");
  });

  it("a title the founder asked to change is changed, and nothing else", async () => {
    storeOldCard(TENANT);
    const out = await propose([{ ...MIRRORED[0], subject: "Saturday only", title: "Lemon tarts are back", preview_text: "New preview" }], undefined, ["subject", "title"]);
    expect((emitted[0] as { variants: SealedVariant[] }).variants[0].content).toStrictEqual({ ...MIRRORED[0], subject: "Saturday only", title: "Lemon tarts are back" });
    expect(out.note).toContain("Kept preview_text word for word");
  });

  it("a hero the founder asked to remove is removed, not kept from the old card", async () => {
    storeOldCard(TENANT);
    const { hero: _hero, ...noHero } = MIRRORED[1];
    const out = await propose([{ ...MIRRORED[0] }, noHero], undefined, ["hero"]);
    const body = emitted[0] as { variants: SealedVariant[] };
    expect(oldSealed.variants[1].content.hero).toStrictEqual(OLD_CONTENT[1].hero);
    expect(body.variants[1].content).toStrictEqual(noHero);
    expect(body.variants[1].content).not.toHaveProperty("hero");
    expect(body.variants[1].html).not.toContain(OLD_CONTENT[1].hero!.small);
    expect(body.variants[1].text).not.toContain(OLD_CONTENT[1].hero!.small);
    expect(body.variants[0].content).toStrictEqual(MIRRORED[0]);
    expect(out.note).not.toContain("Kept");
  });

  it("a new hero on one version keeps the other version's hero from the old card", async () => {
    storeOldCard(TENANT);
    const { hero: _hero, ...noHero } = MIRRORED[1];
    const hero = { big: "Fresh tarts", small: "Saturday only" };
    await propose([{ ...MIRRORED[0], hero }, noHero], undefined, ["hero"]);
    const body = emitted[0] as { variants: SealedVariant[] };
    expect(body.variants[0].content).toStrictEqual({ ...MIRRORED[0], hero });
    expect(body.variants[1].content).toStrictEqual(MIRRORED[1]);
    expect(body.variants[1].html).toContain(OLD_CONTENT[1].hero!.small);
  });

  it("a hero dropped from one version stays on a version given as empty", async () => {
    const hero = { big: "Fresh tarts", small: "Saturday only" };
    const both = [{ ...MIRRORED[0], hero }, MIRRORED[1]];
    oldSealed = sealVariants(OLD_TEMPLATE, both, {
      route: "sendgrid",
      companyName: "Brightloop",
      ownHost: "www.brightloop.test",
      now: new Date("2026-10-28T09:00:00Z"),
      slugSuffix: "mx80cgkttg",
    });
    storeOldCard(TENANT);
    const { hero: _hero, ...noHero } = MIRRORED[1];
    await propose([{}, noHero], undefined, ["hero"]);
    const body = emitted[0] as { variants: SealedVariant[] };
    expect(body.variants[0].content).toStrictEqual(both[0]);
    expect(body.variants[1].content).toStrictEqual(noHero);
  });

  it("a remove-only redraft (every version empty) removes the hero", async () => {
    storeOldCard(TENANT);
    await propose([{}, {}], undefined, ["hero"]);
    const body = emitted[0] as { variants: SealedVariant[] };
    const was = oldSealed.variants.map((v) => v.content as Record<string, unknown>);
    expect(was[1].hero).toBeDefined();
    const { hero: _hero, ...noHero } = was[1];
    expect(body.variants[0].content).toStrictEqual(was[0]);
    expect(body.variants[1].content).toStrictEqual(noHero);
    expect(body.variants[1].html).not.toContain((was[1].hero as { small: string }).small);
  });

  it("a redraft that does not say what the founder asked to change is refused before any slot is taken or the old card is read", async () => {
    storeOldCard(TENANT);
    await expect(propose([{ ...MIRRORED[0], subject: "Saturday only", title: "Lemon tarts are back" }], undefined, null)).rejects.toMatchObject({ code: "email_redraft_changes_missing" });
    expect(reserved).toBe(0);
    expect(cardBodyCalls).toBe(0);
    expect(writer).not.toHaveBeenCalled();
    expect(db.channel_actions.find((r) => r.id === OLD)).toMatchObject({ status: "pending" });
  });
});
