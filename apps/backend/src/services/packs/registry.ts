
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { serviceClient } from "@/services/supabase";
import {
  PackFileSchema,
  type PackFile,
  type PackRow,
  type PackStatus,
} from "./types";

const PACKS_DIR = join(__dirname, "../../../data/packs");

export class PackValidationError extends Error {
  constructor(message: string, public readonly path: string) {
    super(`${path}: ${message}`);
    this.name = "PackValidationError";
  }
}

export class PackNotFoundError extends Error {
  constructor(pack_id: string) {
    super(`pack not found: ${pack_id}`);
    this.name = "PackNotFoundError";
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const sorted = Object.keys(value as Record<string, unknown>).sort();
  return (
    "{" +
    sorted
      .map(
        (k) =>
          JSON.stringify(k) +
          ":" +
          canonicalJson((value as Record<string, unknown>)[k]),
      )
      .join(",") +
    "}"
  );
}

export function hashPack(pack: PackFile): string {
  return createHash("sha256").update(canonicalJson(pack)).digest("hex");
}

export async function readPackFile(filePath: string): Promise<PackFile> {
  const raw = await fs.readFile(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new PackValidationError(
      `invalid JSON: ${(e as Error).message}`,
      filePath,
    );
  }
  const result = PackFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new PackValidationError(
      `validation failed: ${JSON.stringify(result.error.issues)}`,
      filePath,
    );
  }
  return result.data;
}

export async function listPackFiles(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(PACKS_DIR);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return entries
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(PACKS_DIR, f));
}

export type CompileResult = {
  pack_id: string;
  content_hash: string;
  status: PackStatus;
  action: "inserted" | "updated" | "unchanged";
};

export async function upsertPackFromFile(
  filePath: string,
): Promise<CompileResult> {
  const pack = await readPackFile(filePath);
  const content_hash = hashPack(pack);

  const sb = serviceClient();
  const { data: existing } = await sb
    .from("packs")
    .select("id, content_hash, status")
    .eq("id", pack.id)
    .maybeSingle();

  if (existing && existing.content_hash === content_hash) {
    return { pack_id: pack.id, content_hash, status: pack.status, action: "unchanged" };
  }

  const row = {
    id: pack.id,
    pack_slug: pack.pack_slug,
    semver: pack.semver,
    status: pack.status,
    display_name: pack.display_name,
    description: pack.description ?? "",
    supersedes: pack.supersedes,
    content: pack,
    content_hash,
    compiled_at: new Date().toISOString(),
    entity_types: pack.entity_types,
    outcome_classes: pack.outcome_classes,
    connector_map: pack.connector_map,
    seed_skills: pack.seed_skills,
    seed_memory: pack.seed_memory,
    seed_agent_drafts: pack.seed_agent_drafts,
  };

  const { error } = await sb.from("packs").upsert(row, { onConflict: "id" });
  if (error) {
    throw new Error(`packs upsert failed for ${pack.id}: ${error.message}`);
  }

  return {
    pack_id: pack.id,
    content_hash,
    status: pack.status,
    action: existing ? "updated" : "inserted",
  };
}

export async function compileAllPacks(): Promise<CompileResult[]> {
  const files = await listPackFiles();
  const results: CompileResult[] = [];
  for (const f of files) {
    results.push(await upsertPackFromFile(f));
  }
  return results;
}

export async function loadPack(pack_id: string): Promise<PackRow> {
  const { data, error } = await serviceClient()
    .from("packs")
    .select("*")
    .eq("id", pack_id)
    .maybeSingle();
  if (error) throw new Error(`packs read failed for ${pack_id}: ${error.message}`);
  if (!data) throw new PackNotFoundError(pack_id);
  return data as PackRow;
}

export async function resolveStablePack(
  pack_slug: string,
): Promise<PackRow | null> {
  const { data, error } = await serviceClient()
    .from("packs")
    .select("*")
    .eq("pack_slug", pack_slug)
    .eq("status", "stable")
    .maybeSingle();
  if (error) {
    throw new Error(`stable pack lookup failed for ${pack_slug}: ${error.message}`);
  }
  return (data as PackRow | null) ?? null;
}

export async function listPacks(opts?: {
  pack_slug?: string;
  status?: PackStatus;
}): Promise<PackRow[]> {
  let q = serviceClient().from("packs").select("*").order("compiled_at", { ascending: false });
  if (opts?.pack_slug) q = q.eq("pack_slug", opts.pack_slug);
  if (opts?.status) q = q.eq("status", opts.status);
  const { data, error } = await q;
  if (error) throw new Error(`packs list failed: ${error.message}`);
  return (data ?? []) as PackRow[];
}
