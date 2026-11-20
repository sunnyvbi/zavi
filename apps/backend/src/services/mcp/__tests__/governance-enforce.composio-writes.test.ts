import { describe, it, expect, vi, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  mode: "off",
  autonomy: "approval",
  writes: new Map<string, { destructive: boolean }>(),
  connected: ["square", "gmail"] as string[],
  readError: false,
  stopped: false,
  open: null as null | string,
  eqs: [] as Array<[string, unknown]>,
  logs: [] as Array<Record<string, unknown>>,
  owned: null as null | "throw" | { connected_account_id: string; auth_config_id: string },
}));
vi.mock("@/services/connectors/composio/account", () => ({ honestComposioToolError: async (_t: string, _k: string, _l: string, e: unknown) => e,
  resolveOwnedComposioAccount: async (tenant_id: string, toolkit: string) => {
    if (m.owned === "throw") throw new Error("boom");
    return m.owned ? { tenant_id, toolkit, ...m.owned } : null;
  },
}));
vi.mock("@/services/connectors/composio/catalog", () => ({
  listToolkitToolSlugs: async (k: string) =>
    new Set(
      ({
        square: ["SQUARE_CREATE_REFUND"],
        gmail: ["GMAIL_SEND_EMAIL", "GMAIL_MODIFY_LABELS", "GMAIL_FETCH_EMAILS"],
        notion: ["NOTION_DELETE_PAGE"],
        linear: ["LINEAR_CREATE_ISSUE"],
        mailchimp: ["SEND_CAMPAIGN", "MAILCHIMP_ADD_MEMBER_NOTE"],
        shopify: ["SHOPIFY_GRAPH_QL_PRODUCTS", "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS"],
      } as Record<string, string[]>)[k] ?? [],
    ),
}));
vi.mock("@/services/settings", () => ({ getStringSetting: async () => m.mode }));
vi.mock("../streamable-client", () => ({
  advertisedReadToolNames: () => new Set(["GMAIL_FETCH_EMAILS", "SHOPIFY_GRAPH_QL_PRODUCTS"]),
  advertisedComposioWriteTool: (_t: string, n: string) => m.writes.get(n),
}));
vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    rpc: async () => ({ data: m.autonomy, error: null }),
    from: () => {
      const q: any = {
        select: () => q,
        eq: (k: string, v: unknown) => { m.eqs.push([k, v]); return q; },
        is: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: m.open ? { id: m.open } : null, error: null }),
        like: async () =>
          m.readError
            ? { data: null, error: { message: "boom" } }
            : { data: m.connected.map((s) => ({ slug: `composio.${s}` })), error: null },
      };
      return q;
    },
  }),
}));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: async (e: Record<string, unknown>) => { m.logs.push(e); } }));
vi.mock("@/services/agents/run-stop", () => ({ isRunStopRequested: async () => m.stopped }));
vi.mock("@/services/agents/kill-switch", () => ({ isAgentKilled: async () => false }));
vi.mock("@/services/provisioning/provisioned-repo-gate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/provisioning/provisioned-repo-gate")>()), assertProvisionedRepoTarget: async () => ({ ok: false }) }));

import { composioWriteFingerprint } from "@/services/connectors/composio/fingerprint";
import { governActionOrBlock } from "../governance-enforce";

const CHAT = { trigger: "chat", chat_thread_id: "thread_1" };

const err = (g: unknown) => JSON.parse((g as { result: { content: string } }).result.content).error;

beforeEach(() => {
  m.writes = new Map([["SQUARE_CREATE_REFUND", { destructive: false }], ["GMAIL_SEND_EMAIL", { destructive: false }]]);
  m.autonomy = "approval"; m.readError = false; m.connected = ["square", "gmail"]; m.stopped = false; m.logs = []; m.open = null; m.eqs = [];
  m.owned = { connected_account_id: "ca_T1", auth_config_id: "ac_T1" };
});

