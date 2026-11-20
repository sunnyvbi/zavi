import { describe, expect, it } from "vitest";
import { sendgrid } from "../providers-sendgrid";
import type { ProviderCall } from "../providers";

const send = (id: string, at: string, status = "triggered") => ({ id, name: id, status, send_at: at });

function pagedCall(pages: Array<Array<Record<string, unknown>>>): { call: ProviderCall; tokens: Array<string | null> } {
  const tokens: Array<string | null> = [];
  const call = (async (slug: string, args: Record<string, unknown>) => {
    if (slug !== "SENDGRID_SINGLE_SENDS") throw new Error(slug);
    const token = ((args.query as Record<string, unknown>)?.page_token as string | undefined) ?? null;
    tokens.push(token);
    const i = token ? Number(token.slice(1)) : 0;
    const next = i + 1 < pages.length ? `p${i + 1}` : null;
    return { ok: true, status: 200, data: { result: pages[i], _metadata: next ? { next: `https://api.sendgrid.com/v3/marketing/singlesends?page_size=100&page_token=${next}` } : {} } };
  }) as unknown as ProviderCall;
  return { call, tokens };
}

describe("SendGrid sent history is newest first across every page", () => {
  it("the newest sends on a later page come before older ones on the first page", async () => {
    const { call, tokens } = pagedCall([
      [send("a", "2026-09-01T10:00:00Z"), send("b", "2026-09-02T10:00:00Z"), send("x", "2026-10-01T10:00:00Z", "draft")],
      [send("c", "2026-10-10T10:00:00Z"), send("d", "2026-10-09T10:00:00Z")],
      [send("e", "2026-09-20T10:00:00Z"), send("a", "2026-09-01T10:00:00Z")],
    ]);
    const page = await sendgrid.listSentCampaignsPage(call, { since: "2026-08-01T00:00:00Z", cursor: null, limit: 20 });
    expect(page.campaigns.map((c) => c.id)).toEqual(["c", "d", "e", "b", "a"]);
    expect(page.next).toBeNull();
    expect(tokens).toEqual([null, "p1", "p2"]);
  });

  it("a page token that repeats ends the walk", async () => {
    const tokens: Array<string | null> = [];
    const call = (async (_s: string, args: Record<string, unknown>) => {
      tokens.push(((args.query as Record<string, unknown>)?.page_token as string | undefined) ?? null);
      return { ok: true, status: 200, data: { result: [send(`s${tokens.length}`, "2026-10-01T00:00:00Z")], _metadata: { next: "https://api.sendgrid.com/v3/marketing/singlesends?page_token=same" } } };
    }) as unknown as ProviderCall;
    const page = await sendgrid.listSentCampaignsPage(call, { since: "2026-08-01T00:00:00Z", cursor: null, limit: 20 });
    expect(tokens).toEqual([null, "same"]);
    expect(page.campaigns).toHaveLength(2);
  });
});
