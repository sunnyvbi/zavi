
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/services/supabase", async () => (await import("../harness/mocks")).supabaseMock());
vi.mock("@/services/tenant-client", async () => (await import("../harness/mocks")).tenantClientMock());
vi.mock("@/services/secrets/vault", async () => (await import("../harness/mocks")).vaultMock());
vi.mock("@/services/logging/logEvent", async () => (await import("../harness/mocks")).logEventMock());
vi.mock("@/services/sandbox/codeact-sandbox", async (orig) => ({
  ...((await orig()) as object),
  ...(await import("../harness/mocks")).codeactSandboxMock(),
}));

import { configuredDialects, dbUrlFor, type EvalDialect } from "../env";
import { MONGO_PROBES, SQL_PROBES } from "../harness/capability-probes";
import { installEvalTenant, runTool } from "../harness/eval-tenant";
import { ALL_SHAPES } from "../questions";

const DIALECTS = configuredDialects();
const live = DIALECTS.length > 0;

describe.skipIf(!live)("operator-db analytics — tool layer", () => {
  beforeAll(() => {
    console.log(`[eval] dialects under test: ${DIALECTS.join(", ")}`);
    const missing = (["postgres", "mysql", "mongodb"] as EvalDialect[]).filter(
      (d) => !DIALECTS.includes(d),
    );
    if (missing.length > 0) console.log(`[eval] NOT EXERCISED (unknown, not passing): ${missing.join(", ")}`);
  });

  describe("discovery sees every business shape", () => {
    for (const dialect of DIALECTS) {
      for (const shape of ALL_SHAPES) {
        it(`${dialect}/${shape}: catalog lists the shape's tables`, async () => {
          const tenant = await installEvalTenant(dialect, shape);
          const tables = (tenant.catalogRow.catalog as { tables: { name: string }[] }).tables ?? [];
          expect(tables.length, `${dialect}/${shape} discovered no tables`).toBeGreaterThan(0);

          const res = await runTool("catalog", {});
          expect(res.ok, `catalog tool failed: ${res.content}`).toBe(true);
          const parsed = JSON.parse(res.content) as { data?: { ready?: boolean } };
          expect(parsed.data?.ready, `${dialect}/${shape} catalog not ready`).toBe(true);
        });
      }
    }
  });

  describe("capability probes — SQL", () => {
    for (const dialect of DIALECTS.filter((d) => d !== "mongodb") as ("postgres" | "mysql")[]) {
      for (const probe of SQL_PROBES) {
        const sql = probe.sql[dialect];
        it.skipIf(!sql)(`${dialect}: ${probe.id} — ${probe.what}`, async () => {
          await installEvalTenant(dialect, probe.shape);
          const started = Date.now();
          const res = await runTool("codeact", {
            purpose: probe.what,
            sql_reads: [sql!],
            python_code: "result = rows[0]['rows'][:5]",
          });
          const ms = Date.now() - started;
          expect(res.ok, `${probe.id} on ${dialect} failed after ${ms}ms: ${res.content}`).toBe(true);
          const parsed = JSON.parse(res.content) as {
            data?: { compute?: { ok?: boolean; result?: unknown; error?: string | null } };
          };
          expect(parsed.data?.compute?.ok, `${probe.id} compute failed: ${parsed.data?.compute?.error}`).toBe(true);
          const first = (parsed.data?.compute?.result as unknown[])?.[0];
          if (probe.expect) {
            expect(probe.expect(first), `${probe.id} returned ${JSON.stringify(first)}`).toBe(true);
          }
        });
      }
    }
  });

  describe("capability probes — MongoDB", () => {
    const hasMongo = DIALECTS.includes("mongodb");
    for (const probe of MONGO_PROBES) {
      it.skipIf(!hasMongo)(`mongodb: ${probe.id} — ${probe.what}`, async () => {
        await installEvalTenant("mongodb", probe.shape);
        const res = await runTool("query", {
          collection: probe.collection,
          mode: probe.mode,
          ...(probe.pipeline ? { pipeline: probe.pipeline } : {}),
          ...(probe.filter ? { filter: probe.filter } : {}),
        });
        if (probe.expect_rejected) {
          expect(res.ok, `${probe.id} was expected to be REJECTED but succeeded`).toBe(false);
          return;
        }
        expect(res.ok, `${probe.id} failed: ${res.content}`).toBe(true);
        const parsed = JSON.parse(res.content) as { data?: { rows?: unknown } };
        const rows = parsed.data?.rows ?? (parsed as { data?: unknown }).data;
        if (probe.expect) {
          expect(probe.expect(rows), `${probe.id} returned ${JSON.stringify(rows).slice(0, 300)}`).toBe(true);
        }
      });
    }
  });
});