describe("shopify writes → only a product update or a discount code, each a card", () => {
  const PRODUCT = { operation: "update_product", variables: { input: { id: "gid://shopify/Product/123", title: "New title" } } };
  const DISCOUNT = { operation: "discountCodeBasicCreate", variables: { basicCodeDiscount: { title: "Spring", code: "SPRING10" } } };
  beforeEach(() => { m.mode = "enforce"; m.connected = ["shopify"]; m.writes = new Map([["SHOPIFY_GRAPH_QL_WRITE_OPERATIONS", { destructive: false }]]); });
  it("a product update inside the read-advertised product tool becomes a money card with a plain action", async () => {
    const emit = vi.fn(async () => "dec_p");
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "SHOPIFY_GRAPH_QL_PRODUCTS", PRODUCT);
    expect(err(g)).toBe("pending_approval");
    expect(emit).toHaveBeenCalledWith("composio.shopify_write", expect.objectContaining({
      tool_slug: "SHOPIFY_GRAPH_QL_PRODUCTS", toolkit: "shopify", app_name: "Shopify", action: "Update a product", arguments: PRODUCT, labels: ["moves_money"],
    }));
  });
  it("a tenant auto override never applies to a Shopify write", async () => {
    m.autonomy = "auto";
    const emit = vi.fn(async (_c: string, _b: unknown) => "dec_p");
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "SHOPIFY_GRAPH_QL_PRODUCTS", PRODUCT);
    expect(err(g)).toBe("pending_approval");
    expect(emit.mock.calls[0][0]).toBe("composio.shopify_write");
  });
  it("a discount code creation becomes a money card naming the code", async () => {
    const emit = vi.fn(async (_c: string, _b: unknown) => "dec_d");
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS", DISCOUNT);
    expect(err(g)).toBe("pending_approval");
    expect(emit.mock.calls[0][1]).toMatchObject({ action: "Create discount code SPRING10" });
  });
  it("a product read passes untouched", async () => {
    expect(await governActionOrBlock({ ...CHAT, tenant_id: "T1" }, "composio", "SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "list_products" })).toEqual({ block: false });
  });
  it.each([
    ["delete_product on the product tool", "SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "delete_product", variables: { input: { id: "gid://shopify/Product/1" } } }],
    ["a product update with no product id", "SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "update_product", variables: { input: { title: "x" } } }],
    ["a custom document on the product tool", "SHOPIFY_GRAPH_QL_PRODUCTS", { operation: "update_product", custom_document: "mutation { x }", variables: { input: { id: "gid://shopify/Product/1", title: "x" } } }],
    ["any other write operation", "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS", { operation: "customerDelete", variables: { input: { id: "gid://shopify/Customer/1" } } }],
    ["a discount without a code", "SHOPIFY_GRAPH_QL_WRITE_OPERATIONS", { operation: "discountCodeBasicCreate", variables: { basicCodeDiscount: { title: "Spring" } } }],
  ])("refuses %s, nothing emitted", async (_label, tool, args) => {
    const emit = vi.fn();
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", tool, args);
    expect(err(g)).toBe("shopify_write_not_allowed");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("composio writes → one open card per identical action", () => {
  it("the same action already waiting points at that card, no new one", async () => {
    m.mode = "enforce";
    m.open = "dec_open";
    const emit = vi.fn(async () => "dec_new");
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", run_id: "r2", emit_decision: emit }, "composio", "SQUARE_CREATE_REFUND", { charge: "ch_1", amount: 500 });
    expect(g.block).toBe(true);
    expect(emit).not.toHaveBeenCalled();
    expect(err(g)).toBe("pending_approval");
    expect(JSON.stringify(g)).toContain("dec_open");
    expect(m.eqs).toContainEqual(["agent_run_id", "r2"]);
  });
  it("without a run to own the card, never points at another run's card", async () => {
    m.mode = "enforce";
    m.open = "dec_open";
    const emit = vi.fn(async () => "dec_new");
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "SQUARE_CREATE_REFUND", { charge: "ch_1", amount: 500 });
    expect(emit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(g)).toContain("dec_new");
  });
});

describe("composio writes → frozen proposal", () => {
  for (const mode of ["off", "shadow", "enforce"]) {
    it(`blocks + emits even when governed_chokepoint=${mode} (never inline)`, async () => {
      m.mode = mode;
      const emit = vi.fn(async () => "dec_1");
      const args = { charge: "ch_1", amount: 500 };
      const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", run_id: "r1", emit_decision: emit }, "composio", "SQUARE_CREATE_REFUND", args);
      expect(g.block).toBe(true);
      expect(err(g)).toBe("pending_approval");
      expect(emit).toHaveBeenCalledWith("composio.moves_money", expect.objectContaining({
        kind: "composio_write", server_id: "composio", tool_slug: "SQUARE_CREATE_REFUND", toolkit: "square",
        app_name: "Square", action: "Create refund", arguments: args, labels: ["moves_money"],
        classification: { destructive: false }, governed_by: "chokepoint", fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        connected_account_id: "ca_T1", auth_config_id: "ac_T1",
      }));
    });
  }
  it("freezes the tenant's owned account into the body AND the seal", async () => {
    m.mode = "enforce";
    let body: any; const emit = vi.fn(async (_c: string, b: unknown) => { body = b; return "d"; });
    await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "SQUARE_CREATE_REFUND", {});
    expect(body.connected_account_id).toBe("ca_T1");
    expect(body.auth_config_id).toBe("ac_T1");
    expect(body.fingerprint).toBe(composioWriteFingerprint({ ...body, decision_class: "composio.moves_money" }));
    expect(body.fingerprint).not.toBe(composioWriteFingerprint({ ...body, connected_account_id: "ca_X", decision_class: "composio.moves_money" }));
  });
  it("no owned account for the app → blocked composio_app_not_connected, nothing emitted", async () => {
    m.owned = null; const emit = vi.fn();
    expect(err(await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "SQUARE_CREATE_REFUND", {}))).toBe("composio_app_not_connected");
    expect(emit).not.toHaveBeenCalled();
  });
  it("account check error → blocked composio_connection_check_failed, nothing emitted", async () => {
    m.owned = "throw"; const emit = vi.fn();
    expect(err(await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "SQUARE_CREATE_REFUND", {}))).toBe("composio_connection_check_failed");
    expect(emit).not.toHaveBeenCalled();
  });
  it("frozen args are a copy: mutating the caller's object after emit does not change the body", async () => {
    m.mode = "enforce";
    let body: any; const emit = vi.fn(async (_c: string, b: unknown) => { body = b; return "d"; });
    const args = { to: "a@b.c", nested: { x: 1 } };
    await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "GMAIL_SEND_EMAIL", args);
    args.nested.x = 2;
    expect(body.arguments).toEqual({ to: "a@b.c", nested: { x: 1 } });
  });
  it("reads pass untouched", async () => {
    m.mode = "enforce";
    expect(await governActionOrBlock({ ...CHAT, tenant_id: "T1" }, "composio", "GMAIL_FETCH_EMAILS", {})).toEqual({ block: false });
  });
  it("forbidden override → blocked, nothing emitted", async () => {
    m.mode = "enforce"; m.autonomy = "forbidden";
    const emit = vi.fn();
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "GMAIL_SEND_EMAIL", {});
    expect(err(g)).toBe("action_forbidden");
    expect(emit).not.toHaveBeenCalled();
  });
  it("auto override still emits (the auto path runs it through the worker), never inline", async () => {
    m.mode = "enforce"; m.autonomy = "auto";
    const emit = vi.fn(async () => "d");
    expect((await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "GMAIL_SEND_EMAIL", {})).block).toBe(true);
    expect(emit).toHaveBeenCalled();
  });
  it("no approval channel → blocked approval_channel_unavailable (fail closed)", async () => {
    m.mode = "off";
    expect(err(await governActionOrBlock({ ...CHAT, tenant_id: "T1" }, "composio", "GMAIL_SEND_EMAIL", {}))).toBe("approval_channel_unavailable");
  });
  it("emit failure → blocked governance_emit_failed", async () => {
    const emit = vi.fn(async () => { throw new Error("x"); });
    expect(err(await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "GMAIL_SEND_EMAIL", {}))).toBe("governance_emit_failed");
  });
  it("a stopped run never queues the write", async () => {
    m.stopped = true; const emit = vi.fn();
    expect(err(await governActionOrBlock({ ...CHAT, tenant_id: "T1", run_id: "r1", emit_decision: emit }, "composio", "GMAIL_SEND_EMAIL", {}))).toBe("run_cancelled");
    expect(emit).not.toHaveBeenCalled();
  });
  it("secrets in args are scrubbed before freezing (card and worker see the scrubbed value)", async () => {
    m.mode = "enforce";
    let body: any; const emit = vi.fn(async (_c: string, b: unknown) => { body = b; return "d"; });
    await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "GMAIL_SEND_EMAIL", { body: "key sk_live_abcdefghijklmnopqrstuvwx" });
    expect(JSON.stringify(body.arguments)).not.toContain("sk_live_abcdefghijklmnopqrstuvwx");
    expect(body.fingerprint).toBe(composioWriteFingerprint({ ...body, decision_class: "composio.write" }));
  });
  it("freezes destructiveHint as a classification input and fingerprints the canonical body", async () => {
    m.mode = "enforce"; m.writes.set("GMAIL_MODIFY_LABELS", { destructive: true });
    let body: any; const emit = vi.fn(async (_c: string, b: unknown) => { body = b; return "d"; });
    await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "GMAIL_MODIFY_LABELS", { b: 1, a: 2 });
    expect(emit.mock.calls[0][0]).toBe("composio.deletes_data");
    expect(body.classification).toEqual({ destructive: true });
    expect(body.labels).toEqual(["deletes_data"]);
    expect(body.fingerprint).toBe(composioWriteFingerprint({ ...body, decision_class: "composio.deletes_data" }));
  });
  it("connected-app read returns an error → blocked composio_connection_check_failed, nothing emitted, no args logged", async () => {
    m.readError = true; const emit = vi.fn();
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: emit }, "composio", "GMAIL_SEND_EMAIL", { secret_note: "do-not-log" });
    expect(err(g)).toBe("composio_connection_check_failed");
    expect(emit).not.toHaveBeenCalled();
    expect(m.logs.map((l) => l.code)).toContain("composio_connection_check_failed");
    expect(JSON.stringify(m.logs)).not.toContain("do-not-log");
  });
  it("a composio.linear row (native rail, spec 14) does not make a LINEAR_ write proposable → blocked composio_app_not_connected", async () => {
    m.connected = ["linear"]; m.writes.set("LINEAR_CREATE_ISSUE", { destructive: false });
    const emit = vi.fn();
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", run_id: "r1", emit_decision: emit }, "composio", "LINEAR_CREATE_ISSUE", {});
    expect(err(g)).toBe("composio_app_not_connected");
    expect(emit).not.toHaveBeenCalled();
  });
  it("write for an app this tenant has not connected → blocked", async () => {
    m.writes.set("NOTION_DELETE_PAGE", { destructive: true });
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", emit_decision: vi.fn() }, "composio", "NOTION_DELETE_PAGE", {});
    expect(err(g)).toBe("composio_app_not_connected");
  });
  it("an unadvertised Composio tool that is not a read is governed as a write (fail closed), never inline", async () => {
    m.mode = "enforce";
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1" }, "composio", "SQUARE_UNKNOWN_WRITE", {});
    expect(g.block).toBe(true);
  });
});

