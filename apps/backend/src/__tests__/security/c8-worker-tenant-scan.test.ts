import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKERS_DIR = join(__dirname, "../../../workers/functions");

const NON_WORKER_FILES = new Set(["index.ts", "cron-match.ts"]);

const REVERIFY_MARKERS: RegExp[] = [
  /\.from\(\s*["'`]tenants["'`]\s*\)[\s\S]{0,400}?\.eq\(\s*["'`]id["'`]\s*,\s*tenant_id\s*\)/,
  /assertTenantOptedIn\s*\(\s*tenant_id\s*\)/,
  /\.from\(\s*["'`]connector_metadata["'`]\s*\)[\s\S]{0,600}?\.eq\(\s*["'`]tenant_id["'`]\s*,\s*tenant_id\s*\)/,
  /C8[\s-]?reverified/i,
  /claimAgentRun\s*\(/,
];

const READS_PAYLOAD_TENANT: RegExp[] = [
  /event\.data[^;\n]*\.tenant_id/,
  /(?:const|let|var)\s*\{[^}]*\btenant_id\b[^}]*\}\s*=\s*event\.data/,
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

function workerFiles(): string[] {
  return readdirSync(WORKERS_DIR)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => !f.endsWith(".test.ts"))
    .filter((f) => !NON_WORKER_FILES.has(f));
}

describe("C8 static scan — no worker trusts event.data.tenant_id without re-verifying", () => {
  it("there is a non-trivial set of worker files to scan (sanity)", () => {
    expect(workerFiles().length).toBeGreaterThan(20);
  });

  it("every worker reading event.data.tenant_id re-verifies it against a persisted row", () => {
    const violations: string[] = [];
    for (const file of workerFiles()) {
      const raw = readFileSync(join(WORKERS_DIR, file), "utf-8");
      const code = stripComments(raw);

      const readsPayloadTenant = READS_PAYLOAD_TENANT.some((re) => re.test(code));
      if (!readsPayloadTenant) continue;

      const reverifies = REVERIFY_MARKERS.some((re) => re.test(code));
      if (!reverifies) {
        violations.push(file);
      }
    }

    expect(
      violations,
      `C8 VIOLATION — these workers read event.data.tenant_id for scoping without ` +
        `re-verifying it against a persisted row (re-derive tenant from the claimed ` +
        `row by run_id/batch_id/event_id, or re-fetch the tenant and gate on it):\n` +
        violations.map((v) => `  - workers/functions/${v}`).join("\n"),
    ).toEqual([]);
  });

  it("the scan can actually SEE payload-tenant reads (catches a known re-verifying worker)", () => {
    const readers = workerFiles().filter((file) => {
      const code = stripComments(readFileSync(join(WORKERS_DIR, file), "utf-8"));
      return READS_PAYLOAD_TENANT.some((re) => re.test(code));
    });
    expect(readers).toContain("patterns-nightly.ts");
  });
});
