
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/services/supabase", () => ({ serviceClient: () => ({}) }));

import { includesForTier } from "@zavi/shared";
import {
  compEmailKind,
  compEndingEmailKey,
  compEndingEmailsEnabledFromBlob,
  sendCompEndingEmails,
  type EndingComp,
} from "../comp-ending-email";
import { renderCompEndingEmail } from "@/email/templates/comp-ending";

const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2026-11-07T08:20:00.000Z");
const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * 3_600_000).toISOString();

function onceLedger() {
  const sent = new Set<string>();
  return vi.fn(async (key: string, send: () => Promise<void>) => {
    if (sent.has(key)) return "already_sent" as const;
    await send();
    sent.add(key);
    return "sent" as const;
  });
}

beforeEach(() => {
  process.env.WEB_BASE_URL = "https://www.zaviagent.com";
});

describe("compEmailKind", () => {
  it("week inside 7 days, day inside the last 24 hours, nothing otherwise", () => {
    expect(compEmailKind(new Date(at(7 * 24)), NOW)).toBe("week");
    expect(compEmailKind(new Date(at(25)), NOW)).toBe("week");
    expect(compEmailKind(new Date(at(24)), NOW)).toBe("day");
    expect(compEmailKind(new Date(at(1)), NOW)).toBe("day");
    expect(compEmailKind(new Date(at(7 * 24 + 1)), NOW)).toBeNull();
    expect(compEmailKind(new Date(at(0)), NOW)).toBeNull();
    expect(compEmailKind(new Date(at(-5)), NOW)).toBeNull();
  });
});