describe("composio writes are chat-only (spec item 20)", () => {
  const NEEDS_CHAT = "Actions in connected apps can only be proposed in a chat with the founder.";
  const body = (g: unknown) => JSON.parse((g as { result: { content: string } }).result.content);

  it("a chat run with a thread → decision emitted (the card lands in that thread)", async () => {
    m.mode = "enforce"; const emit = vi.fn(async () => "d");
    const g = await governActionOrBlock({ tenant_id: "T1", run_id: "r1", trigger: "chat", chat_thread_id: "th", emit_decision: emit }, "composio", "GMAIL_SEND_EMAIL", {});
    expect(err(g)).toBe("pending_approval");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  const noThread: Array<[string, Record<string, unknown>]> = [
    ["scheduled (cron) run", { trigger: "cron" }],
    ["scheduled run that somehow carries a thread id", { trigger: "scheduled", chat_thread_id: "th" }],
    ["Slack-triggered run", { trigger: "slack", slack_routing: { channel_id: "C1", thread_ts: "1", original_ts: "1", event_id: "e" } }],
    ["a2a child that inherited a chat thread", { trigger: "a2a", chat_thread_id: "th" }],
    ["chat run with no thread", { trigger: "chat" }],
    ["run with no trigger at all", {}],
  ];
  for (const [name, extra] of noThread) {
    it(`${name} → refused composio_write_needs_chat, nothing emitted, logged by code only`, async () => {
      m.mode = "enforce"; const emit = vi.fn(async () => "d");
      const g = await governActionOrBlock({ tenant_id: "T1", run_id: "r1", emit_decision: emit, ...extra }, "composio", "SQUARE_CREATE_REFUND", { charge: "ch_secret_arg" });
      expect(g.block).toBe(true);
      expect(body(g)).toEqual({ error: "composio_write_needs_chat", message: NEEDS_CHAT });
      expect(emit).not.toHaveBeenCalled();
      expect(m.logs.map((l) => l.code)).toEqual(["composio_write_needs_chat"]);
      expect(JSON.stringify(m.logs)).not.toContain("ch_secret_arg");
    });
  }

  it("reads are unaffected on a non-chat run", async () => {
    m.mode = "enforce";
    expect(await governActionOrBlock({ tenant_id: "T1", trigger: "cron" }, "composio", "GMAIL_FETCH_EMAILS", {})).toEqual({ block: false });
  });
});

describe("a raw TikTok budget / status / create is never proposed", () => {
  for (const slug of ["TIKTOK_ADS_UPDATE_CAMPAIGN_BUDGET", "TIKTOK_ADS_UPDATE_CAMPAIGN_STATUS", "TIKTOK_ADS_UPDATE_ADGROUP_BUDGET", "TIKTOK_ADS_CREATE_SMART_PLUS_CAMPAIGN"]) {
    it(`${slug} in a chat: refused, nothing emitted`, async () => {
      m.mode = "enforce";
      m.autonomy = "auto";
      m.connected = ["tiktok_ads"];
      m.writes = new Map([[slug, { destructive: false }]]);
      const emit = vi.fn(async () => "d");
      const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", run_id: "r1", emit_decision: emit }, "composio", slug, { advertiser_id: "1", campaign_id: "2", budget: 500 });
      expect(g.block).toBe(true);
      expect(err(g)).toBe("use_tiktok_ads_propose_tool");
      expect(JSON.stringify(g)).toContain("tiktok_ads__propose_budget_change");
      expect(emit).not.toHaveBeenCalled();
    });
  }
  it("a creative upload stays an ordinary approval card", async () => {
    m.mode = "enforce";
    m.connected = ["tiktok_ads"];
    m.writes = new Map([["TIKTOK_ADS_UPLOAD_IMAGE", { destructive: false }]]);
    const emit = vi.fn(async () => "d");
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", run_id: "r1", emit_decision: emit }, "composio", "TIKTOK_ADS_UPLOAD_IMAGE", { advertiser_id: "1" });
    expect(err(g)).not.toBe("use_tiktok_ads_propose_tool");
  });
});

describe("a raw Pinterest write is never proposed", () => {
  for (const slug of ["PINTEREST_CREATE_PIN", "PINTEREST_DELETE_PIN", "PINTEREST_DELETE_BOARD", "PINTEREST_UPDATE_BOARD"]) {
    it(`${slug} in a chat: refused, nothing emitted`, async () => {
      m.mode = "enforce";
      m.autonomy = "auto";
      m.connected = ["pinterest"];
      m.writes = new Map([[slug, { destructive: false }]]);
      const emit = vi.fn(async () => "d");
      const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", run_id: "r1", emit_decision: emit }, "composio", slug, { board_id: "1" });
      expect(g.block).toBe(true);
      expect(err(g)).toBe("use_social_propose_post");
      expect(JSON.stringify(g)).toContain("social__propose_post");
      expect(emit).not.toHaveBeenCalled();
    });
  }
});

describe("a raw Mailchimp / Klaviyo campaign send is never proposed", () => {
  const SENDS = [
    "MAILCHIMP_ADD_MEMBER_TO_LIST", "MAILCHIMP_ADD_EVENT", "KLAVIYO_SUBSCRIBE_PROFILES", "KLAVIYO_CREATE_EVENT",
    "MAILCHIMP_SEND_CAMPAIGN", "MAILCHIMP_SCHEDULE_CAMPAIGN", "MAILCHIMP_RESEND_CAMPAIGN", "MAILCHIMP_RESUME_RSS_CAMPAIGN", "MAILCHIMP_SEND_TEST_EMAIL",
    "MAILCHIMP_START_AUTOMATION_EMAILS", "MAILCHIMP_START_BATCH_OPERATION", "KLAVIYO_CREATE_CAMPAIGN_SEND_JOB", "KLAVIYO_UPDATE_FLOW_STATUS", "mailchimp_send_campaign",
  ];
  for (const slug of SENDS) {
    it(`${slug} in a chat, with the tenant's autonomy set to auto: refused, nothing emitted`, async () => {
      m.mode = "enforce";
      m.autonomy = "auto";
      m.connected = ["mailchimp", "klaviyo"];
      m.writes = new Map([[slug, { destructive: false }]]);
      const emit = vi.fn(async () => "d");
      const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", run_id: "r1", emit_decision: emit }, "composio", slug, { campaign_id: "c1" });
      expect(g.block).toBe(true);
      expect(err(g)).toBe("use_email_campaign_tool");
      expect(JSON.stringify(g)).toContain("email__propose_campaign");
      expect(emit).not.toHaveBeenCalled();
    });
  }

  it("refused even when the action is missing from the advertised-write hint", async () => {
    m.mode = "off";
    m.writes = new Map();
    const emit = vi.fn(async () => "d");
    const g = await governActionOrBlock({ tenant_id: "T1", trigger: "cron", emit_decision: emit }, "composio", "MAILCHIMP_SEND_CAMPAIGN", {});
    expect(err(g)).toBe("use_email_campaign_tool");
    expect(emit).not.toHaveBeenCalled();
  });

  it("a send action whose name lacks the toolkit prefix is refused once the catalog names its toolkit", async () => {
    m.mode = "enforce";
    m.connected = ["mailchimp"];
    m.writes = new Map([["SEND_CAMPAIGN", { destructive: false }]]);
    const emit = vi.fn(async () => "d");
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", run_id: "r1", emit_decision: emit }, "composio", "SEND_CAMPAIGN", { campaign_id: "c1" });
    expect(err(g)).toBe("use_email_campaign_tool");
    expect(emit).not.toHaveBeenCalled();
  });

  it("other Mailchimp and Klaviyo writes still become an ordinary approval card", async () => {
    m.mode = "enforce";
    m.connected = ["mailchimp"];
    m.writes = new Map([["MAILCHIMP_ADD_MEMBER_NOTE", { destructive: false }]]);
    const emit = vi.fn(async () => "d");
    const g = await governActionOrBlock({ ...CHAT, tenant_id: "T1", run_id: "r1", emit_decision: emit }, "composio", "MAILCHIMP_ADD_MEMBER_NOTE", { list_id: "L1" });
    expect(err(g)).toBe("pending_approval");
    expect(emit).toHaveBeenCalledTimes(1);
  });
});
