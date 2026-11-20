
import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const RUN = "11111111-1111-4111-1111-111111111111";
const ART = "44444444-4444-4444-8444-444444444444";
const ART2 = "66666666-6666-4666-8666-666666666666";
const PATH = `${TENANT_A}/${RUN}/ui-block-1.json`;

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  blobs: new Map<string, string>(),
  created: [] as Array<{ title: string; html: string; run_id: string; tenant_id: string }>,
  failTable: null as string | null,
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/services/supabase", () => ({ serviceClient: vi.fn() }));
vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn(async () => true) }));
vi.mock("@/services/shared-pages/page", async () => {
  const actual = await vi.importActual<typeof import("@/services/shared-pages/page")>("@/services/shared-pages/page");
  return {
    ...actual,
    createSharedPage: vi.fn(async (o: { title: string; html: string; run_id: string; tenant_id: string }) => {
      mocks.created.push(o);
      const id = `55555555-5555-4555-8555-55555555555${mocks.created.length}`;
      const row = { id, run_id: o.run_id, title: o.title, status: "private", slug: null, expires_at: null, created_at: "2026-09-25T00:00:00Z", tenant_id: o.tenant_id, storage_path: `${o.tenant_id}/${id}.html` };
      mocks.blobs.set(row.storage_path, o.html);
      (mocks.tables.shared_pages ??= []).push(row);
      return row;
    }),
  };
});

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: (tid: string) => ({
    from: (table: string) => {
      const filters = new Map<string, unknown>([["tenant_id", tid]]);
      const rows = () =>
        (mocks.tables[table] ?? []).filter((r) =>
          [...filters].every(([k, v]) => (k === "__contains" ? (v as (r: Record<string, unknown>) => boolean)(r) : r[k] === v)),
        );
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (k: string, v: unknown) => (filters.set(k, v), chain),
        contains: (k: string, v: Record<string, unknown[]>) => {
          const [ck, cv] = Object.entries(v)[0];
          filters.set(`__contains`, (r: Record<string, unknown>) =>
            Array.isArray((r[k] as Record<string, unknown> | undefined)?.[ck]) &&
            cv.every((x) => ((r[k] as Record<string, unknown[]>)[ck] as unknown[]).includes(x)),
          );
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () =>
          mocks.failTable === table ? { data: null, error: { message: "db down" } } : { data: rows()[0] ?? null, error: null },
        then: (ok: (v: unknown) => unknown) => ok({ data: rows(), error: null }),
      };
      return chain;
    },
  }),
  tenantStorage: () => ({
    from: () => ({
      download: async (p: string) =>
        mocks.blobs.has(p) ? { data: { text: async () => mocks.blobs.get(p)! }, error: null } : { data: null, error: { message: "missing" } },
    }),
  }),
}));

import { shareReport } from "../shared-pages";
import { reportMarker } from "@/services/shared-pages/report-page";

function res() {
  const r = { statusCode: 0, body: undefined as unknown, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; }, setHeader() {} };
  return r;
}

const BLOCK = { kind: "table", title: "Sign-ups, Booked and Rate by month", columns: ["Month", "Sign-ups", "Booked"], rows: [["July", "1,587", "180"], ["August", "2,497", "166"]] };
const REPLY = "August sign-ups <b>doubled</b>.\n\n---\n**Sources.** All 4 numbers came straight from data pulled in this run.\n\n1. Your database: a query returned 1,587, 180, 2,497, 166";

beforeEach(() => {
  mocks.tables = {
    run_artifacts: [
      { id: ART, tenant_id: TENANT_A, run_id: RUN, bucket: "agent-artifacts", storage_path: PATH, mime: "application/vnd.zavi.ui+json", created_at: "2026-09-25T00:00:00Z" },
      { id: ART2, tenant_id: TENANT_A, run_id: RUN, bucket: "agent-artifacts", storage_path: PATH, mime: "application/vnd.zavi.ui+json", created_at: "2026-09-25T00:00:00Z" },
    ],
    agent_thread_messages: [{ tenant_id: TENANT_A, agent_run_id: RUN, sender_role: "assistant", body: REPLY, created_at: "2026-09-25T00:00:00Z" }],
    shared_pages: [],
  };
  mocks.blobs = new Map([[PATH, JSON.stringify(BLOCK)]]);
  mocks.created = [];
  mocks.failTable = null;
  mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, user_id: "u" });
});

