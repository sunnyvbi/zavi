import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  verifyEmailSignature,
  computeDedupKey,
  isAutoSubmitted,
  normalizeMessageId,
  resolveKnownThreadRoot,
} from "../../routes/webhooks/email";

const SECRET = "test-email-secret";
function sign(ts: string, body: string): string {
  return "v0=" + crypto.createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");
}

describe("verifyEmailSignature (HMAC trust boundary)", () => {
  const ts = Math.floor(Date.now() / 1000).toString();
  const body = JSON.stringify({ envelope_to: "operator@a.inbox.zaviagent.com", from: "x@y.com" });

  it("accepts a correctly signed body", () => {
    expect(verifyEmailSignature(SECRET, body, ts, sign(ts, body))).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyEmailSignature(SECRET, body + "x", ts, sign(ts, body))).toBe(false);
  });
  it("rejects a wrong secret", () => {
    const bad = "v0=" + crypto.createHmac("sha256", "other").update(`v0:${ts}:${body}`).digest("hex");
    expect(verifyEmailSignature(SECRET, body, ts, bad)).toBe(false);
  });
  it("rejects a stale timestamp (>5min)", () => {
    const old = (Math.floor(Date.now() / 1000) - 600).toString();
    expect(verifyEmailSignature(SECRET, body, old, sign(old, body))).toBe(false);
  });
  it("rejects a non-numeric timestamp", () => {
    expect(verifyEmailSignature(SECRET, body, "nope", sign("nope", body))).toBe(false);
  });
  it("rejects a length-mismatched signature without throwing", () => {
    expect(verifyEmailSignature(SECRET, body, ts, "v0=short")).toBe(false);
  });
});

describe("computeDedupKey (D4 — tenant-scoped, not raw Message-ID)", () => {
  const T1 = "11111111-1111-1111-1111-111111111111";
  const T2 = "22222222-2222-2222-2222-222222222222";
  const to = "operator@a.inbox.zaviagent.com";

  it("is deterministic for identical inputs", () => {
    expect(computeDedupKey(T1, to, "<m1@x>", "bh")).toBe(computeDedupKey(T1, to, "<m1@x>", "bh"));
  });
  it("DIFFERS across tenants for the SAME Message-ID (cross-tenant collision defense)", () => {
    expect(computeDedupKey(T1, to, "<same@x>", "bh")).not.toBe(
      computeDedupKey(T2, to, "<same@x>", "bh"),
    );
  });
  it("differs when the body hash differs (a re-send with new content is not a dup)", () => {
    expect(computeDedupKey(T1, to, "<m1@x>", "bhA")).not.toBe(
      computeDedupKey(T1, to, "<m1@x>", "bhB"),
    );
  });
  it("normalizes Message-ID brackets/case so the same id dedups", () => {
    expect(computeDedupKey(T1, to, "<M1@X>", "bh")).toBe(computeDedupKey(T1, to, "m1@x", "bh"));
  });
});

describe("isAutoSubmitted (D6 — auto-responder / bulk / DSN park)", () => {
  it("flags Auto-Submitted != no", () => {
    expect(isAutoSubmitted({ "Auto-Submitted": "auto-replied" })).toBe(true);
  });
  it("does NOT flag Auto-Submitted: no", () => {
    expect(isAutoSubmitted({ "Auto-Submitted": "no" })).toBe(false);
  });
  it("flags Precedence: bulk / list", () => {
    expect(isAutoSubmitted({ Precedence: "bulk" })).toBe(true);
    expect(isAutoSubmitted({ precedence: "list" })).toBe(true);
  });
  it("flags listserv (List-Id / List-Unsubscribe)", () => {
    expect(isAutoSubmitted({ "List-Id": "<l.x.com>" })).toBe(true);
  });
  it("flags X-Auto-Response-Suppress", () => {
    expect(isAutoSubmitted({ "X-Auto-Response-Suppress": "All" })).toBe(true);
  });
  it("flags empty Return-Path (bounce/DSN)", () => {
    expect(isAutoSubmitted({ "Return-Path": "<>" })).toBe(true);
  });
  it("passes a normal human email", () => {
    expect(isAutoSubmitted({ From: "a@b.com", Subject: "hi" })).toBe(false);
    expect(isAutoSubmitted(undefined)).toBe(false);
  });
});

