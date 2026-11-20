
import { currentTenant } from "./current";

type RowFor = (table: string) => Promise<unknown>;

function stubClient(rowFor: RowFor) {
  const make = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: await rowFor(table), error: null }),
      single: async () => ({ data: await rowFor(table), error: null }),
    };
    return chain;
  };
  return { from: (table: string) => make(table) };
}

export function supabaseMock() {
  return {
    serviceClient: () =>
      stubClient(async (table) => {
        if (table === "tenant_db_config") {
          return {
            type: currentTenant().catalogRow.dialect,
            connection_secret_key: "operator_db.connection_string",
            schema_map: null,
          };
        }
        return null;
      }),
  };
}

export function tenantClientMock() {
  return {
    asTenantId: (t: string) => t,
    tenantClient: () =>
      stubClient(async (table) => (table === "tenant_db_catalog" ? currentTenant().catalogRow : null)),
  };
}

export function vaultMock() {
  return {
    getSecret: async () => currentTenant().connectionString,
    setSecret: async () => undefined,
  };
}

export function logEventMock() {
  return { logEvent: async () => undefined };
}

export function codeactSandboxMock() {
  return {
    runCodeActPython: async (args: {
      input: unknown;
      python_code: string;
      timeout_ms?: number;
    }): Promise<Record<string, unknown>> => {
      const [{ mkdtemp, writeFile, readFile, rm }, os, path, { execFile }, { promisify }] =
        await Promise.all([
          import("node:fs/promises"),
          import("node:os"),
          import("node:path"),
          import("node:child_process"),
          import("node:util"),
        ]);
      const { buildCodeActRunner } = await import("@/services/sandbox/codeact-sandbox");

      const dir = await mkdtemp(path.join(os.tmpdir(), "codeact-eval-"));
      try {
        const inputPath = path.join(dir, "input.json");
        const codePath = path.join(dir, "user_code.py");
        const runnerPath = path.join(dir, "runner.py");
        const outPath = path.join(dir, "output.json");
        await writeFile(inputPath, JSON.stringify(args.input));
        await writeFile(codePath, args.python_code);
        await writeFile(runnerPath, buildCodeActRunner());

        const exec = promisify(execFile);
        let stdout = "";
        let stderr = "";
        try {
          const r = await exec("python3", ["-I", runnerPath, codePath, inputPath, outPath], {
            timeout: args.timeout_ms ?? 30_000,
            maxBuffer: 8 * 1024 * 1024,
          });
          stdout = r.stdout;
          stderr = r.stderr;
        } catch (e) {
          const err = e as { stdout?: string; stderr?: string; message?: string };
          stdout = err.stdout ?? "";
          stderr = err.stderr ?? err.message ?? "";
        }

        try {
          const raw = await readFile(outPath, "utf8");
          return { ...(JSON.parse(raw) as Record<string, unknown>), stdout, stderr };
        } catch (e) {
          return {
            ok: false,
            error: "codeact_no_output",
            message: `Runner produced no parseable output: ${(e as Error).message}`,
            stdout,
            stderr,
          };
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
