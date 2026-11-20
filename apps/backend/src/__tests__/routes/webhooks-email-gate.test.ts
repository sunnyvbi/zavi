
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import type { Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  send: vi.fn(),
  logEvent: vi.fn(),
  updates: [] as Record<string, unknown>[],
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: vi.fn(() => ({ rpc: mocks.rpc, from: mocks.from })),
}));
vi.mock("@/../workers/client", () => ({ inngest: { send: mocks.send } }));
vi.mock("@/services/logging/logEvent", () => ({ logEvent: mocks.logEvent }));
vi.mock("@/email/attachment-intake", () => ({ storeInboundAttachments: vi.fn(async () => []) }));

import { emailWebhook } from "@/routes/webhooks/email";

const SECRET = "test-email-webhook-secret";
const TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const INBOX = "upcarai@inbox.zaviagent.com";

const cfAr = (domain: string) =>
  `mx.cloudflare.net; dkim=pass header.d=${domain} header.s=20251104 header.b=Xx; ` +
  `dmarc=pass header.from=${domain} policy.dmarc=none; arc=none`;

const mkRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(c: number) {
      this.statusCode = c;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

function mkReq(envelope: Record<string, unknown>): Request {
  const body = Buffer.from(JSON.stringify(envelope));
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig =
    "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${body.toString("utf8")}`).digest("hex");
  return {
    body,
    header: (n: string) =>
      n === "x-praxis-email-timestamp" ? ts : n === "x-praxis-email-signature" ? sig : undefined,
  } as unknown as Request;
}

const envelopeFrom = (from: string, domain = from.split("@")[1]) => ({
  envelope_to: INBOX,
  from,
  envelope_from: from,
  auth_results: cfAr(domain),
  to: [INBOX],
  cc: [],
  subject: "q",
  message_id: `<${crypto.randomUUID()}@x.com>`,
  text: "how many hosts are active?",
  headers: {},
  body_hash: crypto.randomUUID(),
  spam_verdict: "pass",
});

function wire(opts: {
  isMember?: boolean;
  disabled?: string[];
  allowlist?: { kind: string; value: string }[];
  earlier?: { data: unknown; error: { message: string } | null };
  known?: Array<{ rfc_message_id: string; email_threads: { root_message_id: string } }>;
}) {
  mocks.rpc.mockImplementation(async (fn: string) => {
    switch (fn) {
      case "resolve_email_recipient":
        return { data: [{ tenant_id: TENANT, agent_slug: "operator", identity_id: "id-1" }], error: null };
      case "is_own_inbox_address":
        return { data: false, error: null };
      case "disabled_member_emails":
        return { data: opts.disabled ?? [], error: null };
      case "is_tenant_member_email":
        return { data: opts.isMember ?? false, error: null };
      case "email_allowlist_entries":
        return { data: opts.allowlist ?? [], error: null };
      case "ingest_email_message":
        return { data: [{ message_id: "msg-1", deduped: false }], error: null };
      default:
        return { data: null, error: null };
    }
  });
  mocks.from.mockImplementation(() => ({
    update: (values: Record<string, unknown>) => {
      mocks.updates.push(values);
      return { eq: () => ({ eq: () => ({ data: null, error: null }) }) };
    },
    select: (cols?: string) => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      q.eq = chain;
      q.in = chain;
      q.order = chain;
      if (cols?.includes("email_threads")) {
        q.limit = async () => ({ data: opts.known ?? [], error: null });
        return q;
      }
      q.limit = async () => opts.earlier ?? { data: [], error: null };
      return q;
    },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updates.length = 0;
  process.env.EMAIL_WEBHOOK_SECRET = SECRET;
});

describe("the real gate — a member is let in", () => {
  it("an authentic member enqueues a run", async () => {
    wire({ isMember: true });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("ravi@upcar.ai")), res);
    expect(res.body).toEqual({ ok: true });
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});

describe("the real gate — a DISABLED member is refused, and the allowlist cannot save them", () => {
  it("refuses a disabled member", async () => {
    wire({ isMember: true, disabled: ["bob@acme.com"] });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("bob@acme.com")), res);
    expect(res.body).toEqual({ ok: true, ignored: "sender_disabled" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("STILL refuses when their own domain is allowlisted (deny beats allow)", async () => {
    wire({
      isMember: true,
      disabled: ["bob@acme.com"],
      allowlist: [{ kind: "domain", value: "acme.com" }],
    });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("bob@acme.com")), res);
    expect(res.body).toEqual({ ok: true, ignored: "sender_disabled" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("STILL refuses when their exact address is allowlisted", async () => {
    wire({
      isMember: true,
      disabled: ["bob@acme.com"],
      allowlist: [{ kind: "address", value: "bob@acme.com" }],
    });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("bob@acme.com")), res);
    expect(res.body).toEqual({ ok: true, ignored: "sender_disabled" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("does not disable their colleague", async () => {
    wire({ isMember: true, disabled: ["bob@acme.com"] });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("carol@acme.com")), res);
    expect(res.body).toEqual({ ok: true });
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("is case-insensitive about the deny", async () => {
    wire({ isMember: true, disabled: ["bob@acme.com"] });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("BOB@ACME.COM", "acme.com")), res);
    expect(res.body).toEqual({ ok: true, ignored: "sender_disabled" });
  });
});

describe("the real gate — allowlist admits a non-member", () => {
  it("an allowlisted domain lets an outsider in", async () => {
    wire({ isMember: false, allowlist: [{ kind: "domain", value: "partner.com" }] });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("ops@partner.com")), res);
    expect(res.body).toEqual({ ok: true });
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("a non-member with an EMPTY allowlist is refused (members-only default)", async () => {
    wire({ isMember: false, allowlist: [] });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("stranger@evil.com")), res);
    expect(res.body).toEqual({ ok: true, ignored: "sender_not_a_member" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a non-member the allowlist does not cover is refused", async () => {
    wire({ isMember: false, allowlist: [{ kind: "domain", value: "partner.com" }] });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("stranger@evil.com")), res);
    expect(res.body).toEqual({ ok: true, ignored: "sender_not_allowlisted" });
  });

  it("a freemail wildcard planted in the table admits nobody", async () => {
    wire({ isMember: false, allowlist: [{ kind: "domain", value: "gmail.com" }] });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("stranger@gmail.com")), res);
    expect(res.body).toEqual({ ok: true, ignored: "sender_not_allowlisted" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("the real gate — an allowlist entry NEVER bypasses authenticity", () => {
  it("an allowlisted domain with an unaligned dmarc=pass is still refused", async () => {
    wire({ isMember: false, allowlist: [{ kind: "domain", value: "partner.com" }] });
    const env = {
      ...envelopeFrom("ops@partner.com"),
      auth_results: "mx.cloudflare.net; dkim=pass header.d=evil.com; dmarc=pass header.from=evil.com",
    };
    const res = mkRes();
    await emailWebhook(mkReq(env), res);
    expect(res.body).toEqual({ ok: true, ignored: "sender_unauthenticated" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("a DISABLED member is refused before authenticity even matters", async () => {
    wire({ isMember: true, disabled: ["bob@acme.com"] });
    const env = { ...envelopeFrom("bob@acme.com"), auth_results: null };
    const res = mkRes();
    await emailWebhook(mkReq(env), res);
    expect(res.body).toEqual({ ok: true, ignored: "sender_unauthenticated" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("the real gate — fail CLOSED, never open", () => {
  it("refuses when the disabled set cannot be read", async () => {
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === "resolve_email_recipient")
        return { data: [{ tenant_id: TENANT, agent_slug: "operator", identity_id: "i" }], error: null };
      if (fn === "is_own_inbox_address") return { data: false, error: null };
      if (fn === "disabled_member_emails") return { data: null, error: { message: "boom" } };
      return { data: null, error: null };
    });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("ravi@upcar.ai")), res);
    expect(res.body).toEqual({ ok: true, ignored: "member_state_unavailable" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("refuses a non-member when the allowlist cannot be read", async () => {
    mocks.rpc.mockImplementation(async (fn: string) => {
      if (fn === "resolve_email_recipient")
        return { data: [{ tenant_id: TENANT, agent_slug: "operator", identity_id: "i" }], error: null };
      if (fn === "is_own_inbox_address") return { data: false, error: null };
      if (fn === "disabled_member_emails") return { data: [], error: null };
      if (fn === "is_tenant_member_email") return { data: false, error: null };
      if (fn === "email_allowlist_entries") return { data: null, error: { message: "boom" } };
      return { data: null, error: null };
    });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("ops@partner.com")), res);
    expect(res.body).toEqual({ ok: true, ignored: "allowlist_unavailable" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("the real gate — a replayed Message-ID is parked, never a second trusted run", () => {
  it("the first copy from a member is stamped verified and triaged", async () => {
    wire({ isMember: true });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("ravi@upcar.ai")), res);
    expect(res.body).toEqual({ ok: true });
    expect(mocks.updates).toContainEqual({ sender_verified_member: true });
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("a second copy with the same Message-ID (different raw MIME) is parked unstamped", async () => {
    wire({ isMember: true, earlier: { data: [{ id: "msg-0" }], error: null } });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("ravi@upcar.ai")), res);
    expect(res.body).toEqual({ ok: true, parked: "duplicate_message_id" });
    expect(mocks.updates).not.toContainEqual({ sender_verified_member: true });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("when this copy IS the earliest, it proceeds (two overlapping copies never both park)", async () => {
    wire({ isMember: true, earlier: { data: [{ id: "msg-1" }], error: null } });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("ravi@upcar.ai")), res);
    expect(res.body).toEqual({ ok: true });
    expect(mocks.updates).toContainEqual({ sender_verified_member: true });
    expect(mocks.send).toHaveBeenCalledOnce();
  });

  it("if the replay check cannot be read, the message runs but is NOT marked trusted", async () => {
    wire({ isMember: true, earlier: { data: null, error: { message: "boom" } } });
    const res = mkRes();
    await emailWebhook(mkReq(envelopeFrom("ravi@upcar.ai")), res);
    expect(res.body).toEqual({ ok: true });
    expect(mocks.updates).not.toContainEqual({ sender_verified_member: true });
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});

describe("the real gate — a DKIM pass counts only for the domain in its own clause", () => {
  it("refuses the failing-gmail + passing-evil signature pair for a gmail member", async () => {
    wire({ isMember: true });
    const env = {
      ...envelopeFrom("founder@gmail.com"),
      auth_results:
        "mx.cloudflare.net; dkim=fail header.d=gmail.com; dkim=pass header.d=evil.com; dmarc=fail header.from=gmail.com",
    };
    const res = mkRes();
    await emailWebhook(mkReq(env), res);
    expect(res.body).toEqual({ ok: true, ignored: "sender_unauthenticated" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});

describe("threading — a reply joins the thread of any reference we hold", () => {
  const rootArg = () =>
    (mocks.rpc.mock.calls.find((c) => c[0] === "ingest_email_message")?.[1] as Record<string, unknown>)
      ?.p_root_message_id;

  it("References [<unknown sendgrid id>, <known gmail id>] lands in the existing thread", async () => {
    wire({
      isMember: true,
      known: [{ rfc_message_id: "cabc@mail.gmail.com", email_threads: { root_message_id: "zavi-root@inbox.zaviagent.com" } }],
    });
    const res = mkRes();
    await emailWebhook(
      mkReq({
        ...envelopeFrom("ravi@upcar.ai"),
        references: ["<sg-unknown@sendgrid.net>", "<CAbc@mail.gmail.com>"],
        in_reply_to: "<CAbc@mail.gmail.com>",
      }),
      res,
    );
    expect(res.body).toEqual({ ok: true });
    expect(rootArg()).toBe("zavi-root@inbox.zaviagent.com");
  });

  it("falls back to References[0] when no id is known", async () => {
    wire({ isMember: true });
    const res = mkRes();
    await emailWebhook(
      mkReq({ ...envelopeFrom("ravi@upcar.ai"), references: ["<First@x>", "<second@x>"] }),
      res,
    );
    expect(rootArg()).toBe("first@x");
  });
});
