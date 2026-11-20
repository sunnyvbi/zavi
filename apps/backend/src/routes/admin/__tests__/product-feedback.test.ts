
import { describe, it, expect, vi, beforeEach } from "vitest";

const { s } = vi.hoisted(() => ({
  s: {
    auditFails: false,
    audits: [] as Array<Record<string, unknown>>,
    feedbackRows: [] as Array<Record<string, unknown>>,
    member: true,
    userEmail: "maya@example.com" as string | null,
    updates: [] as Array<Record<string, unknown>>,
    emails: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("@/services/auth/staff-middleware", () => ({
  assertStaff: () => ({ user_id: "staff-1", email: "ravi@zaviagent.com" }),
}));
vi.mock("@/services/staff/audit", () => ({
  writeStaffAuditStrict: vi.fn(async (a: Record<string, unknown>) => {
    if (s.auditFails) throw new Error("audit down");
    s.audits.push(a);
  }),
}));
vi.mock("@/email/sendFeedbackClosedEmail", () => ({
  sendFeedbackClosedEmail: vi.fn(async (a: Record<string, unknown>) => {
    s.emails.push(a);
  }),
}));

const selected: string[] = [];

function builder(table: string) {
  const filters: Record<string, unknown> = {};
  let patch: Record<string, unknown> | null = null;
  const q: Record<string, unknown> = {};
  Object.assign(q, {
    select: (cols: string) => {
      selected.push(`${table}:${cols}`);
      return q;
    },
    eq: (c: string, v: unknown) => {
      filters[c] = v;
      return q;
    },
    in: async (col: string) => {
      selected.push(col);
      return { data: [{ id: "t-1", display_name: "Brightside Bakery" }], error: null };
    },
    order: () => q,
    limit: async () => ({ data: s.feedbackRows, error: null }),
    update: (p: Record<string, unknown>) => {
      patch = p;
      q.then = (resolve: (v: unknown) => void) => {
        s.updates.push({ ...patch, ...filters });
        resolve({ error: null });
      };
      return q;
    },
    maybeSingle: async () => {
      if (table === "tenant_users") return { data: s.member ? { user_id: filters.user_id } : null, error: null };
      if (table === "tenant_feedback") return { data: s.feedbackRows.find((r) => r.id === filters.id) ?? null, error: null };
      return { data: null, error: null };
    },
  });
  return q;
}

vi.mock("@/services/tenant-client", () => ({
  staffCrossTenantClient: () => ({
    from: (t: string) => builder(t),
    auth: {
      admin: {
        getUserById: async () => ({ data: { user: s.userEmail ? { email: s.userEmail } : null }, error: null }),
      },
    },
  }),
}));

import { staffProductFeedbackList, staffProductFeedbackUpdate } from "../product-feedback";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function makeRes() {
  return {
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
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const patch = async (body: unknown, id = ID) => {
  const res = makeRes();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await staffProductFeedbackUpdate({ params: { id }, body } as any, res as any);
  return res;
};

beforeEach(() => {
  s.auditFails = false;
  s.audits = [];
  s.member = true;
  s.userEmail = "maya@example.com";
  s.updates = [];
  s.emails = [];
  s.feedbackRows = [
    { id: ID, tenant_id: "t-1", created_by: "u-1", body: "Fix the caption preview", attachments: ["x"], source: "settings", created_at: "2026-10-20T00:00:00Z", status: "received", staff_note: null, status_updated_at: null },
  ];
});

describe("GET /api/admin/product-feedback", () => {
  it("hides the text when the audit row cannot be written", async () => {
    s.auditFails = true;
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await staffProductFeedbackList({} as any, res as any);
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain("caption");
  });

  it("names the sender while they are still in the company", async () => {
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await staffProductFeedbackList({} as any, res as any);
    const row = (res.body as { feedback: Array<Record<string, unknown>> }).feedback[0];
    expect(row).toMatchObject({ company: "Brightside Bakery", sender: "maya@example.com", attachment_count: 1, status: "received" });
    expect(s.audits[0]).toMatchObject({ action: "staff.product_feedback.list" });
    expect(selected).toContain("tenants:id, display_name");
  });

  it("shows (user removed) once the sender left the company", async () => {
    s.member = false;
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await staffProductFeedbackList({} as any, res as any);
    expect((res.body as { feedback: Array<Record<string, unknown>> }).feedback[0].sender).toBe("(user removed)");
  });
});

describe("PATCH /api/admin/product-feedback/:id", () => {
  it("emails the sender when a request moves to Done, with the note", async () => {
    const res = await patch({ status: "done", staff_note: "Fixed. Previews show the full caption." });
    expect(res.body).toMatchObject({ ok: true, changed: true, emailed: true });
    expect(s.emails).toEqual([{ to: "maya@example.com", status: "done", body: "Fix the caption preview", note: "Fixed. Previews show the full caption." }]);
    expect(s.updates[0]).toMatchObject({ status: "done", staff_note: "Fixed. Previews show the full caption.", id: ID, tenant_id: "t-1" });
  });

  it("does not email on Working on it", async () => {
    const res = await patch({ status: "working", staff_note: "On it." });
    expect(res.body).toMatchObject({ changed: true, emailed: false });
    expect(s.emails).toEqual([]);
  });

  it("does not email again when only the note changes on a closed request", async () => {
    s.feedbackRows[0].status = "done";
    const res = await patch({ status: "done", staff_note: "Now also on mobile." });
    expect(res.body).toMatchObject({ changed: true, emailed: false });
  });

  it("does not email a sender who left the company", async () => {
    s.member = false;
    const res = await patch({ status: "wont_do" });
    expect(res.body).toMatchObject({ changed: true, emailed: false });
    expect(s.emails).toEqual([]);
  });

  it("saves nothing when the audit row cannot be written", async () => {
    s.auditFails = true;
    const res = await patch({ status: "done" });
    expect(res.statusCode).toBe(503);
    expect(s.updates).toEqual([]);
    expect(s.emails).toEqual([]);
  });

  it("is a no-op when nothing changed", async () => {
    const res = await patch({ status: "received", staff_note: "  " });
    expect(res.body).toMatchObject({ changed: false });
    expect(s.audits).toEqual([]);
  });

  it("rejects an unknown status and a bad id", async () => {
    expect((await patch({ status: "closed" })).statusCode).toBe(400);
    expect((await patch({ status: "done" }, "not-a-uuid")).statusCode).toBe(404);
  });
});
