import { describe, it, expect, vi } from "vitest";

vi.mock("@/services/tenant-client", () => ({
  asTenantId: (t: string) => t,
  tenantClient: vi.fn(),
  tenantRpc: vi.fn(),
}));
vi.mock("@/services/secrets/vault", () => ({ getSecret: vi.fn() }));
vi.mock("@/services/provisioning/secret", () => ({ setResourceSecret: vi.fn() }));
vi.mock("@/services/provisioning/render-hosting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/provisioning/render-hosting")>()),
  attachAppDatabase: vi.fn(),
}));
vi.mock("@/services/provisioning/provision-company", () => ({ provisionCompany: vi.fn() }));

import {
  detectDatabaseUse,
  ensureAppDatabase,
  AppDatabaseSetupError,
  type EnsureAppDatabaseDeps,
} from "@/services/provisioning/app-db-on-demand";
import type { ResolveSummary } from "@/services/provisioning/resolve-resources";
import { HostingServiceMissingError } from "@/services/provisioning/render-hosting";
import {
  APP_DATABASE_SETUP_FAILED_COPY,
  APP_HOSTING_NOT_READY_COPY,
} from "@/services/agents/run-failure-code";

const f = (path: string, content: string) => ({ path, action: "modify", content });

describe("detectDatabaseUse — catches", () => {
  const hits: Array<[string, string, string]> = [
    ["@/lib/db import", "app/api/todos/route.ts", `import { query } from "@/lib/db";`],
    ["relative lib/db", "app/api/todos/route.ts", `import { query } from "../../../lib/db";`],
    ["relative lib/db with ext", "scripts/seed.mjs", `import { pool } from "./lib/db.js";`],
    ["pg import", "lib/db.ts", `import { Pool } from "pg";`],
    ["pg require", "scripts/migrate.cjs", `const { Client } = require('pg');`],
    ["postgres", "lib/sql.ts", `import postgres from "postgres";`],
    ["drizzle-orm subpath", "db/index.ts", `import { drizzle } from "drizzle-orm/node-postgres";`],
    ["drizzle-orm", "db/schema.ts", `import { sql } from "drizzle-orm";`],
    ["prisma", "lib/prisma.tsx", `import { PrismaClient } from "@prisma/client";`],
    ["dynamic import", "app/page.tsx", `const { Pool } = await import("pg");`],
    ["process.env.DATABASE_URL", "lib/conn.js", `const url = process.env.DATABASE_URL;`],
    ["process.env['DATABASE_URL']", "lib/conn.js", `const url = process.env['DATABASE_URL'];`],
    ["code after a block comment", "lib/x.ts", `/* setup */ import { Pool } from "pg";`],
  ];
  for (const [name, path, content] of hits) {
    it(name, () => {
      expect(detectDatabaseUse([f(path, content)])).toBe(true);
    });
  }
});

describe("detectDatabaseUse — must not touch", () => {
  const seedSupabase = [
    `/** Server-side Postgres URL, if provisioned. Use in server code only. */`,
    `export function databaseUrl(): string | null {`,
    `  return process.env.DATABASE_URL || null;`,
    `}`,
  ].join("\n");
  const misses: Array<[string, string, string]> = [
    ["seed lib/supabase.ts", "lib/supabase.ts", seedSupabase],
    ["seed lib/supabase.ts under src/", "src/lib/supabase.ts", seedSupabase],
    ["README naming DATABASE_URL", "README.md", "Set `process.env.DATABASE_URL` and `import pg from 'pg'`."],
    [".env.example", ".env.example", "DATABASE_URL=postgres://localhost/app"],
    ["// no database needed comment", "app/page.tsx", `// no database needed: uses process.env.DATABASE_URL? no\nexport default function P() { return null; }`],
    ["block comment mentioning pg", "app/page.tsx", `/*\n * import { Pool } from "pg";\n * process.env.DATABASE_URL\n */\nexport const x = 1;`],
    ["package-lock with postgres", "package-lock.json", `{"packages":{"node_modules/postgres":{"version":"3.4.0"}}}`],
    ["postgres-notes.md", "docs/postgres-notes.md", `import postgres from "postgres"`],
    ["unrelated imports", "app/page.tsx", `import Link from "next/link";\nimport { pgTable } from "./pgTable";\nimport x from "@/lib/dbx";`],
  ];
  for (const [name, path, content] of misses) {
    it(name, () => {
      expect(detectDatabaseUse([f(path, content)])).toBe(false);
    });
  }

  it("a deleted file is not evidence", () => {
    expect(detectDatabaseUse([{ path: "lib/db.ts", action: "delete", content: `import { Pool } from "pg";` }])).toBe(false);
  });

  it("an empty file list is not evidence", () => {
    expect(detectDatabaseUse([])).toBe(false);
  });
});

