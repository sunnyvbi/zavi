
import { describe, it, expect, vi, beforeEach } from "vitest";

const CREATOR_ID = "11111111-0000-4000-8000-000000000001";
const TENANT_ID = "22222222-0000-4000-8000-000000000002";
const ORDER_ID = "33333333-0000-4000-8000-000000000003";
const CREATOR_EMAIL = "real.creator@example.com";
const OWNER_EMAIL = "founder@business.test";

type Row = Record<string, unknown> & { id?: string };
let rows: Row[] = [];

function fakeFrom(_table: string) {
  return {
    insert(row: Row) {
      return {
        select: () => ({
          single: async () => {
            const key = row.dedupe_key;
            if (key && rows.some((r) => r.dedupe_key === key)) {
              return {
                data: null,
                error: { code: "23505", message: "duplicate key value violates unique constraint" },
              };
            }
            const stored: Row = { id: `n${rows.length + 1}`, ...row };
            rows.push(stored);
            return { data: { id: stored.id }, error: null };
          },
        }),
      };
    },
    update(values: Row) {
      return {
        eq: async (_col: string, val: unknown) => {
          const r = rows.find((x) => x.id === val);
          if (r) Object.assign(r, values);
          return { error: null };
        },
      };
    },
  };
}

const readPii = vi.fn(async (_id: string) => ({
  human_member_id: CREATOR_ID,
  legal_name: "A Creator",
  email: CREATOR_EMAIL,
}));
const resolveAgentEmailRecipients = vi.fn(async (_tid: string) => [
  { email: OWNER_EMAIL, is_owner: true, id: null, label: "Owner" },
]);
const sgSend = vi.fn(async (..._a: unknown[]) => {});

vi.mock("@/services/tenant-client", () => ({
  creatorInboxClient: () => ({ from: (t: string) => fakeFrom(t) }),
}));
vi.mock("@/services/humans/store", () => ({ readPii: (id: string) => readPii(id) }));
vi.mock("@/services/notifications/agent-email-recipients", () => ({
  resolveAgentEmailRecipients: (tid: string) => resolveAgentEmailRecipients(tid),
}));
vi.mock("@/email/sendAuthEmail", () => ({
  sgSend: (...a: unknown[]) => sgSend(...a),
}));

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONTACT_REDACTION } from "../contact-scrub";
import { notify, notifyBothSides, sendWindowReminder } from "@/services/creators/notify";
import { deadlineCopy } from "@/services/creators/deadline-copy";

const DEADLINE = "2026-09-14T18:30:00.000Z";

function deadlineLineOf(body: string): string | undefined {
  return body.split("\n\n").find((l) => l.startsWith("Deadline:"));
}

beforeEach(() => {
  rows = [];
  readPii.mockClear();
  resolveAgentEmailRecipients.mockClear();
  sgSend.mockClear();
});

describe("one event, one inbox row, one email", () => {
  it("writes a single creator row and sends a single email", async () => {
    const res = await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "booking_request_received",
      order_id: ORDER_ID,
      vars: {
        business_name: "Acme",
        job_title: "3 ad videos",
        payout_cents: 12750,
        deadline_kind: "accept",
        deadline_at: DEADLINE,
      },
    });

    expect(res.written).toBe(true);
    expect(res.emailed).toBe(true);
    expect(rows).toHaveLength(1);
    expect(sgSend).toHaveBeenCalledTimes(1);

    const row = rows[0];
    expect(row.recipient_kind).toBe("creator");
    expect(row.human_member_id).toBe(CREATOR_ID);
    expect(row.tenant_id).toBeNull();
    expect(row.order_id).toBe(ORDER_ID);
    expect(row.kind).toBe("booking_request_received");
    expect(row.link_path).toBe(`/creator/jobs/${ORDER_ID}`);
    expect(row.emailed_at).toEqual(expect.any(String));
    expect(String(row.body)).toContain("$127.50");

    expect(readPii).toHaveBeenCalledWith(CREATOR_ID);
    expect(sgSend.mock.calls[0][0]).toBe(CREATOR_EMAIL);
    expect(JSON.stringify(row)).not.toContain(CREATOR_EMAIL);
  });

  it("writes a single tenant row addressed through the agent-email recipients", async () => {
    const res = await notify({
      recipient: { kind: "tenant", tenant_id: TENANT_ID },
      event: "submission_received",
      order_id: ORDER_ID,
      vars: {
        creator_name: "Nia",
        job_title: "3 ad videos",
        deadline_kind: "review",
        deadline_at: DEADLINE,
      },
    });

    expect(res.written).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].recipient_kind).toBe("tenant");
    expect(rows[0].tenant_id).toBe(TENANT_ID);
    expect(rows[0].human_member_id).toBeNull();
    expect(rows[0].link_path).toBe(`/workspace?tab=channels&channel=ugc&drawer=job&job=${ORDER_ID}`);
    expect(resolveAgentEmailRecipients).toHaveBeenCalledWith(TENANT_ID);
    expect(sgSend).toHaveBeenCalledTimes(1);
    expect(sgSend.mock.calls[0][0]).toBe(OWNER_EMAIL);
    expect(readPii).not.toHaveBeenCalled();
  });
});

