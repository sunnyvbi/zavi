
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn() }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));

import { getSecret } from "@/services/secrets/vault";
import * as supabaseModule from "@/services/supabase";
import { loadThreadExcerpt } from "../load-thread-excerpt";

const mockedGetSecret = getSecret as unknown as ReturnType<typeof vi.fn>;
const mockedServiceClient = supabaseModule.serviceClient as unknown as ReturnType<typeof vi.fn>;

const TENANT = "00000000-0000-0000-0000-00000000aaaa";
const BOT_USER = "UZAVIBOT";

function botUserRow(bot_user_id: string | null) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) builder[m] = vi.fn(() => builder);
  builder.maybeSingle = vi.fn(async () => ({ data: { bot_user_id }, error: null }));
  return { from: vi.fn(() => builder) };
}

function repliesWithCard() {
  const messages = [
    { ts: "100.0", user: "UHUMAN", text: "hey" },
    {
      ts: "100.1",
      user: BOT_USER,
      bot_id: "B123",
      text: "Approval needed: Hand work to a specialist agent",
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: "Hand work to a specialist agent", emoji: true },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Process refund for Trip 16352 — $1,388 charge on guest Justin (userId 1009040, charge ch_3TsdgILKcPR2aUso0TyO2TZX) was not reversed after admin cancellation on Jul 13.",
          },
        },
        { type: "section", fields: [{ type: "mrkdwn", text: "*Target agent*\nsupport-lead" }] },
      ],
    },
    { ts: "100.2", user: "UHUMAN", text: "is this really true? can you check with stripe?" },
  ];
  return vi.fn(async () =>
    new Response(JSON.stringify({ ok: true, messages }), { status: 200 }),
  );
}

describe("loadThreadExcerpt — Block Kit approval card is visible", () => {
  beforeEach(() => {
    mockedGetSecret.mockReset();
    mockedServiceClient.mockReset();
  });

  it("surfaces the approval-card proposal body + target agent (not just the title)", async () => {
    mockedServiceClient.mockReturnValue(botUserRow(BOT_USER));
    mockedGetSecret.mockResolvedValue("xoxb-keyed");
    vi.stubGlobal("fetch", repliesWithCard());

    const out = await loadThreadExcerpt({
      tenant_id: TENANT,
      team_id: "TKEYED",
      channel: "C1",
      thread_ts: "100.0",
      event_ts: "100.2",
    });

    expect(out).not.toBeNull();
    const text = out!.text;
    expect(text).toContain("Process refund for Trip 16352");
    expect(text).toContain("$1,388");
    expect(text).toContain("support-lead");
    expect(text).toContain("check with stripe");
  });

  it("does NOT drop @mentions/links from a normal human rich_text message", async () => {
    mockedServiceClient.mockReturnValue(botUserRow(BOT_USER));
    mockedGetSecret.mockResolvedValue("xoxb-keyed");
    const messages = [
      { ts: "200.0", user: "UHUMAN", text: "root" },
      {
        ts: "200.1",
        user: "UHUMAN",
        text: "hey <@U999> can you check <https://stripe.com|the charge>?",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "hey " },
                  { type: "user", user_id: "U999" },
                  { type: "text", text: " can you check " },
                  { type: "link", url: "https://stripe.com", text: "the charge" },
                  { type: "text", text: "?" },
                ],
              },
            ],
          },
        ],
      },
      { ts: "200.2", user: "UHUMAN", text: "follow up" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, messages }), { status: 200 })),
    );

    const out = await loadThreadExcerpt({
      tenant_id: TENANT,
      team_id: "TKEYED",
      channel: "C1",
      thread_ts: "200.0",
      event_ts: "200.2",
    });

    expect(out).not.toBeNull();
    expect(out!.text).toContain("<@U999>");
    expect(out!.text).toContain("stripe.com");
  });

  it("does NOT let a link-unfurl attachment override the human's text", async () => {
    mockedServiceClient.mockReturnValue(botUserRow(BOT_USER));
    mockedGetSecret.mockResolvedValue("xoxb-keyed");
    const messages = [
      { ts: "300.0", user: "UHUMAN", text: "root" },
      {
        ts: "300.1",
        user: "UHUMAN",
        text: "my own words: look at https://example.com",
        attachments: [{ title: "Example Domain", text: "This domain is for use in illustrative examples." }],
      },
      { ts: "300.2", user: "UHUMAN", text: "ok?" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, messages }), { status: 200 })),
    );

    const out = await loadThreadExcerpt({
      tenant_id: TENANT,
      team_id: "TKEYED",
      channel: "C1",
      thread_ts: "300.0",
      event_ts: "300.2",
    });

    expect(out).not.toBeNull();
    expect(out!.text).toContain("my own words");
    expect(out!.text).not.toContain("illustrative examples");
  });
});
