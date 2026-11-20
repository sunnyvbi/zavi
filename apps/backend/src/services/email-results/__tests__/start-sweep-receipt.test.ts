import { describe, expect, it, vi } from "vitest";
import { shaOf } from "@/services/email-cards/variants";
import { startEmailSendResult, type ResultRow } from "../start";

const db = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, selected: [] as string[] }));
vi.mock("@/services/tenant-client", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const chain = {
    from: () => chain,
    select: (cols: string) => {
      db.selected.push(cols);
      return chain;
    },
    eq: () => chain,
    maybeSingle: async () => ({ data: db.row, error: null }),
  };
  return { ...real, asTenantId: (t: string) => t, tenantClient: () => chain };
});

const T = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-10-28T12:00:00Z");
const content = { subject: "Autumn update", preview_text: "", title: "Hello", paragraphs: ["Hi"], button: { label: "Read", url: "https://northwind.test/a" } };
const variant = { content, html: "<p>x</p>", text: "x", render_sha: shaOf("r1", "<p>x</p>", "x") };
const body = {
  tool: "mailchimp",
  credential: { kind: "composio", connected_account_id: "acct-1", auth_config_id: "ac" },
  audience_id: "list-1",
  audience_name: "Customers",
  audience_count: 1500,
  approved_count: 1400,
  variants: [variant],
  template_snapshot: {
    logo_url: null, brand_color: "#112233", button_color: "#112233", font_key: "system", sign_off: "Thanks", postal_address: "1 Main St",
    show_cards: false, company_name: "Northwind", own_host: "northwind.test", campaign_slug: "autumn-update-20261028-abcdefghij",
  },
  renderer_version: "r1",
  chosen_variant: 1,
  from_name: "Northwind",
  from_email: "hello@northwind.test",
  reply_to: null,
};

async function sweepStart(execResult: unknown): Promise<ResultRow[]> {
  db.row = {
    exec_class: "email_campaign.create_and_send",
    exec_payload: body,
    exec_progress: { campaign_id: "camp-1", stage: "sent" },
    exec_result: execResult,
    executed_at: "2026-10-28T10:00:00Z",
  };
  const rows: ResultRow[] = [];
  const out = await startEmailSendResult(
    { tenant_id: T, rail: "channel_actions", card_id: "c1", sent: null },
    {
      gaProperty: async () => null,
      slugTaken: async () => false,
      winLine: async () => ({ metric: "clicks", threshold: null, basis: "first_sends", n_past: 0 }),
      rpc: async (_t, row) => {
        rows.push(row);
        return { ok: true, created: true };
      },
      now: () => NOW,
    },
  );
  expect(out).toEqual({ started: true });
  return rows;
}

describe("must catch: the repair sweep starts a tool send's results with the provider's count, not the approved count", () => {
  it("a sent card's receipt says 1,234 people: the results row says 1,234, not the 1,400 approved", async () => {
    const rows = await sweepStart({ ok: true, receipt: { line: "Sent to 1,234 people via Mailchimp", url: null } });
    expect(rows).toHaveLength(1);
    expect(rows[0].sent_count).toBe(1234);
    expect(db.selected.some((c) => c.includes("exec_result"))).toBe(true);
  });

  it("a card with no readable receipt still falls back to the approved count", async () => {
    const rows = await sweepStart(null);
    expect(rows[0].sent_count).toBe(1400);
  });
});
