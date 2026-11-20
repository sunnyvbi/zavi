import { beforeEach, describe, expect, it, vi } from "vitest";

const TENANT_A = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const RUN_A = "11111111-1111-4111-1111-111111111111";

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  rows: [] as Array<Record<string, unknown>>,
  removedPaths: [] as string[],
  sourceThreads: ["thread-a"],
}));

vi.mock("@/services/auth/middleware", () => ({ requireAuth: mocks.requireAuth }));

function query(operation: "read" | "update" | "delete", changes?: Record<string, unknown>) {
  const filters = new Map<string, unknown>();
  const matching = () => mocks.rows.filter((row) =>
    Array.from(filters).every(([key, value]) => row[key] === value),
  );
  const chain = {
    select: () => chain,
    eq: (key: string, value: unknown) => {
      filters.set(key, value);
      return chain;
    },
    maybeSingle: async () => {
      const row = matching()[0];
      if (row && operation === "update" && changes) Object.assign(row, changes);
      return { data: row ?? null, error: null };
    },
    then: (
      resolve: (result: { error: null }) => unknown,
      reject: (error: unknown) => unknown,
    ) => {
      try {
        if (operation === "delete") {
          const doomed = new Set(matching());
          mocks.rows = mocks.rows.filter((row) => !doomed.has(row));
        }
        return Promise.resolve(resolve({ error: null }));
      } catch (error) {
        return Promise.resolve(reject(error));
      }
    },
  };
  return chain;
}

vi.mock("@/services/supabase", () => ({
  serverClientFromBearer: () => ({
    from: () => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => ({ data: ids.map((id) => ({ id })), error: null }),
      }),
    }),
  }),
  serviceClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async (path: string, _ttl: number, options?: { download?: string }) => ({
          data: { signedUrl: `https://files.example/${path}${options ? "?download=1" : ""}` },
          error: null,
        }),
      }),
    },
  }),
}));

vi.mock("@/services/tenant-client", () => ({
  tenantClient: () => ({
    from: () => ({
      select: () => query("read"),
      update: (changes: Record<string, unknown>) => query("update", changes),
      delete: () => query("delete"),
    }),
  }),
  tenantStorage: () => ({
    from: () => ({
      remove: async (paths: string[]) => {
        mocks.removedPaths.push(...paths);
        return { error: null };
      },
    }),
  }),
}));

import { deleteRunArtifact, getRunArtifact, updateRunArtifact } from "../detail";
import { clearSignedUrlCache } from "@/services/run-artifacts/signed-url-cache";

function response() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
    send() { return this; },
  };
}

beforeEach(() => {
  clearSignedUrlCache();
  mocks.requireAuth.mockResolvedValue({ tenant_id: TENANT_A, user_id: "user-a", access_token: "token" });
  mocks.removedPaths = [];
  mocks.sourceThreads = ["thread-a"];
  mocks.rows = [{
    id: "artifact-a",
    tenant_id: TENANT_A,
    run_id: RUN_A,
    storage_path: `${TENANT_A}/${RUN_A}/report.pdf`,
    bucket: "agent-artifacts",
    filename: "report.pdf",
    title: "Quarterly report",
    mime: "application/pdf",
    bytes: 200,
    created_at: "2026-09-08T10:00:00Z",
    updated_at: "2026-09-08T10:00:00Z",
    agent_slug: "research",
    thread_id: "thread-a",
  }, {
    id: "artifact-b",
    tenant_id: TENANT_B,
    run_id: "22222222-2222-4222-2222-222222222222",
    storage_path: `${TENANT_B}/22222222-2222-4222-2222-222222222222/secret.pdf`,
    bucket: "agent-artifacts",
    filename: "secret.pdf",
    title: "Secret",
    mime: "application/pdf",
    bytes: 100,
    created_at: "2026-09-08T10:00:00Z",
    updated_at: "2026-09-08T10:00:00Z",
    agent_slug: "research",
    thread_id: null,
  }];
});

describe("artifact lifecycle", () => {
  it("returns owned metadata with separate open and download URLs", async () => {
    const res = response();
    await getRunArtifact({ params: { id: "artifact-a" } } as never, res as never);
    expect(res.statusCode).toBe(200);
    const body = res.body as { artifact: { title: string; preview_url: string; download_url: string } };
    expect(body.artifact.title).toBe("Quarterly report");
    expect(body.artifact.preview_url).toContain("report.pdf");
    expect(body.artifact.download_url).toContain("download=1");
  });

  it("renames only an artifact owned by the active tenant", async () => {
    const owned = response();
    await updateRunArtifact(
      { params: { id: "artifact-a" }, body: { title: "Board report" } } as never,
      owned as never,
    );
    expect(owned.statusCode).toBe(200);
    expect(mocks.rows[0].title).toBe("Board report");

    const foreign = response();
    await updateRunArtifact(
      { params: { id: "artifact-b" }, body: { title: "Leaked" } } as never,
      foreign as never,
    );
    expect(foreign.statusCode).toBe(404);
    expect(mocks.rows[1].title).toBe("Secret");
  });

  it("deletes the artifact without deleting its source chat", async () => {
    const res = response();
    await deleteRunArtifact({ params: { id: "artifact-a" } } as never, res as never);
    expect(res.statusCode).toBe(204);
    expect(mocks.rows.map((row) => row.id)).toEqual(["artifact-b"]);
    expect(mocks.removedPaths).toEqual([`${TENANT_A}/${RUN_A}/report.pdf`]);
    expect(mocks.sourceThreads).toEqual(["thread-a"]);
  });
});
