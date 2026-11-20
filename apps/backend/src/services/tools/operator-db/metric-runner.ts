
import { callOperatorDbTool } from "@/services/mcp/internal/operator-db";
import { ExpectedToolError } from "@/services/tools/types";
import type { MetricRunner } from "./compute";

function rowsOf(content: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(content) as { data?: { rows?: Record<string, unknown>[] }; rows?: Record<string, unknown>[] };
    const rows = parsed?.data?.rows ?? parsed?.rows;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function assertQueryOk(res: { ok: boolean; is_error: boolean; content: string }): void {
  if (res.ok && !res.is_error) return;
  let code = "operator_db_query_failed";
  let message = "Operator DB query failed while computing a constraint metric.";
  try {
    const parsed = JSON.parse(res.content) as { error?: string; message?: string };
    if (parsed?.error) code = parsed.error;
    if (parsed?.message) message = parsed.message;
  } catch {
  }
  throw new ExpectedToolError(code, message);
}

export type RunnerCaller = { run_id?: string | null; agent_slug?: string | null };

async function aggregateAs(
  tenantId: string,
  collection: string,
  pipeline: Record<string, unknown>[],
  caller: RunnerCaller = {},
): Promise<Record<string, unknown>[]> {
  const res = await callOperatorDbTool(tenantId, "query", { collection, mode: "aggregate", pipeline }, caller);
  assertQueryOk(res);
  return rowsOf(res.content);
}

function countFrom(rows: Record<string, unknown>[]): number {
  const n = rows[0]?.n;
  return typeof n === "number" ? n : 0;
}

export function makeMongoRunner(tenantId: string, caller: RunnerCaller = {}): MetricRunner {
  const aggregate = (t: string, c: string, p: Record<string, unknown>[]) => aggregateAs(t, c, p, caller);
  return {
    async count(collection, filter) {
      const rows = await aggregate(tenantId, collection, [
        { $match: filter ?? {} },
        { $count: "n" },
      ]);
      return countFrom(rows);
    },

    async distinctCount(collection, field, filter) {
      const rows = await aggregate(tenantId, collection, [
        { $match: filter ?? {} },
        { $group: { _id: `$${field}` } },
        { $count: "n" },
      ]);
      return countFrom(rows);
    },

    async distinctJoinMatched(collection, field, refCollection, refField, filter) {
      const ID_TYPES = new Set(["string", "objectId"]);

      const observedTypes = async (coll: string, f: string, flt?: Record<string, unknown>): Promise<string[]> => {
        const rows = await aggregate(tenantId, coll, [
          { $match: flt ?? {} },
          { $group: { _id: { $type: `$${f}` } } },
        ]);
        return rows.map((r) => String(r._id)).filter((t) => t !== "null" && t !== "missing");
      };

      const srcTypes = await observedTypes(collection, field, filter);
      if (srcTypes.some((t) => !ID_TYPES.has(t))) return { matched: 0, attempted: 0, unavailable: true };

      const REDACT_PREFIX = "‹redacted";
      const distinctStrings = async (
        coll: string,
        f: string,
        flt?: Record<string, unknown>,
      ): Promise<{ totalKeys: number; matchKeys: Set<string>; truncated: boolean; redacted: boolean }> => {
        const res = await callOperatorDbTool(tenantId, "query", {
          collection: coll,
          mode: "aggregate",
          pipeline: [
            { $match: flt ?? {} },
            { $group: { _id: { $convert: { input: `$${f}`, to: "string", onError: null, onNull: null } } } },
          ],
        });
        assertQueryOk(res);
        let truncated = false;
        try {
          truncated = Boolean((JSON.parse(res.content) as { data?: { truncated?: boolean } })?.data?.truncated);
        } catch {
          truncated = false;
        }
        const raw = rowsOf(res.content).map((r) => r._id);
        const redacted = raw.some((v) => typeof v === "string" && v.includes(REDACT_PREFIX));
        const matchKeys = new Set(
          raw.filter((v): v is string => typeof v === "string" && v.length > 0 && !v.includes(REDACT_PREFIX)),
        );
        return { totalKeys: raw.length, matchKeys, truncated, redacted };
      };

      const src = await distinctStrings(collection, field, filter);
      if (src.truncated || src.redacted) return { matched: 0, attempted: 0, unavailable: true };
      if (src.totalKeys === 0) return { matched: 0, attempted: 0 };

      const tgtTypes = await observedTypes(refCollection, refField);
      if (tgtTypes.some((t) => !ID_TYPES.has(t))) return { matched: 0, attempted: 0, unavailable: true };
      const tgt = await distinctStrings(refCollection, refField);
      if (tgt.truncated || tgt.redacted) return { matched: 0, attempted: 0, unavailable: true };

      let matched = 0;
      for (const v of src.matchKeys) if (tgt.matchKeys.has(v)) matched++;
      return { matched, attempted: src.totalKeys };
    },

    async groupCount(collection, field, filter) {
      const res = await callOperatorDbTool(tenantId, "query", {
        collection,
        mode: "aggregate",
        pipeline: [
          { $match: filter ?? {} },
          { $group: { _id: `$${field}`, n: { $sum: 1 } } },
        ],
      });
      assertQueryOk(res);
      let truncated = false;
      try {
        const parsed = JSON.parse(res.content) as { data?: { truncated?: boolean } };
        truncated = Boolean(parsed?.data?.truncated);
      } catch {
        truncated = false;
      }
      const groups = rowsOf(res.content).map((r) => ({ value: r._id, count: typeof r.n === "number" ? r.n : 0 }));
      return { groups, truncated };
    },
  };
}
