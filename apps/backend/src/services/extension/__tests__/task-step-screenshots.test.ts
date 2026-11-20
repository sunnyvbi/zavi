import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
const ledger: Row[] = [];
const removed: string[][] = [];
const artifacts: Row[] = [];
const runs: Row[] = [];
const state = { consent: true, countError: false, insertError: false, artifactError: false };

const consentAnswers: boolean[] = [];
vi.mock("@/services/extension/consent", () => ({
  hasCurrentExtensionConsent: vi.fn(async () => (consentAnswers.length ? consentAnswers.shift()! : state.consent)),
}));
vi.mock("@/services/chat-images/store-chat-image", () => ({
  CHAT_IMAGE_BUCKET: "agent-chat-images",
  normalizeChatImage: vi.fn(async (b: Buffer) => ({ ok: true, jpeg: b })),
  storeNormalizedChatImage: vi.fn(async (t: string, _jpeg: Buffer, folder?: string) => ({
    ok: true,
    image_path: `${t}/${folder}/img-${ledger.length + 1}.jpg`,
  })),
}));
const storageRemoveError = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/services/tenant-client", () => ({
  asTenantId: (s: string) => s,
  tenantStorage: () => ({
    from: () => ({
      remove: async (paths: string[]) => {
        removed.push(paths);
        return { error: storageRemoveError.value };
      },
    }),
  }),
  tenantClient: (tid: string) => ({
    from: (table: string) => {
      if (table === "agent_runs") {
        const where: [string, unknown][] = [];
        const q: any = {
          select: () => q,
          eq: (c: string, v: unknown) => (where.push([c, v]), q),
          maybeSingle: async () => ({
            data: runs.find((r) => r.tenant_id === tid && where.every(([c, v]) => r[c] === v)) ?? null,
            error: null,
          }),
        };
        return q;
      }
      if (table === "run_artifacts") {
        return {
          insert: async (row: Row) => {
            if (state.artifactError) return { error: { message: "art" } };
            artifacts.push({ tenant_id: tid, ...row });
            return { error: null };
          },
          delete: () => {
            const where: [string, unknown][] = [["tenant_id", tid]];
            const d: any = {
              eq: (c: string, v: unknown) => (where.push([c, v]), d),
              then: (res: (v: unknown) => unknown) => {
                for (let i = artifacts.length - 1; i >= 0; i -= 1) {
                  if (where.every(([c, v]) => artifacts[i][c] === v)) artifacts.splice(i, 1);
                }
                return res({ error: null });
              },
            };
            return d;
          },
        };
      }
      if (table !== "extension_screenshots") throw new Error(`unexpected table ${table}`);
      const eqs: [string, unknown][] = [];
      const chain: any = {
        select: () => chain,
        eq: (c: string, v: unknown) => (eqs.push([c, v]), chain),
        then: (res: (v: unknown) => unknown) =>
          res(
            state.countError
              ? { count: null, error: { message: "down" } }
              : {
                  count: ledger.filter(
                    (r) => r.tenant_id === tid && eqs.every(([c, v]) => r[c] === v),
                  ).length,
                  error: null,
                },
          ),
        update: (patch: Row) => {
          const where: [string, unknown][] = [];
          const u: any = {
            eq: (c: string, v: unknown) => (where.push([c, v]), u),
            then: (res: (v: unknown) => unknown) => {
              for (const r of ledger) if (r.tenant_id === tid && where.every(([c, v]) => r[c] === v)) Object.assign(r, patch);
              return res({ error: null });
            },
          };
          return u;
        },
        insert: async (row: Row) => {
          if (state.insertError) return { error: { message: "ins" } };
          ledger.push({ tenant_id: tid, ...row });
          return { error: null };
        },
      };
      return chain;
    },
  }),
}));

import {
  MAX_TASK_STEP_SCREENSHOTS,
  saveTaskStepScreenshot,
  taskStepArtifactFilename,
} from "@/services/extension/task-step-screenshots";

const img = Buffer.from([255, 216, 255]);
const save = (run_id = "run-1", user_id = "u1", tenant_id = "t1") =>
  saveTaskStepScreenshot({ tenant_id, user_id, run_id, image: img });

beforeEach(() => {
  ledger.length = 0;
  removed.length = 0;
  artifacts.length = 0;
  runs.length = 0;
  runs.push(
    { tenant_id: "t1", id: "run-1", agent_slug: "operator", payload: { thread_id: "0b8f3a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b" } },
    { tenant_id: "t1", id: "run-2", agent_slug: "operator", payload: {} },
  );
  consentAnswers.length = 0;
  Object.assign(state, { consent: true, countError: false, insertError: false, artifactError: false });
});

