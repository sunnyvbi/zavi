
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { serviceClient, serviceClientLong } from "@/services/supabase";
import { embedTexts, VoyageDimError } from "@/services/memory/embed";
import { mintInstallationToken } from "@/services/connectors/github/oauth";
import { extractSymbols } from "./extract";
import { canIndex } from "./cost-cap";
import type { SymbolRow, RefRow } from "./types";

export function isCodeSymbolIndexEnabled(): boolean {
  return process.env.CODE_SYMBOL_INDEX_ENABLED !== "0";
}

export type IndexRepoStatus =
  | "indexed"
  | "disabled"
  | "cost_capped"
  | "cap_check_failed"
  | "no_symbols"
  | "clone_failed"
  | "embed_failed"
  | "upsert_failed"
  | "error";

export type IndexRepoResult = {
  status: IndexRepoStatus;
  indexed: number;
  refs: number;
  skipped: number;
  detail?: string;
};

export type IndexRepoInput = {
  tenantId: string;
  repo: string;
  commitSha?: string | null;
  repoDir?: string;
  embed?: (texts: string[]) => Promise<number[][]>;
};

const MAX_EMBED_SYMBOLS = 5000;

export async function indexRepo(input: IndexRepoInput): Promise<IndexRepoResult> {
  const { tenantId, repo } = input;

  if (!isCodeSymbolIndexEnabled()) {
    return { status: "disabled", indexed: 0, refs: 0, skipped: 0 };
  }

  let cleanupDir: string | null = null;
  try {
    const cap = await canIndex(tenantId);
    if (!cap.ok) {
      if (cap.reason === "db_error") {
        return {
          status: "cap_check_failed",
          indexed: 0,
          refs: 0,
          skipped: 0,
          detail: "code-index cost-cap counter read failed",
        };
      }
      return {
        status: "cost_capped",
        indexed: 0,
        refs: 0,
        skipped: 0,
        detail: `daily code-index cap reached (${cap.used}/${cap.cap})`,
      };
    }

    let repoDir = input.repoDir;
    if (!repoDir) {
      const cloned = await shallowCloneRepo(tenantId, repo);
      if (!cloned.ok) {
        return { status: "clone_failed", indexed: 0, refs: 0, skipped: 0, detail: cloned.detail };
      }
      repoDir = cloned.dir;
      cleanupDir = cloned.dir;
    }

    const { symbols, refs } = await extractSymbols(repoDir);
    if (symbols.length === 0 && refs.length === 0) {
      return { status: "no_symbols", indexed: 0, refs: 0, skipped: 0 };
    }

    const embedFn = input.embed ?? ((texts: string[]) => embedTexts(texts, "document"));
    const toEmbed = symbols.slice(0, MAX_EMBED_SYMBOLS);
    const skipped = symbols.length - toEmbed.length;

    const symbolsWithEmbedding: Array<SymbolRow & { embedding: number[] | null }> = symbols.map(
      (s) => ({ ...s, embedding: null }),
    );

    if (toEmbed.length > 0) {
      const texts = toEmbed.map((s) => embedText(s));
      try {
        const vectors = await embedFn(texts);
        for (let i = 0; i < toEmbed.length; i++) {
          symbolsWithEmbedding[i].embedding = vectors[i] ?? null;
        }
      } catch (e) {
        if (e instanceof VoyageDimError) {
          console.error(`[code-index] EMBED DIM REGRESSION while indexing ${repo}:`, e.message);
        } else {
          console.warn(
            `[code-index] embed failed for ${repo}; not persisting (degrade): ${(e as Error)?.message ?? e}`,
          );
        }
        return {
          status: "embed_failed",
          indexed: 0,
          refs: 0,
          skipped,
          detail: (e as Error)?.message?.slice(0, 200),
        };
      }
    }

    const persisted = await persistViaGeneration(
      tenantId,
      repo,
      input.commitSha ?? null,
      symbolsWithEmbedding,
      refs,
    );
    if (!persisted.ok) {
      return { status: "upsert_failed", indexed: 0, refs: 0, skipped, detail: persisted.detail };
    }

    return { status: "indexed", indexed: symbols.length, refs: refs.length, skipped };
  } catch (e) {
    return {
      status: "error",
      indexed: 0,
      refs: 0,
      skipped: 0,
      detail: (e as Error)?.message?.slice(0, 200) ?? "unknown",
    };
  } finally {
    if (cleanupDir) await rmDirQuiet(cleanupDir);
  }
}

function embedText(s: SymbolRow): string {
  const sig = (s.signature ?? "").trim();
  return sig.length > 0 ? sig : s.symbol_name;
}

const SYMBOL_CHUNK_ROWS = 400;
const REF_CHUNK_ROWS = 2000;
const CHUNK_MAX_RETRIES = 6;
const CHUNK_RETRY_BACKOFF_MS = 500;
function chunkBackoffBaseMs(): number {
  const v = Number(process.env.CODE_INDEX_CHUNK_BACKOFF_MS);
  return Number.isFinite(v) && v >= 0 ? v : CHUNK_RETRY_BACKOFF_MS;
}

