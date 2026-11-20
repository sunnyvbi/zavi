
import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const { rpcMock, canIndexMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  canIndexMock: vi.fn(),
}));

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({ rpc: rpcMock }),
  serviceClientLong: () => ({ rpc: rpcMock }),
}));
vi.mock("../cost-cap", () => ({
  canIndex: canIndexMock,
  resolveMaxIndexPerDay: () => 5,
  DEFAULT_MAX_CODE_INDEX_PER_TENANT_PER_DAY: 5,
}));
vi.mock("@/services/memory/embed", () => ({
  embedTexts: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
  VoyageDimError: class VoyageDimError extends Error {},
}));
vi.mock("@/services/connectors/github/oauth", () => ({
  mintInstallationToken: async () => "stub-token",
}));

import { indexRepo } from "../build";

async function makeRepoDir(fileCount: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codeidx-test-"));
  for (let i = 0; i < fileCount; i++) {
    const body =
      `export function fn${i}() { return helper${i}(); }\n` +
      `export const c${i} = 1;\n` +
      `function helper${i}() { return c${i}; }\n`;
    await fs.writeFile(path.join(dir, `mod${i}.ts`), body, "utf8");
  }
  return dir;
}

const noopEmbed = async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]);

function rpcCalls(name: string) {
  return rpcMock.mock.calls.filter((c) => c[0] === name);
}

beforeEach(() => {
  rpcMock.mockReset();
  canIndexMock.mockReset();
  canIndexMock.mockResolvedValue({ ok: true, remaining: 5, used: 0, cap: 5 });
  rpcMock.mockResolvedValue({ error: null });
});

describe("indexRepo generation-swap persist (P0)", () => {
  it("persists under one build_id via chunked insert + exactly one commit", async () => {
    const dir = await makeRepoDir(3);
    try {
      const res = await indexRepo({
        tenantId: "tenant-1",
        repo: "owner/name",
        repoDir: dir,
        embed: noopEmbed,
      });
      expect(res.status).toBe("indexed");

      const inserts = rpcCalls("code_index_insert_chunk");
      const commits = rpcCalls("code_index_commit");
      expect(inserts.length).toBeGreaterThan(0);
      expect(commits.length).toBe(1);

      const buildIds = new Set([
        ...inserts.map((c) => c[1].p_build_id),
        ...commits.map((c) => c[1].p_build_id),
      ]);
      expect(buildIds.size).toBe(1);
      const buildId = [...buildIds][0];
      expect(buildId).toMatch(/^[0-9a-f-]{36}$/i);

      for (const c of [...inserts, ...commits]) {
        expect(c[1].p_tenant_id).toBe("tenant-1");
        expect(c[1].p_repo).toBe("owner/name");
      }
      expect(rpcCalls("upsert_code_symbols").length).toBe(0);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("rebuild is idempotent — stable row counts, one generation each pass", async () => {
    const dir = await makeRepoDir(2);
    try {
      const r1 = await indexRepo({ tenantId: "t", repo: "o/n", repoDir: dir, embed: noopEmbed });
      const firstInsertCount = rpcCalls("code_index_insert_chunk").length;
      const firstCommitCount = rpcCalls("code_index_commit").length;

      rpcMock.mockClear();
      const r2 = await indexRepo({ tenantId: "t", repo: "o/n", repoDir: dir, embed: noopEmbed });
      const secondInsertCount = rpcCalls("code_index_insert_chunk").length;
      const secondCommitCount = rpcCalls("code_index_commit").length;

      expect(r1.status).toBe("indexed");
      expect(r2.status).toBe("indexed");
      expect(secondInsertCount).toBe(firstInsertCount);
      expect(firstCommitCount).toBe(1);
      expect(secondCommitCount).toBe(1);
      expect(r1.indexed).toBe(r2.indexed);
      expect(r1.refs).toBe(r2.refs);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("splits a >CHUNK_ROWS payload into multiple insert calls under one build_id", async () => {
    const dir = await makeRepoDir(700);
    try {
      const res = await indexRepo({ tenantId: "t", repo: "o/n", repoDir: dir, embed: noopEmbed });
      expect(res.status).toBe("indexed");
      const inserts = rpcCalls("code_index_insert_chunk");
      expect(inserts.length).toBeGreaterThan(1);
      for (const c of inserts) {
        const sym = (c[1].p_symbols as unknown[]) ?? [];
        const refs = (c[1].p_refs as unknown[]) ?? [];
        expect(sym.length).toBeLessThanOrEqual(2000);
        expect(refs.length).toBeLessThanOrEqual(2000);
      }
      const ids = new Set(inserts.map((c) => c[1].p_build_id));
      expect(ids.size).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("aborts WITHOUT committing when a chunk fails persistently (old generation stays live)", async () => {
    const dir = await makeRepoDir(3);
    const prevBackoff = process.env.CODE_INDEX_CHUNK_BACKOFF_MS;
    process.env.CODE_INDEX_CHUNK_BACKOFF_MS = "0";
    try {
      rpcMock.mockImplementation(async (name: string) => {
        if (name === "code_index_insert_chunk") return { error: { message: "statement timeout" } };
        return { error: null };
      });
      const res = await indexRepo({ tenantId: "t", repo: "o/n", repoDir: dir, embed: noopEmbed });
      expect(res.status).toBe("upsert_failed");
      expect(rpcCalls("code_index_commit").length).toBe(0);
    } finally {
      if (prevBackoff === undefined) delete process.env.CODE_INDEX_CHUNK_BACKOFF_MS;
      else process.env.CODE_INDEX_CHUNK_BACKOFF_MS = prevBackoff;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("retries a transiently-failing chunk and still commits", async () => {
    const dir = await makeRepoDir(1);
    try {
      let firstInsertSeen = false;
      rpcMock.mockImplementation(async (name: string) => {
        if (name === "code_index_insert_chunk") {
          if (!firstInsertSeen) {
            firstInsertSeen = true;
            return { error: { message: "transient blip" } };
          }
          return { error: null };
        }
        return { error: null };
      });
      const res = await indexRepo({ tenantId: "t", repo: "o/n", repoDir: dir, embed: noopEmbed });
      expect(res.status).toBe("indexed");
      expect(rpcCalls("code_index_commit").length).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns cap_check_failed (not cost_capped) on a cost-cap db_error", async () => {
    canIndexMock.mockResolvedValue({ ok: false, remaining: 0, used: 0, cap: 5, reason: "db_error" });
    const res = await indexRepo({ tenantId: "t", repo: "o/n", repoDir: "/does/not/matter", embed: noopEmbed });
    expect(res.status).toBe("cap_check_failed");
    expect(rpcCalls("code_index_insert_chunk").length).toBe(0);
  });

  it("returns cost_capped on a genuine over_cap", async () => {
    canIndexMock.mockResolvedValue({ ok: false, remaining: 0, used: 5, cap: 5, reason: "over_cap" });
    const res = await indexRepo({ tenantId: "t", repo: "o/n", repoDir: "/does/not/matter", embed: noopEmbed });
    expect(res.status).toBe("cost_capped");
  });
});