describe("dedup", () => {
  it("the same event twice on the same order is one row and one email", async () => {
    const input = {
      recipient: { kind: "creator" as const, human_member_id: CREATOR_ID },
      event: "hired" as const,
      order_id: ORDER_ID,
      vars: { business_name: "Acme", job_title: "3 ad videos", payout_cents: 12750 },
    };

    const first = await notify(input);
    const second = await notify(input);

    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(second.reason).toBe("duplicate");
    expect(second.emailed).toBe(false);
    expect(rows).toHaveLength(1);
    expect(sgSend).toHaveBeenCalledTimes(1);
  });

  it("the same reminder fired twice is one send, but 24h and 60h are two", async () => {
    const base = {
      window: "review" as const,
      deadline_at: DEADLINE,
      recipient: { kind: "tenant" as const, tenant_id: TENANT_ID },
      order_id: ORDER_ID,
      vars: { job_title: "3 ad videos" },
    };

    await sendWindowReminder({ ...base, at_hours: 24 });
    const replay = await sendWindowReminder({ ...base, at_hours: 24 });
    await sendWindowReminder({ ...base, at_hours: 60 });

    expect(replay.written).toBe(false);
    expect(replay.reason).toBe("duplicate");
    expect(rows).toHaveLength(2);
    expect(sgSend).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.kind)).toEqual(["reminder_review_24h", "reminder_review_60h"]);
  });

  it("a per-version window sends v1 and v2 once each, and a replay of v2 sends nothing", async () => {
    const input = {
      recipient: { kind: "tenant" as const, tenant_id: TENANT_ID },
      event: "submission_received" as const,
      order_id: ORDER_ID,
      vars: { job_title: "3 ad videos" },
    };
    await notify({ ...input, dedupe_window: "v1" });
    await notify({ ...input, dedupe_window: "v2" });
    const replay = await notify({ ...input, dedupe_window: "v2" });
    expect(replay.reason).toBe("duplicate");
    expect(rows).toHaveLength(2);
    expect(sgSend).toHaveBeenCalledTimes(2);
  });

  it("both-sides notices honour the window too", async () => {
    const args = { event: "cancellation_declined" as const, tenant_id: TENANT_ID, human_member_id: CREATOR_ID, order_id: ORDER_ID };
    await notifyBothSides({ ...args, dedupe_window: "req1" });
    await notifyBothSides({ ...args, dedupe_window: "req2" });
    await notifyBothSides({ ...args, dedupe_window: "req2" });
    expect(rows).toHaveLength(4);
  });

  it("a new review window (a later version) gets its own reminders", async () => {
    const base = {
      window: "review" as const,
      at_hours: 24 as const,
      recipient: { kind: "tenant" as const, tenant_id: TENANT_ID },
      order_id: ORDER_ID,
      vars: { job_title: "3 ad videos" },
    };
    await sendWindowReminder({ ...base, deadline_at: DEADLINE });
    await sendWindowReminder({ ...base, deadline_at: "2026-09-20T18:30:00.000Z" });
    const replay = await sendWindowReminder({ ...base, deadline_at: new Date("2026-09-20T18:30:00.000Z") });
    expect(replay.reason).toBe("duplicate");
    expect(rows).toHaveLength(2);
  });

  it("two different creators on one order are two sends, not a collision", async () => {
    const other = "44444444-0000-4000-8000-000000000004";
    await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "brief_fits_you",
      scope_id: "brief-1",
      vars: { business_name: "Acme", brief_title: "Spring launch" },
    });
    await notify({
      recipient: { kind: "creator", human_member_id: other },
      event: "brief_fits_you",
      scope_id: "brief-1",
      vars: { business_name: "Acme", brief_title: "Spring launch" },
    });
    expect(rows).toHaveLength(2);
    expect(sgSend).toHaveBeenCalledTimes(2);
  });
});

describe("reminder copy (spec item 38: 24h and 60h, each says what happens at 72h)", () => {
  it("states the deadline and the 72h consequence at both 24h and 60h", async () => {
    const expected = deadlineCopy("accept", DEADLINE, { side: "creator" });

    for (const at_hours of [24, 60] as const) {
      rows = [];
      sgSend.mockClear();
      await sendWindowReminder({
        window: "accept",
        at_hours,
        deadline_at: DEADLINE,
        recipient: { kind: "creator", human_member_id: CREATOR_ID },
        order_id: ORDER_ID,
        vars: { job_title: "3 ad videos" },
      });

      const body = String(rows[0].body);
      expect(String(rows[0].title)).toBe("Reminder: a booking is waiting for your answer");
      expect(body).toContain(expected.deadline_text);
      expect(body).toContain(expected.consequence_text);
      expect(body).toContain("If you don't accept by then");
    }
  });

  it("carries the same wording to the reviewing side of the same window shape", async () => {
    await sendWindowReminder({
      window: "review",
      at_hours: 60,
      deadline_at: DEADLINE,
      recipient: { kind: "tenant", tenant_id: TENANT_ID },
      order_id: ORDER_ID,
      vars: { job_title: "3 ad videos" },
    });
    expect(String(rows[0].body)).toContain(deadlineCopy("review", DEADLINE, { side: "business" }).consequence_text);
    expect(String(rows[0].body)).toContain("If you don't approve or ask for changes by then");
  });
});

