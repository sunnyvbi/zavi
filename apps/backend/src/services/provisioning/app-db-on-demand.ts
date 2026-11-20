
import { asTenantId, tenantClient, tenantRpc } from "@/services/tenant-client";
import { provisionCompany } from "./provision-company";
import { attachAppDatabase, HostingServiceMissingError } from "./render-hosting";
import type { ResolveSummary } from "./resolve-resources";
import type { ResourceKind } from "./types";
import {
  APP_DATABASE_SETUP_FAILED_COPY,
  APP_HOSTING_NOT_READY_COPY,
} from "@/services/agents/run-failure-code";

export function sanitizeSetupDetail(detail: string): string {
  return detail
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/\b(?:key|token|secret|password|authorization)\s*[:=]\s*\S+/gi, "<redacted>")
    .slice(0, 300);
}

export class AppDatabaseSetupError extends Error {
  readonly run_failure_code = "app_database_setup_failed" as const;
  readonly detail: string;
  constructor(detail: string, founderCopy: string = APP_DATABASE_SETUP_FAILED_COPY) {
    super(`app_database_setup_failed: ${founderCopy}`);
    this.name = "AppDatabaseSetupError";
    this.detail = sanitizeSetupDetail(detail);
  }
}

export type PushedFile = {
  path: string;
  action?: string;
  content?: string;
  encoding?: string;
};

const CODE_EXT = /\.(?:ts|tsx|js|mjs|cjs)$/i;
const SEED_SUPABASE_PATH = /(?:^|\/)lib\/supabase\.ts$/;

const IMPORT_SPECIFIERS = [
  /\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const DB_ENV = /\bprocess\.env(?:\.DATABASE_URL\b|\[\s*['"]DATABASE_URL['"]\s*\])/;

function isDbModule(spec: string): boolean {
  if (spec === "pg" || spec.startsWith("pg/")) return true;
  if (spec === "postgres") return true;
  if (spec === "drizzle-orm" || spec.startsWith("drizzle-orm/")) return true;
  if (spec === "@prisma/client" || spec.startsWith("@prisma/client/")) return true;
  return /^(?:@\/|(?:\.{1,2}\/)+(?:[^'"]*\/)?)lib\/db(?:\.[cm]?[jt]sx?|\/[^'"]*)?$/.test(spec);
}

function codeLines(content: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of content.split(/\r?\n/)) {
    let line = raw.trim();
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      inBlock = false;
      line = line.slice(end + 2).trim();
    }
    if (line.startsWith("/*")) {
      const end = line.indexOf("*/", 2);
      if (end === -1) {
        inBlock = true;
        continue;
      }
      line = line.slice(end + 2).trim();
    }
    if (!line || line.startsWith("//") || line.startsWith("*")) continue;
    out.push(line);
  }
  return out;
}

export function detectDatabaseUse(files: ReadonlyArray<PushedFile>): boolean {
  for (const f of files) {
    if (f.action === "delete" || f.encoding === "base64" || !f.content) continue;
    if (!CODE_EXT.test(f.path) || SEED_SUPABASE_PATH.test(f.path)) continue;
    for (const line of codeLines(f.content)) {
      if (DB_ENV.test(line)) return true;
      for (const re of IMPORT_SPECIFIERS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          if (isDbModule(m[1])) return true;
        }
      }
    }
  }
  return false;
}

export type EnsureAppDatabaseDeps = {
  readDbRow: (tenant_id: string) => Promise<{ status: string; mode: string } | null>;
  requestAppDatabase: (tenant_id: string) => Promise<void>;
  provision: (tenant_id: string, company_name: string, kinds: ResourceKind[]) => Promise<ResolveSummary>;
  attach: (tenant_id: string) => Promise<unknown>;
};

export const realEnsureAppDatabaseDeps: EnsureAppDatabaseDeps = {
  async readDbRow(tenant_id) {
    const { data, error } = await tenantClient(asTenantId(tenant_id))
      .from("tenant_resources")
      .select("status, mode")
      .eq("resource_kind", "db")
      .maybeSingle<{ status: string; mode: string }>();
    if (error) throw new Error(`db row read failed: ${error.message}`);
    return data ?? null;
  },
  async requestAppDatabase(tenant_id) {
    const { error } = await tenantRpc(asTenantId(tenant_id), "request_app_database");
    if (error) throw new Error(`request_app_database failed: ${error.message}`);
  },
  provision: (tenant_id, company_name, kinds) => provisionCompany(tenant_id, company_name, kinds),
  attach: (tenant_id) => attachAppDatabase(tenant_id),
};

export async function ensureAppDatabase(
  input: { tenant_id: string; files: ReadonlyArray<PushedFile> },
  deps: EnsureAppDatabaseDeps = realEnsureAppDatabaseDeps,
): Promise<{ added: boolean }> {
  const { tenant_id } = input;
  try {
    const row = await deps.readDbRow(tenant_id);
    if (row?.mode === "connected") return { added: false };
    const before = row?.status ?? null;
    const need = before !== null || detectDatabaseUse(input.files);
    if (!need) return { added: false };

    if (before === null) {
      // eslint-disable-next-line no-console
      console.warn(
        `[app-db-on-demand] tenant=${tenant_id} code uses a database with no recorded need; provisioning (backstop)`,
      );
      await deps.requestAppDatabase(tenant_id);
    }

    const summary = await deps.provision(tenant_id, "app", ["db"]);
    if (!summary.provisioned.includes("db")) {
      const failed = summary.failed.find((f) => f.kind === "db");
      const pending = summary.pending_creds.find((p) => p.kind === "db");
      const why = failed
        ? failed.error
        : pending
          ? `missing credential ${pending.missing_key}`
          : summary.connected.includes("db")
            ? "db is in connected mode"
            : "db was not provisioned";
      throw new AppDatabaseSetupError(`database not ready: ${why}`);
    }

    await deps.attach(tenant_id);
    return { added: before !== "ready" };
  } catch (e) {
    const err =
      e instanceof AppDatabaseSetupError
        ? e
        : new AppDatabaseSetupError(
            (e as Error)?.message ?? String(e),
            e instanceof HostingServiceMissingError ? APP_HOSTING_NOT_READY_COPY : APP_DATABASE_SETUP_FAILED_COPY,
          );
    // eslint-disable-next-line no-console
    console.warn(`[app-db-on-demand] tenant=${tenant_id} database setup failed: ${err.detail}`);
    throw err;
  }
}
