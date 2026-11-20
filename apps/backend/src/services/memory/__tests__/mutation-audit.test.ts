
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  snapshotRow: {
    slug: null as string | null,
    title: "Customer email for John Doe",
    body_markdown: "john.doe@example.com — SSN 123-45-6789, very much PII",
    source: "auto_distill",
    note_type: "tenant_reference",
    trust_tier: 2,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-02T00:00:00Z",
  } as Record<string, unknown> | null,
  deleteResult: { data: [{ id: "note-1" }], error: null } as { data: unknown; error: unknown },
  insertError: null as unknown,
  auditInserts: [] as Array<Record<string, unknown>>,
  eqCalls: [] as Array<[string, unknown]>,
}));

function makeClient() {
  return {
    from(table: string) {
      const state = { didDelete: false, didInsert: false };
      const b: Record<string, unknown> = {};
      const chain = () => b;
      b.select = vi.fn(chain);
      b.eq = vi.fn((col: string, val: unknown) => {
        h.eqCalls.push([col, val]);
        return b;
      });
      b.is = vi.fn(chain);
      b.order = vi.fn(chain);
      b.limit = vi.fn(chain);
      b.delete = vi.fn(() => {
        state.didDelete = true;
        return b;
      });
      b.insert = vi.fn((payload: Record<string, unknown>) => {
        state.didInsert = true;
        if (table === "memory_mutation_audit") h.auditInserts.push(payload);
        return b;
      });
      b.maybeSingle = vi.fn(async () => ({ data: h.snapshotRow }));
      (b as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
        if (state.didInsert) return resolve({ error: h.insertError });
        if (state.didDelete) return resolve(h.deleteResult);
        return resolve({ data: [], error: null });
      };
      return b;
    },
  };
}

vi.mock("@/services/supabase", () => ({ serviceClient: () => makeClient() }));

import {
  buildDeleteSnapshot,
  buildEditSnapshot,
  buildRetireSnapshot,
  writeMutationAudit,
  titleHash,
} from "../mutation-audit";
import { deleteNote } from "../index";

beforeEach(() => {
  h.auditInserts.length = 0;
  h.eqCalls.length = 0;
  h.insertError = null;
  h.deleteResult = { data: [{ id: "note-1" }], error: null };
  h.snapshotRow = {
    slug: null,
    title: "Customer email for John Doe",
    body_markdown: "john.doe@example.com — SSN 123-45-6789, very much PII",
    source: "auto_distill",
    note_type: "tenant_reference",
    trust_tier: 2,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-02T00:00:00Z",
  };
});

describe("redaction builders", () => {
  const note = {
    id: "note-1",
    title: "Customer email for John Doe",
    body_markdown: "john.doe@example.com — SSN 123-45-6789",
    source: "auto_distill",
    note_type: "tenant_reference",
    trust_tier: 2,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-02T00:00:00Z",
  };

  it("buildDeleteSnapshot omits raw body AND readable title (RTBF)", () => {
    const snap = buildDeleteSnapshot(note);
    const json = JSON.stringify(snap);
    expect(json).not.toContain("john.doe@example.com");
    expect(json).not.toContain("123-45-6789");
    expect(json).not.toContain("John Doe");
    expect(snap.body_markdown).toBeUndefined();
    expect(snap.title).toBeUndefined();
    expect(snap.title_sha256).toBe(titleHash(note.title));
    expect(snap.source).toBe("auto_distill");
    expect(snap.trust_tier).toBe(2);
    expect(snap.created_at).toBe("2026-06-01T00:00:00Z");
    expect(snap.redaction).toBe("rtbf_delete");
  });

  it("buildEditSnapshot keeps a BOUNDED body (edit is not a forget)", () => {
    const big = { ...note, body_markdown: "x".repeat(10_000) };
    const snap = buildEditSnapshot(big);
    expect((snap.body_markdown as string).length).toBe(4000);
    expect(snap.title).toBe(note.title);
    expect(snap.redaction).toBe("bounded_edit");
  });

  it("buildRetireSnapshot is a redacted ref with agent provenance (no body)", () => {
    const snap = buildRetireSnapshot(note, "support-lead");
    expect(snap.body_markdown).toBeUndefined();
    expect(snap.title).toBeUndefined();
    expect(snap.title_sha256).toBe(titleHash(note.title));
    expect(snap.agent_slug).toBe("support-lead");
  });
});

describe("writeMutationAudit best-effort", () => {
  it("inserts a row with the given shape", async () => {
    await writeMutationAudit({
      tenant_id: "t1",
      note_id: "note-1",
      action: "delete",
      actor_user_id: "u-actor",
      reason: "gdpr request",
      before_snapshot: { redaction: "rtbf_delete", note_id: "note-1" },
    });
    expect(h.auditInserts).toHaveLength(1);
    expect(h.auditInserts[0]).toMatchObject({
      tenant_id: "t1",
      note_id: "note-1",
      action: "delete",
      actor_user_id: "u-actor",
      reason: "gdpr request",
    });
  });

  it("does NOT throw when the insert returns an error value", async () => {
    h.insertError = { message: "boom" };
    await expect(
      writeMutationAudit({
        tenant_id: "t1",
        note_id: "note-1",
        action: "edit",
        before_snapshot: {},
      }),
    ).resolves.toBeUndefined();
  });
});

describe("deleteNote writes a redacted audit row", () => {
  it("delete writes action=delete with a REDACTED snapshot + THREADED actor", async () => {
    await deleteNote("tenant-A", "note-1", "user-authed-123", "right to be forgotten");

    expect(h.auditInserts).toHaveLength(1);
    const row = h.auditInserts[0];
    expect(row.action).toBe("delete");
    expect(row.tenant_id).toBe("tenant-A");
    expect(row.actor_user_id).toBe("user-authed-123");
    expect(row.reason).toBe("right to be forgotten");

    const snapJson = JSON.stringify(row.before_snapshot);
    expect(snapJson).not.toContain("john.doe@example.com");
    expect(snapJson).not.toContain("123-45-6789");
    expect((row.before_snapshot as Record<string, unknown>).body_markdown).toBeUndefined();

    expect(h.eqCalls).toContainEqual(["tenant_id", "tenant-A"]);
  });

  it("audit-write FAILURE does not break the delete", async () => {
    h.insertError = { message: "audit table unavailable" };
    await expect(deleteNote("tenant-A", "note-1", "user-1")).resolves.toBeUndefined();
  });

  it("no audit row when nothing was deleted (404 path)", async () => {
    h.snapshotRow = null;
    h.deleteResult = { data: [], error: null };
    await expect(deleteNote("tenant-A", "missing", "user-1")).rejects.toThrow();
    expect(h.auditInserts).toHaveLength(0);
  });
});