describe("invariant 5: both sides see the same deadline, each in its own words", () => {
  it("renders the same date on the creator row and the tenant row, second person for each", async () => {
    await notifyBothSides({
      event: "due_date_nudge",
      tenant_id: TENANT_ID,
      human_member_id: CREATOR_ID,
      order_id: ORDER_ID,
      vars: {
        business_name: "Acme",
        creator_name: "Nia Park",
        job_title: "3 ad videos",
        deadline_kind: "due",
        deadline_at: DEADLINE,
      },
    });

    expect(rows).toHaveLength(2);
    const creatorRow = rows.find((r) => r.recipient_kind === "creator")!;
    const tenantRow = rows.find((r) => r.recipient_kind === "tenant")!;

    const a = deadlineLineOf(String(creatorRow.body));
    const b = deadlineLineOf(String(tenantRow.body));
    expect(a).toBe(deadlineCopy("due", DEADLINE, { side: "creator", other_name: "Acme" }).line);
    expect(b).toBe(deadlineCopy("due", DEADLINE, { side: "business", other_name: "Nia" }).line);
    const date = deadlineCopy("due", DEADLINE, { side: "creator" }).deadline_text;
    expect(a).toContain(date);
    expect(b).toContain(date);
    expect(a).toContain("If you don't send a draft");
    expect(b).toContain("If Nia doesn't send a draft");
  });

  it("uses UTC so two recipients in different places read the same clock", () => {
    const copy = deadlineCopy("accept", "2026-09-14T18:30:00.000Z", { side: "business" });
    expect(copy.deadline_text).toBe("14 Sep 2026 at 18:30 UTC");
    expect(copy.deadline_at).toBe("2026-09-14T18:30:00.000Z");
  });

  it("refuses an unreadable deadline instead of rendering Invalid Date", () => {
    expect(() => deadlineCopy("accept", "not-a-date", { side: "creator" })).toThrow(/not a valid date/i);
  });
});

describe("creator contact details never reach a business-visible row", () => {
  it("scrubs an address out of free text a human wrote", async () => {
    await notify({
      recipient: { kind: "tenant", tenant_id: TENANT_ID },
      event: "dispute_opened",
      order_id: ORDER_ID,
      vars: {
        job_title: "3 ad videos",
        note: `The creator says to reach them at ${CREATOR_EMAIL} instead.`,
      },
    });

    const body = String(rows[0].body);
    expect(body).not.toContain(CREATOR_EMAIL);
    expect(body).toContain(CONTACT_REDACTION);
    expect(JSON.stringify(rows)).not.toContain(CREATOR_EMAIL);
    expect(JSON.stringify(sgSend.mock.calls)).not.toContain(CREATOR_EMAIL);
  });

  it("keeps the creator lane free of the business address too", async () => {
    await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "not_hired",
      scope_id: "brief-1",
      vars: {
        business_name: "Acme",
        brief_title: "Spring launch",
        note: `Not this time. Write to ${OWNER_EMAIL} if you want feedback.`,
      },
    });
    expect(String(rows[0].body)).not.toContain(OWNER_EMAIL);
  });
});

describe("mail is best effort, the inbox row is the record", () => {
  it("keeps the row when SendGrid fails", async () => {
    sgSend.mockRejectedValueOnce(new Error("sendgrid down"));
    const res = await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "paid",
      order_id: ORDER_ID,
      vars: { job_title: "3 ad videos", payout_cents: 12750 },
    });
    expect(res.written).toBe(true);
    expect(res.emailed).toBe(false);
    expect(res.reason).toBe("email_failed");
    expect(rows).toHaveLength(1);
    expect(rows[0].emailed_at).toBeUndefined();
  });

  it("still writes the row when the creator has no address on file", async () => {
    readPii.mockResolvedValueOnce({ human_member_id: CREATOR_ID, legal_name: "A", email: "" });
    const res = await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "payout_setup_needed",
      order_id: ORDER_ID,
    });
    expect(res.written).toBe(true);
    expect(res.reason).toBe("no_recipient_email");
    expect(sgSend).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });
});

