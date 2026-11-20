
import { loadPack } from "./registry";
import type { PackRow } from "./types";

export type MigrationPreview = {
  from_pack_id: string;
  to_pack_id: string;
  hop_count: number;
  breaking_changes: string[];
  agent_drafts_to_seed: string[];
  outcome_class_diffs: Record<string, { added: string[]; removed: string[] }>;
};

export class MigrationNotImplementedError extends Error {
  constructor() {
    super(
      "migrate_tenant_pack is not implemented at B0. Implement when the first " +
        "pack@1.1 ships (a real caller exists). See docs/decisions/architecture-2026-05-09.md §M.B0-decisions Q2.",
    );
    this.name = "MigrationNotImplementedError";
  }
}

export async function previewMigration(
  fromPackId: string,
  toPackId: string,
): Promise<MigrationPreview> {
  const [from, to] = await Promise.all([loadPack(fromPackId), loadPack(toPackId)]);
  return {
    from_pack_id: fromPackId,
    to_pack_id: toPackId,
    hop_count: countHops(from, to),
    breaking_changes: [],
    agent_drafts_to_seed: to.seed_agent_drafts.map((a) => a.slug),
    outcome_class_diffs: diffOutcomeClasses(from, to),
  };
}

export async function migrateTenantPack(
  _tenant_id: string,
  _toPackId: string,
): Promise<never> {
  throw new MigrationNotImplementedError();
}

function countHops(from: PackRow, to: PackRow): number {
  if (from.pack_slug !== to.pack_slug) {
    throw new Error(
      `cross-slug migration not supported (${from.pack_slug} -> ${to.pack_slug})`,
    );
  }
  return from.id === to.id ? 0 : 1;
}

function diffOutcomeClasses(
  from: PackRow,
  to: PackRow,
): Record<string, { added: string[]; removed: string[] }> {
  const diffs: Record<string, { added: string[]; removed: string[] }> = {};
  const allKeys = new Set([
    ...Object.keys(from.outcome_classes),
    ...Object.keys(to.outcome_classes),
  ]);
  for (const k of allKeys) {
    const a = new Set(from.outcome_classes[k] ?? []);
    const b = new Set(to.outcome_classes[k] ?? []);
    const added = [...b].filter((x) => !a.has(x));
    const removed = [...a].filter((x) => !b.has(x));
    if (added.length || removed.length) diffs[k] = { added, removed };
  }
  return diffs;
}