describe("POST /api/workspace/reports/share", () => {
  it("saves the report as a private page built from the tenant's own rows", async () => {
    const r = res();
    await shareReport({ body: { artifact_id: ART } } as never, r as never);
    expect(r.statusCode).toBe(200);
    expect((r.body as { page: { visibility: string } }).page.visibility).toBe("private");
    const [made] = mocks.created;
    expect(made).toMatchObject({ run_id: RUN, tenant_id: TENANT_A, title: "Sign-ups, Booked and Rate by month" });
    expect(made.html).toContain("1,587");
    expect(made.html).toContain("Where these numbers came from");
    expect(made.html).toContain("&lt;b&gt;doubled&lt;/b&gt;");
    expect(made.html).not.toContain("<script");
  });

  it("returns the same page on a second ask", async () => {
    await shareReport({ body: { artifact_id: ART } } as never, res() as never);
    const r = res();
    await shareReport({ body: { artifact_id: ART } } as never, r as never);
    expect(r.statusCode).toBe(200);
    expect(mocks.created).toHaveLength(1);
  });

  it("cannot reach another tenant's card", async () => {
    mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_B, user_id: "u" });
    const r = res();
    await shareReport({ body: { artifact_id: ART } } as never, r as never);
    expect(r.statusCode).toBe(404);
    expect(mocks.created).toHaveLength(0);
  });

  it("refuses anything but a uuid, and a card that is not a data card", async () => {
    const bad = res();
    await shareReport({ body: { artifact_id: "../x" } } as never, bad as never);
    expect(bad.statusCode).toBe(400);
    mocks.tables.run_artifacts[0].mime = "application/pdf";
    const pdf = res();
    await shareReport({ body: { artifact_id: ART } } as never, pdf as never);
    expect(pdf.statusCode).toBe(404);
  });

  it("does not hand a second card of the same answer the first card's page", async () => {
    await shareReport({ body: { artifact_id: ART } } as never, res() as never);
    await shareReport({ body: { artifact_id: ART2 } } as never, res() as never);
    expect(mocks.created).toHaveLength(2);
    expect(mocks.created[1].html).toContain(reportMarker(ART2));
    expect(mocks.created[1].html).not.toContain(ART2);
  });

  it("refuses a card stored outside the tenant's path or an unknown bucket", async () => {
    mocks.tables.run_artifacts[0].storage_path = `${TENANT_B}/${RUN}/ui-block-1.json`;
    const r = res();
    await shareReport({ body: { artifact_id: ART } } as never, r as never);
    expect(r.statusCode).toBe(404);
  });

  it("does not save a page when the reply cannot be read", async () => {
    mocks.failTable = "agent_thread_messages";
    const r = res();
    await shareReport({ body: { artifact_id: ART } } as never, r as never);
    expect(r.statusCode).toBe(500);
    expect(mocks.created).toHaveLength(0);
  });

  it("uses the full reply of an over-cap answer", async () => {
    mocks.tables.agent_thread_messages[0].body = "Short lead";
    mocks.tables.agent_thread_messages[0].meta = { overflow_scrubbed: true, full_reply_markdown: `Short lead and the long tail.\n\n${REPLY.split("\n\n---")[1] ? "---" + REPLY.split("\n\n---")[1] : ""}` };
    await shareReport({ body: { artifact_id: ART } } as never, res() as never);
    expect(mocks.created[0].html).toContain("the long tail");
    expect(mocks.created[0].html).toContain("Where these numbers came from");
  });

  it("finds a handoff reply that lists the run in child_run_ids", async () => {
    mocks.tables.agent_thread_messages = [
      { tenant_id: TENANT_A, agent_run_id: "99999999-9999-4999-8999-999999999999", sender_role: "assistant", body: "Combined answer from the specialists.", created_at: "2026-09-25T00:00:00Z", meta: { child_run_ids: [RUN] } },
    ];
    const r = res();
    await shareReport({ body: { artifact_id: ART } } as never, r as never);
    expect(r.statusCode).toBe(200);
    expect(mocks.created[0].html).toContain("Combined answer from the specialists.");
  });

  it("refuses when no reply can be found, instead of saving an empty page", async () => {
    mocks.tables.agent_thread_messages = [];
    const r = res();
    await shareReport({ body: { artifact_id: ART } } as never, r as never);
    expect(r.statusCode).toBe(422);
    expect(mocks.created).toHaveLength(0);
  });
});