describe("copy shape", () => {
  it("uses no em dash, en dash or double hyphen anywhere in a rendered row", async () => {
    await notifyBothSides({
      event: "auto_accepted",
      tenant_id: TENANT_ID,
      human_member_id: CREATOR_ID,
      order_id: ORDER_ID,
      vars: { business_name: "Acme", creator_name: "Nia", job_title: "3 ad videos", payout_cents: 12750 },
    });
    for (const r of rows) {
      const text = `${r.title} ${r.body}`;
      expect(text).not.toMatch(/[–—]/);
      expect(text).not.toContain("--");
    }
  });

  it("tells the business the agreed price on auto-accept, never the creator's amount after the 15%", async () => {
    await notify({
      recipient: { kind: "tenant", tenant_id: TENANT_ID },
      event: "auto_accepted",
      order_id: ORDER_ID,
      vars: { business_name: "Acme", creator_name: "Nia", job_title: "3 ad videos", price_cents: 15000, payout_cents: 12750 },
    });
    const text = `${rows[0].title} ${rows[0].body}`;
    expect(text).toContain("Nia's agreed $150.00 is released");
    expect(text).not.toContain("$127.50");
  });

  it("links a creator to the creator area and a business to the UGC hub drawer", async () => {
    await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "tax_forms_ready",
      scope_id: "2026",
      vars: { year: 2026 },
    });
    expect(rows[0].link_path).toBe("/creator/earnings");
    expect(String(rows[0].title)).toBe("Your 2026 tax forms are ready");

    rows = [];
    await notify({
      recipient: { kind: "tenant", tenant_id: TENANT_ID },
      event: "creator_passed",
      order_id: ORDER_ID,
      vars: { creator_name: "Nia", job_title: "3 ad videos" },
    });
    expect(rows[0].link_path).toBe(`/workspace?tab=channels&channel=ugc&drawer=job&job=${ORDER_ID}`);
  });
});

describe("every default link is a page that exists", () => {
  const CREATOR_ROUTES = [/^\/creator$/, /^\/creator\/briefs(\?brief=[^/&]+)?$/, /^\/creator\/jobs\/[^/?]+$/, /^\/creator\/earnings$/];

  it("sends a brief-fits-you creator to the board with that brief open", async () => {
    await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "brief_fits_you",
      scope_id: "brief-1",
      vars: { business_name: "Acme", brief_title: "Spring launch" },
    });
    expect(rows[0].link_path).toBe("/creator/briefs?brief=brief-1");
  });

  it("never links a creator to /creator/inbox or /creator/briefs/:id", async () => {
    const events = ["not_hired", "brief_fits_you", "payout_setup_needed", "hired"] as const;
    for (const event of events) {
      rows = [];
      await notify({
        recipient: { kind: "creator", human_member_id: CREATOR_ID },
        event,
        scope_id: `s-${event}`,
        vars: { business_name: "Acme", brief_title: "Spring launch" },
      });
      const link = String(rows[0].link_path);
      expect(CREATOR_ROUTES.some((re) => re.test(link)), `${event} -> ${link}`).toBe(true);
    }
  });
});

