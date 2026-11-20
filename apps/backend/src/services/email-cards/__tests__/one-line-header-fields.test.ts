import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("@/services/auth/middleware", () => ({
  requireAuth: async () => ({ tenant_id: "tenant-1", user_id: "user-1" }),
}));

import { emailContentSchema } from "@/services/email-cards/variants";
import { emailProposeCampaignTool } from "@/services/tools/email/propose_campaign";
import { emailCampaignProposeSendTool } from "@/services/tools/email-campaign/propose_send";
import { proposeOutboundEmailTool } from "@/services/tools/outbound/propose_email";
import { makeProposeCohortEmailTool } from "@/services/tools/outbound/propose_cohort_email";
import { emailCardHandlers } from "@/routes/email-cards";
import type { CardDeps } from "@/services/email-cards/cards";

const ok = {
  subject: "Spring offer",
  preview_text: "Ten percent off this week",
  title: "Spring",
  paragraphs: ["Hello"],
  button: { label: "Shop", url: "https://example.test" },
};

const HOSTILE = [
  ["CRLF header injection", "Hello\r\nBcc: victim@example.com"],
  ["bare LF", "Hello\nWorld"],
  ["bare CR", "Hello\rWorld"],
  ["tab", "Hello\tWorld"],
  ["NUL", "Hello\u0000World"],
  ["DEL", "Hello\u007fWorld"],
  ["C1 next line", "Hello\u0085World"],
  ["line separator", "Hello\u2028World"],
  ["paragraph separator", "Hello\u2029World"],
] as const;

describe("a subject, preview text or sender name with a line break is refused at every entry point", () => {
  it.each(HOSTILE)("email content schema refuses a subject with a %s", (_label, subject) => {
    const r = emailContentSchema.safeParse({ ...ok, subject });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].path).toEqual(["subject"]);
    expect(r.error!.issues[0].message).toBe("The subject must be on one line: remove the line break or hidden character from it.");
  });

  it.each(HOSTILE)("email content schema refuses preview text with a %s", (_label, preview_text) => {
    const r = emailContentSchema.safeParse({ ...ok, preview_text });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0].path).toEqual(["preview_text"]);
  });

  it("control: a plain subject with unicode punctuation and an empty preview still parse, and a paragraph may hold a line break", () => {
    expect(emailContentSchema.safeParse({ ...ok, subject: "Spring — 10% off, “today” only 🌸", preview_text: "" }).success).toBe(true);
    expect(emailContentSchema.safeParse({ ...ok, paragraphs: ["Line one\nLine two"] }).success).toBe(true);
  });

  it("email__propose_campaign refuses a CRLF in a version subject and in the sender name", () => {
    const base = { route: "sendgrid", audience_id: "list_1", variants: [ok] };
    expect(emailProposeCampaignTool.input_schema.safeParse(base).success).toBe(true);
    expect(emailProposeCampaignTool.input_schema.safeParse({ ...base, variants: [ok, { ...ok, subject: "Hi\r\nBcc: victim@example.com" }] }).success).toBe(false);
    expect(emailProposeCampaignTool.input_schema.safeParse({ ...base, from_name: "Acme\r\nBcc: victim@example.com" }).success).toBe(false);
    expect(emailProposeCampaignTool.input_schema.safeParse({ ...base, from_name: "Acme Store" }).success).toBe(true);
  });

  it("the older email tool send, the one-person email and the list email refuse a CRLF subject", () => {
    const send = { audience_id: "list_1", subject: "Hello", body_text: "Body" };
    expect(emailCampaignProposeSendTool.input_schema.safeParse(send).success).toBe(true);
    expect(emailCampaignProposeSendTool.input_schema.safeParse({ ...send, subject: "Hello\r\nBcc: v@example.com" }).success).toBe(false);
    expect(emailCampaignProposeSendTool.input_schema.safeParse({ ...send, preview_text: "a\nb" }).success).toBe(false);
    expect(emailCampaignProposeSendTool.input_schema.safeParse({ ...send, from_name: "A\r\nB" }).success).toBe(false);

    const one = { to: "person@example.com", subject: "Hello", body_text: "Body" };
    expect(proposeOutboundEmailTool.input_schema.safeParse(one).success).toBe(true);
    expect(proposeOutboundEmailTool.input_schema.safeParse({ ...one, subject: "Hello\r\nBcc: v@example.com" }).success).toBe(false);

    const cohort = makeProposeCohortEmailTool();
    const list = { list_name: "Members", subject: "Hello", body_text: "Body" };
    expect(cohort.input_schema.safeParse(list).success).toBe(true);
    expect(cohort.input_schema.safeParse({ ...list, subject: "Hello\r\nBcc: v@example.com" }).success).toBe(false);
  });
});

function fakeRes() {
  const res = { statusCode: 200, body: undefined as unknown };
  const r = res as unknown as Response & typeof res;
  (r as unknown as { status: (c: number) => Response }).status = (c: number) => {
    res.statusCode = c;
    return r;
  };
  (r as unknown as { json: (b: unknown) => Response }).json = (b: unknown) => {
    res.body = b;
    return r;
  };
  return r;
}

describe("PATCH /api/email-cards/:rail/:id/variants/:n", () => {
  const ID = "6f7c1e9a-2b3d-4c5e-8f90-1a2b3c4d5e6f";
  const patch = async (content: unknown) => {
    const calls: string[] = [];
    const rpc = (async (_t: string, name: string) => {
      calls.push(name);
      return { ok: false, code: "not_found" };
    }) as CardDeps["rpc"];
    const res = fakeRes();
    await emailCardHandlers({ rpc }).editVariant({ params: { rail: "channel_actions", id: ID, n: "1" }, body: { content } } as unknown as Request, res);
    return { res, calls };
  };

  it("the QA payload: a subject with CRLF + Bcc returns 400 with a sentence for the founder, and nothing reaches the database", async () => {
    const { res, calls } = await patch({ ...ok, subject: "Hello\r\nBcc: victim@example.com" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: { code: "bad_content", message: "The subject must be on one line: remove the line break or hidden character from it." },
    });
    expect(calls).toEqual([]);
  });

  it("a preview text with a line break is refused the same way", async () => {
    const { res, calls } = await patch({ ...ok, preview_text: "first\nsecond" });
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { message: string } }).error.message).toBe("The preview text must be on one line: remove the line break or hidden character from it.");
    expect(calls).toEqual([]);
  });

  it("control: a clean subject gets past the content check and reaches the card read", async () => {
    const { res, calls } = await patch(ok);
    expect(calls).toEqual(["email_card_view_state"]);
    expect(res.statusCode).toBe(404);
  });
});