function summary(over: Partial<ResolveSummary> = {}): ResolveSummary {
  return { provisioned: ["db"], connected: [], pending_creds: [], failed: [], context: {}, ...over };
}

function deps(status: string | null, over: Partial<EnsureAppDatabaseDeps> = {}, mode = "provisioned") {
  const d = {
    readDbRow: vi.fn().mockResolvedValue(status === null ? null : { status, mode }),
    requestAppDatabase: vi.fn().mockResolvedValue(undefined),
    provision: vi.fn().mockResolvedValue(summary()),
    attach: vi.fn().mockResolvedValue({ render_service_id: "srv-1" }),
    ...over,
  };
  return d as typeof d & EnsureAppDatabaseDeps;
}

const STATIC = [f("app/page.tsx", `export default function P() { return <h1>Hi</h1>; }`)];
const DATA = [f("app/api/todos/route.ts", `import { query } from "@/lib/db";`)];

describe("ensureAppDatabase", () => {
  it("no db row and no database use: no-op", async () => {
    const d = deps(null);
    expect(await ensureAppDatabase({ tenant_id: "t1", files: STATIC }, d)).toEqual({ added: false });
    expect(d.requestAppDatabase).not.toHaveBeenCalled();
    expect(d.provision).not.toHaveBeenCalled();
    expect(d.attach).not.toHaveBeenCalled();
  });

  for (const status of ["pending", "failed", "torn_down", "ready"]) {
    it(`db row ${status}: provisions app db + attaches (static files)`, async () => {
      const d = deps(status);
      const r = await ensureAppDatabase({ tenant_id: "t1", files: STATIC }, d);
      expect(d.requestAppDatabase).not.toHaveBeenCalled();
      expect(d.provision).toHaveBeenCalledWith("t1", "app", ["db"]);
      expect(d.attach).toHaveBeenCalledWith("t1");
      expect(r).toEqual({ added: status !== "ready" });
    });
  }

  it("db row in connected mode (founder's own DB): no-op even when code uses a database", async () => {
    const d = deps("ready", {}, "connected");
    expect(await ensureAppDatabase({ tenant_id: "t1", files: DATA }, d)).toEqual({ added: false });
    expect(d.requestAppDatabase).not.toHaveBeenCalled();
    expect(d.provision).not.toHaveBeenCalled();
    expect(d.attach).not.toHaveBeenCalled();
  });

  it("no row but the code uses a database: records the need, then provisions + attaches", async () => {
    const order: string[] = [];
    const d = deps(null, {
      requestAppDatabase: vi.fn(async () => void order.push("request")),
      provision: vi.fn(async () => (order.push("provision"), summary())),
      attach: vi.fn(async () => order.push("attach")),
    });
    const r = await ensureAppDatabase({ tenant_id: "t1", files: DATA }, d);
    expect(order).toEqual(["request", "provision", "attach"]);
    expect(d.requestAppDatabase).toHaveBeenCalledWith("t1");
    expect(r).toEqual({ added: true });
  });

  it("provision summary reports db failed: error, attach NOT called", async () => {
    const d = deps("pending", {
      provision: vi.fn().mockResolvedValue(summary({ provisioned: [], failed: [{ kind: "db", error: "neon 500" }] })),
    });
    const p = ensureAppDatabase({ tenant_id: "t1", files: STATIC }, d);
    await expect(p).rejects.toBeInstanceOf(AppDatabaseSetupError);
    await expect(p).rejects.toThrow(/^app_database_setup_failed: /);
    await expect(p).rejects.toMatchObject({ detail: expect.stringMatching(/neon 500/) });
    expect(d.attach).not.toHaveBeenCalled();
  });

  it("provision summary reports a missing credential: error, attach NOT called", async () => {
    const d = deps("pending", {
      provision: vi.fn().mockResolvedValue(summary({ provisioned: [], pending_creds: [{ kind: "db", missing_key: "NEON_API_KEY" }] })),
    });
    await expect(ensureAppDatabase({ tenant_id: "t1", files: STATIC }, d)).rejects.toMatchObject({
      detail: expect.stringMatching(/NEON_API_KEY/),
    });
    expect(d.attach).not.toHaveBeenCalled();
  });

  it("provision throws: error, attach NOT called", async () => {
    const d = deps("pending", { provision: vi.fn().mockRejectedValue(new Error("boom")) });
    await expect(ensureAppDatabase({ tenant_id: "t1", files: STATIC }, d)).rejects.toMatchObject({
      message: expect.stringMatching(/^app_database_setup_failed: /),
      detail: "boom",
    });
    expect(d.attach).not.toHaveBeenCalled();
  });

  it("attach failure: error", async () => {
    const d = deps("ready", { attach: vi.fn().mockRejectedValue(new Error("env-var PUT DATABASE_URL failed (500)")) });
    const p = ensureAppDatabase({ tenant_id: "t1", files: STATIC }, d);
    await expect(p).rejects.toBeInstanceOf(AppDatabaseSetupError);
    await expect(p).rejects.toMatchObject({ detail: expect.stringMatching(/PUT DATABASE_URL failed/) });
  });

  it("request_app_database failure: error, nothing provisioned", async () => {
    const d = deps(null, { requestAppDatabase: vi.fn().mockRejectedValue(new Error("rpc down")) });
    await expect(ensureAppDatabase({ tenant_id: "t1", files: DATA }, d)).rejects.toMatchObject({
      detail: expect.stringMatching(/rpc down/),
    });
    expect(d.provision).not.toHaveBeenCalled();
  });

  it("db row read failure: error (never guesses 'no need')", async () => {
    const d = deps(null, { readDbRow: vi.fn().mockRejectedValue(new Error("db row read failed: x")) });
    await expect(ensureAppDatabase({ tenant_id: "t1", files: STATIC }, d)).rejects.toBeInstanceOf(AppDatabaseSetupError);
    expect(d.provision).not.toHaveBeenCalled();
  });

  it("the error carries run_failure_code", async () => {
    const e = new AppDatabaseSetupError("x");
    expect(e.run_failure_code).toBe("app_database_setup_failed");
    expect(e.message).toBe("app_database_setup_failed: Couldn't set up your site's database. No changes were published. Retry.");
    expect(e.detail).toBe("x");
    expect(e).toBeInstanceOf(Error);
  });

  it("the customer-visible message never carries the diagnostic; the log does, sanitized", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps("ready", {
      attach: vi
        .fn()
        .mockRejectedValue(new Error("env-var PUT DATABASE_URL failed (500) postgres://u:pw@host/db token=abc123")),
    });
    const err = await ensureAppDatabase({ tenant_id: "t1", files: STATIC }, d).catch((e) => e);
    expect(err.message).toBe("app_database_setup_failed: Couldn't set up your site's database. No changes were published. Retry.");
    expect(err.message).not.toMatch(/PUT|500|postgres/);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/tenant=t1 .*env-var PUT DATABASE_URL failed \(500\)/);
    expect(logged).not.toMatch(/pw@host|abc123/);
    warn.mockRestore();
  });

  describe("founder copy names the part that failed", () => {
    const realAttachWithoutService = async (tenant_id: string) => {
      const { attachAppDatabase } = await vi.importActual<typeof import("@/services/provisioning/render-hosting")>(
        "@/services/provisioning/render-hosting",
      );
      return attachAppDatabase(tenant_id, {
        token: () => "tok",
        fetchFn: vi.fn() as never,
        resolveServiceId: async () => null,
      });
    };

    it("no Render service at attach time: hosting copy, diagnostic kept on detail only", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const d = deps("ready", { attach: vi.fn(realAttachWithoutService) });
      const err = await ensureAppDatabase({ tenant_id: "1edf051e", files: STATIC }, d).catch((e) => e);
      expect(err).toBeInstanceOf(AppDatabaseSetupError);
      expect(err.run_failure_code).toBe("app_database_setup_failed");
      expect(err.message).toBe(`app_database_setup_failed: ${APP_HOSTING_NOT_READY_COPY}`);
      expect(err.message).not.toContain("database.");
      expect(err.message).not.toMatch(/Render|1edf051e|attach|service/);
      expect(err.detail).toBe("attach app database: no provisioned Render service for tenant 1edf051e");
      expect(d.provision).toHaveBeenCalledOnce();
      warn.mockRestore();
    });

    it("a HostingServiceMissingError from any attach is the hosting copy", async () => {
      const d = deps("pending", { attach: vi.fn().mockRejectedValue(new HostingServiceMissingError("t1")) });
      await expect(ensureAppDatabase({ tenant_id: "t1", files: STATIC }, d)).rejects.toMatchObject({
        message: `app_database_setup_failed: ${APP_HOSTING_NOT_READY_COPY}`,
      });
    });

    const databaseFailures: Array<[string, Partial<EnsureAppDatabaseDeps>]> = [
      ["neon reports db failed", { provision: vi.fn().mockResolvedValue(summary({ provisioned: [], failed: [{ kind: "db", error: "neon 500" }] })) }],
      ["neon credential missing", { provision: vi.fn().mockResolvedValue(summary({ provisioned: [], pending_creds: [{ kind: "db", missing_key: "NEON_API_KEY" }] })) }],
      ["provision throws", { provision: vi.fn().mockRejectedValue(new Error("neon timeout")) }],
      ["attach env PUT fails", { attach: vi.fn().mockRejectedValue(new Error("attach app database: env-var PUT DATABASE_URL on srv-1 failed (500): x")) }],
      ["attach cannot resolve DATABASE_URL", { attach: vi.fn().mockRejectedValue(new Error("attach app database: DATABASE_URL could not be resolved from Vault after 3 attempts")) }],
      ["db row read fails", { readDbRow: vi.fn().mockRejectedValue(new Error("db row read failed: x")) }],
    ];
    for (const [name, over] of databaseFailures) {
      it(`${name}: database copy, never the hosting copy`, async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const d = deps("pending", over);
        const err = await ensureAppDatabase({ tenant_id: "t1", files: STATIC }, d).catch((e) => e);
        expect(err).toBeInstanceOf(AppDatabaseSetupError);
        expect(err.message).toBe(`app_database_setup_failed: ${APP_DATABASE_SETUP_FAILED_COPY}`);
        expect(err.message).not.toContain(APP_HOSTING_NOT_READY_COPY);
        warn.mockRestore();
      });
    }

    it("AppDatabaseSetupError defaults to the database copy and takes the hosting copy when told", () => {
      expect(new AppDatabaseSetupError("x").message).toBe(`app_database_setup_failed: ${APP_DATABASE_SETUP_FAILED_COPY}`);
      const hosting = new AppDatabaseSetupError("x", APP_HOSTING_NOT_READY_COPY);
      expect(hosting.message).toBe(`app_database_setup_failed: ${APP_HOSTING_NOT_READY_COPY}`);
      expect(hosting.run_failure_code).toBe("app_database_setup_failed");
    });
  });
});