describe("a creator applying to a posted brief", () => {
  it("tells the business nothing is charged until they hire, never booking-hold copy", async () => {
    await notify({
      recipient: { kind: "tenant", tenant_id: TENANT_ID },
      event: "brief_application_received",
      scope_id: "app-1",
      vars: {
        creator_name: "Maya Films",
        brief_title: "Spring menu launch",
        price_cents: 18000,
        business_total_cents: 19800,
        link_path: "/humans/briefs/b1/applicants",
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Maya Films applied to Spring menu launch");
    const body = String(rows[0].body);
    expect(body).toContain("Maya Films applied to Spring menu launch. Nothing is charged until you hire.");
    expect(body).toContain("$198.00");
    expect(body).not.toMatch(/on hold|booking request/i);
    expect(rows[0].kind).toBe("brief_application_received");
  });
});

describe("every default link is a page that exists", () => {
  const CREATOR_ROUTES = [/^\/creator$/, /^\/creator\/briefs(\?brief=[^/&]+)?$/, /^\/creator\/jobs\/[^/?]+$/, /^\/creator\/earnings$/];

  it("sends a brief-fits-you creator to the board with that brief open", async () => {
    await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "brief_fits_you",
      scope_id: "brief-1",
      vars: { business_name: "Acme", brief_title: "Spring launch" },
    });
    expect(rows[0].link_path).toBe("/creator/briefs?brief=brief-1");
  });

  it("never links a creator to /creator/inbox or /creator/briefs/:id", async () => {
    const events = ["not_hired", "brief_fits_you", "payout_setup_needed", "hired"] as const;
    for (const event of events) {
      rows = [];
      await notify({
        recipient: { kind: "creator", human_member_id: CREATOR_ID },
        event,
        scope_id: `s-${event}`,
        vars: { business_name: "Acme", brief_title: "Spring launch" },
      });
      const link = String(rows[0].link_path);
      expect(CREATOR_ROUTES.some((re) => re.test(link)), `${event} -> ${link}`).toBe(true);
    }
  });
});

describe("a creator applying to a posted brief", () => {
  it("tells the business nothing is charged until they hire, never booking-hold copy", async () => {
    await notify({
      recipient: { kind: "tenant", tenant_id: TENANT_ID },
      event: "brief_application_received",
      scope_id: "app-1",
      vars: {
        creator_name: "Maya Films",
        brief_title: "Spring menu launch",
        price_cents: 18000,
        business_total_cents: 19800,
        link_path: "/humans/briefs/b1/applicants",
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Maya Films applied to Spring menu launch");
    const body = String(rows[0].body);
    expect(body).toContain("Maya Films applied to Spring menu launch. Nothing is charged until you hire.");
    expect(body).toContain("$198.00");
    expect(body).not.toMatch(/on hold|booking request/i);
    expect(rows[0].kind).toBe("brief_application_received");
  });
});

describe("notification bodies use the ONE contact-scrub rule, not a weaker copy", () => {
  it("removes a phone number and a messaging link, which the old email-only rule let through", async () => {
    await notify({
      recipient: { kind: "tenant", tenant_id: TENANT_ID },
      event: "dispute_opened",
      order_id: ORDER_ID,
      vars: {
        job_title: "3 ad videos",
        note: "Text me on +1 (415) 555-0199 or ping wa.me/14155550199 instead.",
      },
    });
    const all = JSON.stringify(rows) + JSON.stringify(sgSend.mock.calls);
    expect(all).not.toContain("555-0199");
    expect(all).not.toContain("wa.me");
    expect(String(rows[0].body)).toContain(CONTACT_REDACTION);
  });

  it("leaves Zavi's own money copy alone", async () => {
    const money = [
      ["approved", 12750, "$127.50 is on its way"],
      ["paid", 12750, "$127.50"],
      ["auto_accepted", 15000, "$150.00 is released"],
    ] as const;

    for (const [event, payout_cents, mustContain] of money) {
      rows = [];
      await notify({
        recipient: { kind: "creator", human_member_id: CREATOR_ID },
        event,
        order_id: ORDER_ID,
        vars: { business_name: "Acme", job_title: "3 ad videos", payout_cents },
      });
      const text = `${rows[0].title} ${rows[0].body}`;
      expect(text, event).not.toContain(CONTACT_REDACTION);
      expect(text, event).toContain(mustContain);
    }
  });

  it("says the payout is WAITING when the transfer could not be sent", async () => {
    rows = [];
    await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "approved",
      order_id: ORDER_ID,
      vars: {
        business_name: "Acme",
        job_title: "3 ad videos",
        payout_cents: 12750,
        payout_waiting: true,
      },
    });
    const parked = `${rows[0].title} ${rows[0].body}`;
    expect(parked).toContain("$127.50");
    expect(parked).toContain("waiting");
    expect(parked).not.toContain("on its way");

    rows = [];
    await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "approved",
      order_id: ORDER_ID,
      vars: {
        business_name: "Acme",
        job_title: "3 ad videos",
        payout_cents: 12750,
        payout_waiting: false,
      },
    });
    expect(`${rows[0].title} ${rows[0].body}`).toContain("on its way");
  });

  it("still scrubs a street address, an email, a phone and a link out of a human's note", async () => {
    const cases = [
      ["Come by 1200 Market Street and pick it up.", "Market Street"],
      [`Write to ${CREATOR_EMAIL} instead.`, CREATOR_EMAIL],
      ["Call +1 (415) 555-0199.", "555-0199"],
      ["Ping wa.me/14155550199.", "wa.me"],
    ] as const;

    for (const [note, leaked] of cases) {
      rows = [];
      sgSend.mockClear();
      await notify({
        recipient: { kind: "tenant", tenant_id: TENANT_ID },
        event: "dispute_opened",
        order_id: ORDER_ID,
        vars: { job_title: "3 ad videos", note },
      });
      const all = JSON.stringify(rows) + JSON.stringify(sgSend.mock.calls);
      expect(all, note).not.toContain(leaked);
      expect(String(rows[0].body), note).toContain(CONTACT_REDACTION);
    }
  });

  it("scrubs a contact detail smuggled into a job title, not just a note", async () => {
    await notify({
      recipient: { kind: "tenant", tenant_id: TENANT_ID },
      event: "submission_received",
      order_id: ORDER_ID,
      vars: { creator_name: "Nia", job_title: `3 ad videos (${CREATOR_EMAIL})` },
    });
    const all = JSON.stringify(rows) + JSON.stringify(sgSend.mock.calls);
    expect(all).not.toContain(CREATOR_EMAIL);
  });

  it("notify.ts carries no contact regex of its own", () => {
    const src = readFileSync(join(__dirname, "../notify.ts"), "utf8");
    expect(src).toContain('from "./contact-scrub"');
    expect(src).not.toMatch(/ADDRESS_RE/);
    expect(src).not.toMatch(/\[A-Za-z0-9\._%\+-\]\+@/);
  });
});

describe("a booking request from a business the creator has finished a job for", () => {
  const base = {
    recipient: { kind: "creator", human_member_id: CREATOR_ID } as const,
    event: "booking_request_received" as const,
    order_id: ORDER_ID,
  };

  it("says the business is booking them AGAIN", async () => {
    await notify({
      ...base,
      vars: { business_name: "Acme", job_title: "3 ad videos", payout_cents: 12750, repeat_booking: true },
    });
    const row = rows[0];
    expect(String(row.title)).toBe("Acme wants to book you again");
    expect(String(row.body)).toContain("worked with you before");
    expect(String(row.body)).toContain("$127.50");
    expect(row.link_path).toBe(`/creator/jobs/${ORDER_ID}`);
  });

  it("reads as a new booking when there is no history", async () => {
    await notify({
      ...base,
      vars: { business_name: "Acme", job_title: "3 ad videos", payout_cents: 12750 },
    });
    expect(String(rows[0].title)).toBe("New booking request from Acme");
    expect(String(rows[0].body)).not.toContain("worked with you before");
  });

  it("leaves the BUSINESS leg of the same event alone", async () => {
    await notify({
      recipient: { kind: "tenant", tenant_id: TENANT_ID },
      event: "booking_request_received",
      scope_id: "app-1",
      vars: { business_name: "Acme", job_title: "3 ad videos", repeat_booking: true },
    });
    expect(String(rows[0].title)).toBe("New booking request from Acme");
  });
});