describe("comp_ending_emails_enabled switch", () => {
  it("only a literal true turns it on; missing, false, junk or no blob is off", () => {
    expect(compEndingEmailsEnabledFromBlob({ comp_ending_emails_enabled: true })).toBe(true);
    expect(compEndingEmailsEnabledFromBlob({ comp_ending_emails_enabled: false })).toBe(false);
    expect(compEndingEmailsEnabledFromBlob({ comp_ending_emails_enabled: "true" })).toBe(false);
    expect(compEndingEmailsEnabledFromBlob({})).toBe(false);
    expect(compEndingEmailsEnabledFromBlob(null)).toBe(false);
    expect(compEndingEmailsEnabledFromBlob(undefined)).toBe(false);
  });

  const comp: EndingComp = { tenant_id: T1, tier: "pro", comp_expires_at: at(7 * 24) };
  const base = () => ({
    sendOnce: onceLedger(),
    stillEnding: vi.fn(async () => true),
    ownerEmail: vi.fn(async (_t: string): Promise<string | null> => "owner@example.com"),
    send: vi.fn(async () => {}),
    freeDailyCredits: vi.fn(async () => 5000),
    warn: vi.fn(),
    now: () => NOW,
  });

  it("switch off: sends nothing and touches nothing", async () => {
    const d = { ...base(), enabled: vi.fn(async () => false) };
    expect(await sendCompEndingEmails([comp], d)).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(d.send).not.toHaveBeenCalled();
    expect(d.sendOnce).not.toHaveBeenCalled();
    expect(d.stillEnding).not.toHaveBeenCalled();
  });

  it("switch on: sends as before", async () => {
    const d = { ...base(), enabled: vi.fn(async () => true) };
    expect(await sendCompEndingEmails([comp], d)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    expect(d.send).toHaveBeenCalledTimes(1);
  });
});

describe("sendCompEndingEmails", () => {
  const deps = () => ({
    enabled: vi.fn(async () => true),
    sendOnce: onceLedger(),
    stillEnding: vi.fn(async () => true),
    ownerEmail: vi.fn(async (_t: string): Promise<string | null> => "owner@example.com"),
    send: vi.fn(async () => {}),
    freeDailyCredits: vi.fn(async () => 5000),
    warn: vi.fn(),
    now: () => NOW,
  });

  it("the Nov 14 Pro comps: 7 days out gets the week email, once, however many daily runs see it", async () => {
    const d = deps();
    const comp: EndingComp = { tenant_id: T1, tier: "pro", comp_expires_at: at(7 * 24) };
    expect(await sendCompEndingEmails([comp], d)).toEqual({ sent: 1, skipped: 0, failed: 0 });
    await sendCompEndingEmails([comp], d);
    expect(d.send).toHaveBeenCalledTimes(1);
    const [to, subject, , text] = d.send.mock.calls[0] as unknown as string[];
    expect(to).toBe("owner@example.com");
    expect(subject).toBe("Your free Pro plan ends on November 14");
    expect(text).toContain(`https://www.zaviagent.com/workspace?tab=settings&company=${T1}#billing`);
    expect(text).toContain("5,000 credits every day");
    expect(d.sendOnce).toHaveBeenCalledWith(compEndingEmailKey("week", T1, comp.comp_expires_at), expect.any(Function));
  });

  it("on the day it sends the day email, separate from the week one", async () => {
    const d = deps();
    const exp = at(10);
    await sendCompEndingEmails([{ tenant_id: T1, tier: "pro", comp_expires_at: exp }], d);
    const [, subject] = d.send.mock.calls[0] as unknown as string[];
    expect(subject).toBe("Your free Pro plan ends today");
    expect(d.sendOnce).toHaveBeenCalledWith(compEndingEmailKey("day", T1, exp), expect.any(Function));
  });

  it("a staff extension (new end date) re-arms the emails", async () => {
    const d = deps();
    await sendCompEndingEmails([{ tenant_id: T1, tier: "pro", comp_expires_at: at(6 * 24) }], d);
    await sendCompEndingEmails([{ tenant_id: T1, tier: "pro", comp_expires_at: at(6 * 24 + 12) }], d);
    expect(d.send).toHaveBeenCalledTimes(2);
  });

  it("names the comp's own tier, and skips free/unknown tiers and owners without email", async () => {
    const d = deps();
    d.ownerEmail.mockImplementation(async (t: string) => (t === T2 ? null : "owner@example.com"));
    const out = await sendCompEndingEmails(
      [
        { tenant_id: T1, tier: "starter", comp_expires_at: at(48) },
        { tenant_id: T1, tier: null, comp_expires_at: at(48) },
        { tenant_id: T2, tier: "pro", comp_expires_at: at(48) },
      ],
      d,
    );
    expect(out).toEqual({ sent: 1, skipped: 2, failed: 0 });
    expect((d.send.mock.calls[0] as unknown as string[])[1]).toBe("Your free Starter plan ends on November 9");
  });

  it("a comp extended or paid for since the snapshot (re-read differs) gets no email", async () => {
    const d = deps();
    d.stillEnding.mockResolvedValueOnce(false);
    expect(await sendCompEndingEmails([{ tenant_id: T1, tier: "pro", comp_expires_at: at(48) }], d)).toEqual({
      sent: 0, skipped: 1, failed: 0,
    });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("an owner lookup ERROR is a failure (retried tomorrow), not a silent 'no owner'", async () => {
    const d = deps();
    d.ownerEmail.mockRejectedValueOnce(new Error("owner lookup failed"));
    expect(await sendCompEndingEmails([{ tenant_id: T1, tier: "pro", comp_expires_at: at(48) }], d)).toEqual({
      sent: 0, skipped: 0, failed: 1,
    });
  });

  it("one tenant's failed send is counted and logged; the others still go out", async () => {
    const d = deps();
    d.send.mockRejectedValueOnce(new Error("sendgrid down"));
    const out = await sendCompEndingEmails(
      [
        { tenant_id: T1, tier: "pro", comp_expires_at: at(48) },
        { tenant_id: T2, tier: "pro", comp_expires_at: at(48) },
      ],
      d,
    );
    expect(out).toEqual({ sent: 1, skipped: 0, failed: 1 });
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining(T1));
  });
});

describe("renderCompEndingEmail", () => {
  const base = {
    kind: "week" as const,
    tierName: "Pro",
    endsAt: new Date("2026-11-14T18:00:00Z"),
    now: NOW,
    freeIncludes: includesForTier("free"),
    freeDailyCredits: 1000,
    billingUrl: "https://x.test/billing",
  };

  it("lists what Free keeps (from the pricing config), the keep-Pro link and the question", () => {
    const m = renderCompEndingEmail(base);
    for (const line of includesForTier("free")) expect(m.text).toContain(line);
    expect(m.text).toContain("1,000 credits every day");
    expect(m.text).toContain("ends on November 14");
    expect(m.text).toContain("Keep Pro: https://x.test/billing");
    expect(m.html).toContain("Keep Pro");
    expect(m.text).toContain("what did you expect Zavi to do?");
  });

  it("offers no discount and uses no dashes", () => {
    const m = renderCompEndingEmail(base);
    expect(m.text).not.toMatch(/discount|% off|coupon|promo/i);
    expect(m.text).not.toMatch(/[—–]|--/);
  });

  it("the day email says today or tomorrow by UTC date", () => {
    const today = renderCompEndingEmail({ ...base, kind: "day", endsAt: new Date("2026-11-07T20:00:00Z") });
    const tomorrow = renderCompEndingEmail({ ...base, kind: "day", endsAt: new Date("2026-11-08T02:00:00Z") });
    expect(today.subject).toBe("Your free Pro plan ends today");
    expect(tomorrow.subject).toBe("Your free Pro plan ends tomorrow");
  });

  it("a staff comp ending at 00:00 UTC: its last day is the day before, and that day's email says today", () => {
    const now = new Date("2026-11-27T08:20:00Z");
    const endsAt = new Date("2026-11-28T00:00:00Z");
    const day = renderCompEndingEmail({ ...base, kind: "day", now, endsAt });
    expect(day.subject).toBe("Your free Pro plan ends today");
    expect(day.text).toContain("runs through November 27 (UTC)");
    const week = renderCompEndingEmail({ ...base, now: new Date("2026-11-21T08:20:00Z"), endsAt });
    expect(week.subject).toBe("Your free Pro plan ends on November 27");
  });

  it("a non-midnight end names its exact UTC time, never 'runs through' the whole day", () => {
    const m = renderCompEndingEmail({ ...base, endsAt: new Date("2026-11-14T18:00:00Z") });
    expect(m.text).toContain("ends on November 14 at 18:00 UTC");
    expect(m.text).not.toContain("runs through");
    expect(m.html).toContain("After November 14 at 18:00 UTC");
  });
});