describe("normalizeMessageId", () => {
  it("strips angle brackets + lowercases + trims", () => {
    expect(normalizeMessageId("  <ABC@Host>  ")).toBe("abc@host");
  });
  it("handles undefined", () => {
    expect(normalizeMessageId(undefined)).toBe("");
  });
});

describe("resolveKnownThreadRoot", () => {
  function fakeSvc(rows: Array<{ rfc_message_id: string; email_threads: { root_message_id: string } }>) {
    const calls: Record<string, unknown[]> = {};
    const q: any = {};
    for (const k of ["select", "eq", "in"]) q[k] = (...a: unknown[]) => ((calls[k] = a), q);
    q.limit = async () => ({ data: rows.filter((r) => (calls.in?.[1] as string[]).includes(r.rfc_message_id)), error: null });
    return { svc: { from: (t: string) => ((calls.from = [t]), q) } as any, calls };
  }

  it("skips an unknown first reference and resolves to the known thread's root", async () => {
    const { svc, calls } = fakeSvc([
      { rfc_message_id: "cabc@mail.gmail.com", email_threads: { root_message_id: "zavi-root@inbox.zaviagent.com" } },
    ]);
    const root = await resolveKnownThreadRoot(svc, "t1", ["<sg-unknown@sendgrid.net>", "<CAbc@mail.gmail.com>"]);
    expect(root).toBe("zavi-root@inbox.zaviagent.com");
    expect(calls.from).toEqual(["email_messages"]);
    expect(calls.eq).toEqual(["tenant_id", "t1"]);
    expect(calls.in).toEqual(["rfc_message_id", ["sg-unknown@sendgrid.net", "cabc@mail.gmail.com"]]);
  });

  it("keeps the parent (last id) when the reference list is very long", async () => {
    const { svc, calls } = fakeSvc([{ rfc_message_id: "parent@x", email_threads: { root_message_id: "root-p" } }]);
    const ids = [...Array.from({ length: 80 }, (_, i) => `<r${i}@x>`), "<Parent@x>"];
    expect(await resolveKnownThreadRoot(svc, "t1", ids)).toBe("root-p");
    expect((calls.in?.[1] as string[]).length).toBe(50);
  });

  it("retries the lookup once on a read error", async () => {
    let n = 0;
    const q: any = {};
    for (const k of ["select", "eq", "in"]) q[k] = () => q;
    q.limit = async () =>
      ++n === 1
        ? { data: null, error: { message: "timeout" } }
        : { data: [{ rfc_message_id: "a@x", email_threads: { root_message_id: "root-a" } }], error: null };
    expect(await resolveKnownThreadRoot({ from: () => q } as any, "t1", ["<a@x>"])).toBe("root-a");
    expect(n).toBe(2);
  });

  it("prefers the earliest known reference", async () => {
    const { svc } = fakeSvc([
      { rfc_message_id: "b@x", email_threads: { root_message_id: "root-b" } },
      { rfc_message_id: "a@x", email_threads: { root_message_id: "root-a" } },
    ]);
    expect(await resolveKnownThreadRoot(svc, "t1", ["<a@x>", "<b@x>"])).toBe("root-a");
  });

  it("returns null when nothing is known, or there are no ids", async () => {
    const { svc } = fakeSvc([]);
    expect(await resolveKnownThreadRoot(svc, "t1", ["<z@x>"])).toBeNull();
    expect(await resolveKnownThreadRoot(svc, "t1", [undefined, ""])).toBeNull();
  });
});