describe("S4: thread activity is one email per recipient per 15 minute window", () => {
  const THREAD = "44444444-0000-4000-8000-000000000004";
  const tenant = { kind: "tenant" as const, tenant_id: TENANT_ID };

  it("a burst of messages in one window is one row and one email; the next window sends again", async () => {
    const { threadDedupeKey } = await import("@/services/creators/notify");
    const t0 = new Date("2026-09-25T10:00:00.000Z");
    const send = (at: Date) =>
      notify({
        recipient: tenant,
        event: "thread_message",
        scope_id: THREAD,
        dedupe_key: threadDedupeKey({ thread_id: THREAD, event: "thread_message", recipient: tenant, now: at }),
        vars: { creator_name: "Nia" },
      });
    const first = await send(t0);
    const second = await send(new Date(t0.getTime() + 5 * 60_000));
    const third = await send(new Date(t0.getTime() + 14 * 60_000));
    expect(first.written).toBe(true);
    expect(second).toMatchObject({ written: false, reason: "duplicate" });
    expect(third).toMatchObject({ written: false, reason: "duplicate" });
    expect(sgSend).toHaveBeenCalledTimes(1);

    const later = await send(new Date(t0.getTime() + 16 * 60_000));
    expect(later.written).toBe(true);
    expect(sgSend).toHaveBeenCalledTimes(2);
    expect(String(rows[0].dedupe_key)).toMatch(new RegExp(`^thread:${THREAD}:thread_message:\\d+:tenant:${TENANT_ID}$`));
  });

  it("an offer is never swallowed by a message sent in the same window", async () => {
    const { threadDedupeKey } = await import("@/services/creators/notify");
    const now = new Date("2026-09-25T10:00:00.000Z");
    for (const event of ["thread_message", "custom_offer_received"] as const) {
      await notify({
        recipient: tenant,
        event,
        scope_id: THREAD,
        dedupe_key: threadDedupeKey({ thread_id: THREAD, event, recipient: tenant, now }),
        vars: { creator_name: "Nia", business_total_cents: 16500 },
      });
    }
    expect(rows.map((r) => r.kind)).toEqual(["thread_message", "custom_offer_received"]);
  });

  it("the two sides are throttled separately", async () => {
    const { threadDedupeKey } = await import("@/services/creators/notify");
    const now = new Date("2026-09-25T10:00:00.000Z");
    const creator = { kind: "creator" as const, human_member_id: CREATOR_ID };
    expect(threadDedupeKey({ thread_id: THREAD, event: "thread_message", recipient: creator, now })).not.toBe(
      threadDedupeKey({ thread_id: THREAD, event: "thread_message", recipient: tenant, now }),
    );
  });
});