describe("saveTaskStepScreenshot", () => {
  it("stores the row as kind task_step with the run, owned by the user (so revoke erases it)", async () => {
    const r = await save();
    expect(r.ok).toBe(true);
    expect(ledger[0]).toMatchObject({ tenant_id: "t1", user_id: "u1", kind: "task_step", run_id: "run-1" });
  });

  it(`keeps at most ${MAX_TASK_STEP_SCREENSHOTS} per run`, async () => {
    expect(MAX_TASK_STEP_SCREENSHOTS).toBe(5);
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect((await save()).ok).toBe(true);
    }
    expect(await save()).toEqual({ ok: false, code: "task_step_cap" });
    expect(ledger).toHaveLength(5);
    expect((await save("run-2")).ok).toBe(true);
  });

  it("does not count Send ('turn') screenshots toward the per-run cap", async () => {
    for (let i = 0; i < 5; i += 1) ledger.push({ tenant_id: "t1", user_id: "u1", kind: "turn", run_id: "run-1" });
    expect((await save()).ok).toBe(true);
  });

  it("stores nothing without current consent", async () => {
    state.consent = false;
    expect(await save()).toEqual({ ok: false, code: "consent_required" });
    expect(ledger).toHaveLength(0);
  });

  it("fails closed when the per-run count cannot be read", async () => {
    state.countError = true;
    expect(await save()).toEqual({ ok: false, code: "count_failed" });
    expect(ledger).toHaveLength(0);
  });

  it("removes the stored object when the ledger row cannot be written (revoke could not find it)", async () => {
    state.insertError = true;
    expect(await save()).toEqual({ ok: false, code: "store_failed" });
    expect(removed).toEqual([["t1/run-1/img-1.jpg"]]);
  });

  it("consent revoked DURING the save (after the pre-check): object removed, row soft-deleted", async () => {
    consentAnswers.push(true, false);
    expect(await save()).toEqual({ ok: false, code: "consent_required" });
    expect(removed).toEqual([["t1/run-1/img-1.jpg"]]);
    expect(ledger[0].deleted_at).toEqual(expect.any(String));
    expect(artifacts).toHaveLength(0);
  });

  it("revoked during the save and the object removal FAILS: the row stays live so a later revoke can still find it", async () => {
    consentAnswers.push(true, false);
    storageRemoveError.value = { message: "storage down" };
    try {
      expect(await save()).toEqual({ ok: false, code: "store_failed" });
      expect(ledger[0].deleted_at ?? null).toBeNull();
      expect(artifacts).toHaveLength(1);
    } finally {
      storageRemoveError.value = null;
    }
  });

  it("consent revoked BEFORE the save: nothing stored at all", async () => {
    consentAnswers.push(false);
    expect(await save()).toEqual({ ok: false, code: "consent_required" });
    expect(ledger).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });

  it("registers a run_artifacts row pointing at the same stored object, under the run", async () => {
    const r = await save();
    expect(r).toEqual({ ok: true, image_path: "t1/run-1/img-1.jpg" });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      tenant_id: "t1",
      run_id: "run-1",
      bucket: "agent-chat-images",
      storage_path: "t1/run-1/img-1.jpg",
      mime: "image/jpeg",
      agent_slug: "operator",
      thread_id: "0b8f3a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
      slack_delivered: true,
    });
    expect(String(artifacts[0].filename)).toMatch(/^tab-task-[a-z0-9]+\.jpg$/);
  });

  it("keeps nothing when the artifact row cannot be written (object removed, ledger row hidden)", async () => {
    state.artifactError = true;
    expect(await save()).toEqual({ ok: false, code: "store_failed" });
    expect(removed).toEqual([["t1/run-1/img-1.jpg"]]);
    expect(ledger[0].deleted_at).toEqual(expect.any(String));
    expect(artifacts).toHaveLength(0);
  });

  it("registers nothing for a run that is not this tenant's", async () => {
    expect(await save("run-9")).toEqual({ ok: false, code: "store_failed" });
    expect(artifacts).toHaveLength(0);
    expect(removed).toEqual([["t1/run-9/img-1.jpg"]]);
  });
});

describe("taskStepArtifactFilename", () => {
  it("derives a stable tab-task-*.jpg name from the object", () => {
    expect(taskStepArtifactFilename("t1/r1/0b8f3a5e-1c2d-4e5f-8a9b-0c1d2e3f4a5b.jpg")).toBe("tab-task-0b8f3a5e1c2d.jpg");
  });
});
