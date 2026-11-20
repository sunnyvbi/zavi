import { describe, it, expect, vi, beforeEach } from "vitest";

const T = "7c70da58-091e-4ff5-8f77-343034d448d9";
const MEMBER = "ddab2d83-5ee5-4aa1-a837-2b831a7afe7d";
const CARD = "2ff3de10-8154-4025-8100-4af14ad211d1";

const db = vi.hoisted(() => ({
  roles: new Map<string, string>(),
  roleReads: [] as Array<{ user_id: unknown }>,
  roleFails: false,
  pending: [] as Array<Record<string, unknown>>,
  channelActions: [] as Array<{ channel_slug: string }>,
  tools: [] as Array<{ name: string; handler: (a: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>,
  attach: vi.fn(async (a: { card_id: string }) => ({ shown: true, already: false, card_id: a.card_id, table: "decisions", what: "x" }) as unknown),
}));

function chain(rows: () => unknown[]) {
  const q: Record<string, unknown> = {};
  for (const k of ["select", "order", "eq"]) q[k] = () => q;
  q.limit = () => Promise.resolve({ data: rows(), error: null });
  return q;
}

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantStorage: () => ({ from: () => ({ upload: async () => ({ error: null }) }) }),
  tenantClient: (tid: string) => ({
    from: (table: string) => {
      if (tid !== T) throw new Error(`wrong tenant ${tid}`);
      if (table === "customer_visible_pending_decisions") return chain(() => db.pending);
      if (table === "customer_visible_open_channel_actions") return chain(() => db.channelActions);
      if (table === "tenant_users") {
        let uid: unknown;
        const q = {
          select: () => q,
          eq: (col: string, v: unknown) => {
            if (col === "user_id") uid = v;
            return q;
          },
          maybeSingle: async () => {
            db.roleReads.push({ user_id: uid });
            if (db.roleFails) return { data: null, error: { message: "boom" } };
            const role = db.roles.get(String(uid));
            return { data: role ? { role } : null, error: null };
          },
        };
        return q;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));
vi.mock("@/services/reports/constants", () => ({ ARTIFACT_BUCKET: "agent-artifacts" }));
vi.mock("@/services/settings", () => ({ getBoolSetting: async () => false }));
vi.mock("@/services/agents/html-preview-artifacts", () => ({ sanitizePreviewHtml: () => ({ ok: false, reason: "x" }) }));
vi.mock("@/services/approvals/chat-card-attach", () => ({ attachCardToChat: db.attach }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  tool: (name: string, _d: string, _s: unknown, handler: never) => {
    const t = { name, handler };
    db.tools.push(t);
    return t;
  },
  createSdkMcpServer: (cfg: unknown) => cfg,
}));

import { mcpUiTools } from "../mcp-ui-tools";

async function ask(actor_user_id: string | null, args: unknown = { channel: "email_marketing" }) {
  db.tools.length = 0;
  await mcpUiTools({ tenant_id: T, run_id: "run-1", agent_slug: "email_marketing", frontend_tools: [], approval_cards: true, actor_user_id });
  const r = await db.tools.find((t) => t.name === "show_approval_cards")!.handler(args);
  return { text: r.content.map((c) => c.text).join("\n"), isError: r.isError === true };
}

describe("show_approval_cards: a member asks about a waiting email card on the decisions rail", () => {
  beforeEach(() => {
    db.roles = new Map([[MEMBER, "member"], ["admin-1", "admin"], ["owner-1", "owner"], ["viewer-1", "viewer"]]);
    db.roleReads = [];
    db.roleFails = false;
    db.attach.mockClear();
    db.pending = [
      { id: CARD, decision_class: "bulk_outbound.send", home: "channel", home_channel: "email_marketing", emitted_at: "2026-10-27T08:22:48Z" },
      { id: "00000000-0000-4000-8000-0000000000aa", decision_class: "google_ads.campaign_budget", home: "channel", home_channel: "google_ads", emitted_at: "2026-10-27T08:00:00Z" },
    ];
    db.channelActions = [];
  });

  it("reports the card as waiting, says an owner or admin must approve it, and offers the member a test", async () => {
    const r = await ask(MEMBER);
    expect(r.isError).toBe(false);
    expect(db.roleReads).toEqual([{ user_id: MEMBER }]);
    expect(db.attach).not.toHaveBeenCalled();
    expect(r.text).not.toMatch(/No growth or Needs-you card is waiting/);
    expect(r.text).toMatch(/1 card\(s\) are waiting on the channel pages linked below/);
    expect(r.text).toMatch(/an owner or admin has to approve it/i);
    expect(r.text).toMatch(/they cannot approve any card/);
    expect(r.text).toMatch(/send themselves a test of any version/);
    expect(r.text).toMatch(/\[Email campaigns · 1\]\(\/workspace\?tab=channels&channel=email_marketing\)/);
    expect(r.text).not.toMatch(/google_ads|Google Ads/);
    expect(r.text).not.toMatch(/The founder approves/);
    expect(r.text).not.toMatch(/bulk_outbound|home_channel|decision_class/);
  });

  it("an admin asking is told the card waits, with no member wording", async () => {
    const r = await ask("admin-1");
    expect(r.text).toMatch(/1 card\(s\) are waiting on the channel pages linked below/);
    expect(r.text).not.toMatch(/owner or admin|cannot approve|send themselves a test/);
  });

  it("a viewer is told an owner or admin must approve, but is not offered a test", async () => {
    const r = await ask("viewer-1");
    expect(r.text).toMatch(/an owner or admin has to approve it/i);
    expect(r.text).not.toMatch(/send themselves a test/);
  });

  it("a failed role read never claims the asker can or cannot approve, and still reports the waiting card", async () => {
    db.roleFails = true;
    const r = await ask(MEMBER);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/1 card\(s\) are waiting on the channel pages/);
    expect(r.text).not.toMatch(/owner or admin|cannot approve/);
  });

  it("with no signed-in asker the role is not read", async () => {
    await ask(null);
    expect(db.roleReads).toEqual([]);
  });

  it("a member shown a growth card in chat is told an owner or admin approves it, not the founder", async () => {
    db.pending = [{ id: CARD, decision_class: "google_ads.campaign_budget", home: "growth", home_channel: null, emitted_at: "2026-10-27T08:00:00Z" }];
    const r = await ask(MEMBER, {});
    expect(db.attach).toHaveBeenCalledTimes(1);
    expect(r.text).toMatch(/Showed 1 live approval card under your reply\. An owner or admin approves or rejects right on them/);
    expect(r.text).toMatch(/an owner or admin has to approve it/i);
    expect(r.text).not.toMatch(/send themselves a test/);
  });

  it("with nothing waiting anywhere it still says nothing is waiting", async () => {
    db.pending = [];
    const r = await ask("owner-1");
    expect(r.text).toMatch(/No growth or Needs-you card is waiting on the founder\. Say so in one line\./);
  });
});