describe("thread_message email carries the message", () => {
  const tenant = { kind: "tenant" as const, tenant_id: TENANT_ID };
  const send = (vars: Record<string, unknown>) =>
    notify({ recipient: tenant, event: "thread_message", scope_id: "t-msg", vars });
  const mail = () => {
    const [, subject, html, text] = sgSend.mock.calls[0] as [string, string, string, string];
    return { subject, html, text };
  };

  it("quotes the message, names the job, and puts a snippet in the subject", async () => {
    await send({
      creator_name: "Jemis Lakhani",
      job_title: "Summer launch video",
      message_body: "Hi! I can shoot the unboxing on Friday. Do you want the vertical cut too?",
    });
    const { subject, html, text } = mail();
    expect(subject).toBe("Jemis Lakhani: Hi! I can shoot the unboxing on Friday. Do you want the...");
    expect(html).toContain('class="u-message"');
    expect(html).toContain(">Jemis Lakhani</div>");
    expect(html).toContain("Do you want the vertical cut too?");
    expect(html).toContain("About Summer launch video.");
    expect(text).toContain("> Hi! I can shoot the unboxing on Friday.");
    expect(html).not.toContain("sent you a message");
    expect(html).toContain("Read and reply");
    expect(html).not.toContain("Open the thread");
    expect(html).toContain("Contact details are removed from messages. Keep the conversation on Zavi.");
    expect(html).not.toContain("booking");
  });

  it("escapes the message: a <script> a human typed is text, not markup", async () => {
    await send({ creator_name: "Nia", message_body: `<script>alert("x")</script> hello` });
    const { html } = mail();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; hello");
  });

  it("escapes free text in the hidden preheader (a not_hired note is the intro)", async () => {
    await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "not_hired",
      scope_id: "b-1",
      vars: { business_name: "Acme", note: `We went <img src=x onerror=alert(1)> another way` },
    });
    const { html } = mail();
    const preheader = /<div style="display:none;[^"]*">([^]*?)<\/div>/.exec(html)?.[1] ?? "";
    expect(preheader).toContain("We went &lt;img src=x onerror=alert(1)&gt; another way");
    expect(html).not.toContain("<img src=x");
  });

  it("trims the preview to about 200 characters on a word boundary", async () => {
    const long = `${"word ".repeat(80)}END`;
    await send({ creator_name: "Nia", message_body: long });
    const { html } = mail();
    const quoted = /class="u-message"[^>]*>([^<]*)<\/div>/.exec(html)?.[1] ?? "";
    expect(quoted.endsWith("word...")).toBe(true);
    expect(quoted.length).toBeLessThanOrEqual(203);
    expect(quoted).not.toContain("END");
  });

  it("strips contact details from the preview like the thread does", async () => {
    await send({ creator_name: "Nia", message_body: "email me at jane.doe@example.com" });
    const { subject, html } = mail();
    expect(html).not.toContain("jane.doe@example.com");
    expect(subject).not.toContain("jane.doe@example.com");
    expect(html).toContain(CONTACT_REDACTION);
  });

  it("falls back to a plain subject and no job line when neither is known", async () => {
    await send({ creator_name: "Nia" });
    const { subject, html } = mail();
    expect(subject).toBe("New message from Nia");
    expect(html).not.toContain("About ");
    expect(html).not.toContain('class="u-message"');
  });

  it("the default footer for every other event no longer says booking", async () => {
    await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "creator_passed",
      order_id: ORDER_ID,
      vars: { creator_name: "Nia", job_title: "3 ad videos" },
    });
    const { html } = mail();
    expect(html).toContain("You get this email because you use the Zavi creator network.");
    expect(html).not.toContain("a job or a booking");
  });
});

describe("S4: offer copy", () => {
  it("custom_offer_received tells the business accepting charges at once", async () => {
    await notify({
      recipient: { kind: "tenant", tenant_id: TENANT_ID },
      event: "custom_offer_received",
      scope_id: "t1",
      vars: { creator_name: "Nia", job_title: "Unboxing", business_total_cents: 16500 },
    });
    const body = String(rows[0].body);
    expect(body).toContain("$165.00");
    expect(body).toContain("your card is charged and the job starts straight away");
    expect(body).not.toContain("charged only when the creator accepts");
  });

  it("custom_offer_accepted sends the email button to Stripe Checkout, the inbox row to the job", async () => {
    await notify({
      recipient: { kind: "tenant", tenant_id: TENANT_ID },
      event: "custom_offer_accepted",
      order_id: ORDER_ID,
      email_cta_url: "https://checkout.stripe.com/c/pay/cs_test_1",
      vars: {
        creator_name: "Nia",
        job_title: "Unboxing",
        business_total_cents: 16500,
        link_path: `/humans/jobs/${ORDER_ID}`,
      },
    });
    expect(rows[0].link_path).toBe(`/humans/jobs/${ORDER_ID}`);
    expect(String(sgSend.mock.calls[0][2])).toContain("https://checkout.stripe.com/c/pay/cs_test_1");
    expect(String(rows[0].title)).toBe("Nia accepted your custom offer");
  });

  it("an email button can never point anywhere but Stripe Checkout", async () => {
    const { safeEmailCtaUrl } = await import("@/services/creators/notify");
    expect(safeEmailCtaUrl("https://evil.example/phish")).toBeNull();
    expect(safeEmailCtaUrl("http://checkout.stripe.com/x")).toBeNull();
    expect(safeEmailCtaUrl("javascript:alert(1)")).toBeNull();
    expect(safeEmailCtaUrl("https://checkout.stripe.com/c/pay/cs_1")).toBe("https://checkout.stripe.com/c/pay/cs_1");
  });

  it("hired reads as a started custom offer for an offer order", async () => {
    await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "hired",
      order_id: ORDER_ID,
      vars: { business_name: "Acme", job_title: "Unboxing", order_source: "offer", price_cents: 15000, payout_cents: 12750 },
    });
    expect(String(rows[0].title)).toBe("Acme started your custom offer");
    expect(String(rows[0].body)).not.toContain("picked you from");
  });
});

describe("creator_live: the You're live email (wireframe D1)", () => {
  const live = (country_missing: boolean) =>
    notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "creator_live",
      scope_id: CREATOR_ID,
      vars: { country_missing },
    });

  it("goes to the creator once, however many times setup finishes", async () => {
    const first = await live(true);
    const second = await live(true);
    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(rows).toHaveLength(1);
    expect(sgSend).toHaveBeenCalledTimes(1);
    expect(sgSend.mock.calls[0][0]).toBe(CREATOR_EMAIL);
    expect(rows[0].human_member_id).toBe(CREATOR_ID);
    expect(rows[0].title).toBe("You're live on Zavi");
    expect(rows[0].link_path).toBe("/creator");
    expect(String(rows[0].body)).toContain("Add your country and businesses can book you.");
  });

  it("drops the country line when the creator already has one", async () => {
    await live(false);
    expect(String(rows[0].body)).toContain("Your first package is saved.");
    expect(String(rows[0].body)).not.toContain("country");
  });
});