async function persistViaGeneration(
  tenantId: string,
  repo: string,
  commitSha: string | null,
  symbols: Array<SymbolRow & { embedding: number[] | null }>,
  refs: RefRow[],
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const buildId = randomUUID();
  const indexedAt = new Date().toISOString();

  try {
    for (let i = 0; i < symbols.length; i += SYMBOL_CHUNK_ROWS) {
      const batch = symbols.slice(i, i + SYMBOL_CHUNK_ROWS);
      const r = await insertChunkWithRetry(tenantId, repo, buildId, commitSha, indexedAt, batch, []);
      if (!r.ok) return { ok: false, detail: r.detail };
    }
    for (let i = 0; i < refs.length; i += REF_CHUNK_ROWS) {
      const batch = refs.slice(i, i + REF_CHUNK_ROWS);
      const r = await insertChunkWithRetry(tenantId, repo, buildId, commitSha, indexedAt, [], batch);
      if (!r.ok) return { ok: false, detail: r.detail };
    }

    const { error } = await serviceClientLong().rpc("code_index_commit", {
      p_tenant_id: tenantId,
      p_repo: repo,
      p_build_id: buildId,
      p_commit: commitSha,
    });
    if (error) return { ok: false, detail: `commit_failed: ${error.message.slice(0, 180)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: (e as Error)?.message?.slice(0, 200) ?? "persist_threw" };
  }
}

async function insertChunkWithRetry(
  tenantId: string,
  repo: string,
  buildId: string,
  commitSha: string | null,
  indexedAt: string,
  symbols: Array<SymbolRow & { embedding: number[] | null }>,
  refs: RefRow[],
): Promise<{ ok: true } | { ok: false; detail: string }> {
  let lastDetail = "unknown";
  for (let attempt = 0; attempt <= CHUNK_MAX_RETRIES; attempt++) {
    if (attempt > 0) await sleep(chunkBackoffBaseMs() * 2 ** (attempt - 1));
    try {
      const { error } = await serviceClientLong().rpc("code_index_insert_chunk", {
        p_tenant_id: tenantId,
        p_repo: repo,
        p_build_id: buildId,
        p_commit: commitSha,
        p_indexed_at: indexedAt,
        p_symbols: symbols,
        p_refs: refs,
      });
      if (!error) return { ok: true };
      lastDetail = error.message.slice(0, 180);
    } catch (e) {
      lastDetail = (e as Error)?.message?.slice(0, 180) ?? "chunk_threw";
    }
  }
  return { ok: false, detail: `chunk_failed after ${CHUNK_MAX_RETRIES + 1} attempts: ${lastDetail}` };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveInstallationId(tenant_id: string): Promise<number | null> {
  const { data, error } = await serviceClient()
    .from("connector_metadata")
    .select("installation_id")
    .eq("tenant_id", tenant_id)
    .eq("slug", "github")
    .maybeSingle();
  if (error) return null;
  return (data as { installation_id?: number } | null)?.installation_id ?? null;
}

async function shallowCloneRepo(
  tenant_id: string,
  repo: string,
): Promise<{ ok: true; dir: string } | { ok: false; detail: string }> {
  const [owner, name] = repo.split("/");
  if (!owner || !name) return { ok: false, detail: `invalid repo "${repo}"` };

  const installation_id = await resolveInstallationId(tenant_id);
  if (!installation_id) return { ok: false, detail: "github_not_connected" };

  let token: string;
  try {
    token = await mintInstallationToken({ tenant_id, installation_id, repo_full_name: repo });
  } catch (e) {
    return { ok: false, detail: `token_mint_failed: ${(e as Error)?.message?.slice(0, 120)}` };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "praxis-codeidx-"));
  const url = `https://github.com/${owner}/${name}.git`;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const args = [
    "-c",
    `http.extraheader=Authorization: Basic ${basic}`,
    "clone",
    "--depth",
    "1",
    "--single-branch",
    "--no-tags",
    "--filter=blob:none",
    "--sparse",
    url,
    dir,
  ];

  const res = await runGit(args);
  if (res.code !== 0) {
    await rmDirQuiet(dir);
    const safe = res.stderr.replace(basic, "[redacted]").slice(0, 240);
    return { ok: false, detail: `git clone exit ${res.code}: ${safe}` };
  }

  const sparse = await runGit([
    "-C",
    dir,
    "sparse-checkout",
    "set",
    "--no-cone",
    "/**/*.ts",
    "/**/*.tsx",
    "/**/*.js",
    "/**/*.jsx",
    "/**/*.swift",
    "/**/*.kt",
    "/**/*.kts",
  ]);
  if (sparse.code !== 0) {
    await rmDirQuiet(dir);
    return { ok: false, detail: `git sparse-checkout exit ${sparse.code}: ${sparse.stderr.slice(0, 200)}` };
  }
  return { ok: true, dir };
}

function runGit(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on("error", (err) => resolve({ code: 127, stderr: err.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr }));
  });
}

async function rmDirQuiet(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
  }
}