describe("creator_live for an affiliate-only creator", () => {
  it("is the link email: the link, the disclosure line, and the affiliate page", async () => {
    await notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "creator_live",
      scope_id: CREATOR_ID,
      vars: { affiliate_only: true, affiliate_link: "https://www.zaviagent.com/?via=k7m4p2qa", link_path: "/creator/affiliate" },
    });
    expect(rows[0].title).toBe("Your affiliate link is ready");
    expect(rows[0].link_path).toBe("/creator/affiliate");
    expect(String(rows[0].body)).toContain("https://www.zaviagent.com/?via=k7m4p2qa");
    expect(String(rows[0].body)).toContain("Say you are a Zavi affiliate when you share your link.");
    expect(String(rows[0].body)).not.toContain("package");
  });
});

describe("country_needed: the day-after country email (wireframe D3)", () => {
  const send = () =>
    notify({ recipient: { kind: "creator", human_member_id: CREATOR_ID }, event: "country_needed", scope_id: CREATOR_ID });

  it("goes to the creator once, with the wireframe copy", async () => {
    expect((await send()).written).toBe(true);
    expect((await send()).written).toBe(false);
    expect(rows).toHaveLength(1);
    expect(sgSend).toHaveBeenCalledTimes(1);
    expect(sgSend.mock.calls[0][0]).toBe(CREATOR_EMAIL);
    expect(rows[0].title).toBe("Add your country so businesses can book you");
    expect(rows[0].link_path).toBe("/creator");
    expect(String(rows[0].body)).toContain("Until you add it, you don't show up in Find creators.");
    expect(String(rows[0].body)).toContain("the US, Canada, the UK, the EEA and Switzerland");
  });
});

describe("grace_nudge: the late-delivery email", () => {
  const nudge = (window: string) =>
    notify({
      recipient: { kind: "creator", human_member_id: CREATOR_ID },
      event: "grace_nudge",
      order_id: ORDER_ID,
      vars: { business_name: "Acme", job_title: "Unboxing", deadline_kind: "no_show_grace", deadline_at: DEADLINE },
      dedupe_window: window,
    });

  it("tells the creator the draft is late, with the grace deadline, once per grace", async () => {
    await nudge("grace:1");
    await nudge("grace:1");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Unboxing is past its delivery date");
    expect(rows[0].link_path).toBe(`/creator/jobs/${ORDER_ID}`);
    expect(String(rows[0].body)).toContain("Your draft for Acme has not arrived yet.");
    expect(deadlineLineOf(String(rows[0].body))).toBe(deadlineCopy("no_show_grace", DEADLINE, { side: "creator", other_name: "Acme" }).line);
  });

  it("a later grace (after an extension) is its own send", async () => {
    await nudge("grace:1");
    await nudge("grace:2");
    expect(rows).toHaveLength(2);
  });
});

describe("an extension request reads as one, not as a due-date reminder", () => {
  const vars = {
    business_name: "UpcarAI",
    creator_name: "Mohit Dudhat",
    job_title: "3 * Post",
    extension_from: "2026-10-25T05:16:26Z",
    extension_to: "2026-10-27T05:16:26Z",
  };

  it("tells the business the creator asked for more time, from which date to which", async () => {
    await notify({ recipient: { kind: "tenant", tenant_id: TENANT_ID }, event: "due_date_nudge", order_id: ORDER_ID, vars: { ...vars, extension: "requested" } });
    expect(String(rows[0].title)).toBe("Mohit Dudhat asked for more time on 3 * Post");
    expect(String(rows[0].body)).toContain("asked to move the due date from Oct 25 to Oct 27");
    expect(String(rows[0].body)).toContain("Until you answer, the due date stays Oct 25");
  });

  it("tells the creator when the business approved or declined", async () => {
    await notify({ recipient: { kind: "creator", human_member_id: CREATOR_ID }, event: "due_date_nudge", order_id: ORDER_ID, vars: { ...vars, extension: "approved" } });
    expect(String(rows[0].title)).toBe("UpcarAI gave you more time on 3 * Post");
    expect(String(rows[0].body)).toContain("Your draft is now due Oct 27");
    rows = [];
    await notify({ recipient: { kind: "creator", human_member_id: CREATOR_ID }, event: "due_date_nudge", order_id: `${ORDER_ID}-x`, vars: { ...vars, extension: "declined" } });
    expect(String(rows[0].title)).toBe("UpcarAI kept the original due date for 3 * Post");
    expect(String(rows[0].body)).toContain("Your draft is still due Oct 25");
  });

  it("an ordinary due date still reads as the reminder it is", async () => {
    await notify({ recipient: { kind: "tenant", tenant_id: TENANT_ID }, event: "due_date_nudge", order_id: ORDER_ID, vars: { ...vars, extension: null } });
    expect(String(rows[0].title)).toBe("Delivery is due for 3 * Post");
  });
});
