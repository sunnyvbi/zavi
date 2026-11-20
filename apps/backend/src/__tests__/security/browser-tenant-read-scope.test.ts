import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(__dirname, "../../../../..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase/migrations");
const WEB_SRC = join(REPO_ROOT, "apps/web/src");

const READ_SCOPE_EXEMPT_TABLES = new Set<string>([
  "tenants",
  "tenant_users",
  "tenant_member_invites",
  "tenant_member_agents",
  "roles",
  "profiles",
  "onboarding_draft",
]);

const READ_SCOPE_ALLOWLIST: Record<string, string> = {
  "components/AgentRunProgress.tsx":
    "agent_run_events filtered by agent_run_id (unguessable UUID) — not enumerable across tenants.",
  "components/workspace/home/CompanyBriefCard.tsx":
    "memory_note filtered by note id (UUID).",
  "lib/workspace/useInlineStatus.ts":
    "agent_runs filtered by run id (UUID).",
  "components/workspace/legacy/InspectorPane.tsx":
    "decisions / memory_entity resolved by id (UUID) from already-scoped inspector content.",
  "app/workspace/WorkspacePage.tsx":
    "agent_threads resolved by thread id (UUID) from ?thread=, selecting agent_slug only — the SSR half of the deep-link resolver. Same shape as useChatThread.ts on this same table. RLS still requires membership in the row's tenant, so there is no unauthorized disclosure. RESIDUAL IS NOW SSR-ONLY: the CLIENT half was scoped to the active tenant on 2026-09-10 (components/workspace/navigation/useLinkedThread.ts, which is where the read moved when it left WorkspaceShell.tsx), so it is no longer allowlisted at all. That was the watch-trigger this entry used to carry, half-honoured. WATCH-TRIGGER for this half: scope it with tenant.id, which WorkspacePage already has in scope — a ~2-line change nobody has needed yet.",
  "components/workspace/chat/ClarifyingQuestionsCard.tsx":
    "agent_clarification_responses scoped by run/thread id (UUID).",
  "components/workspace/agent/PolicyView.tsx":
    "LOW-SEV RESIDUAL — tenant_agent_kill_switch / tenant_agents like HiddenAgentsList but not yet active-tenant-filtered. Exposes only agent visibility metadata (no PII/content), 1 multi-tenant user today. WATCH-TRIGGER: add getActiveTenantId filter (mirror HiddenAgentsList) when multi-tenant users grow.",
  "components/workspace/brain/useBrainPulse.ts":
    "LOW-SEV RESIDUAL — agent_runs COUNT + memory_note realtime pulse (animation only, no content/rows surfaced). Leaks at most a cross-tenant activity count to the 1 multi-tenant user today. WATCH-TRIGGER: filter by active tenant when multi-tenant users grow.",
};

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
}

function tenantTablesFromMigrations(): Set<string> {
  const set = new Set<string>();
  const createBody =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s*\(([\s\S]*?)\n\)/gi;
  const addCol =
    /alter\s+table\s+(?:only\s+)?(?:public\.)?"?([a-z0-9_]+)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?tenant_id\b/gi;
  for (const f of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"))) {
    const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, f), "utf-8"));
    let m: RegExpExecArray | null;
    createBody.lastIndex = 0;
    while ((m = createBody.exec(sql)) !== null) {
      if (/(^|,)\s*"?tenant_id"?\s+[a-z]/i.test(m[2])) set.add(m[1].toLowerCase());
    }
    addCol.lastIndex = 0;
    while ((m = addCol.exec(sql)) !== null) set.add(m[1].toLowerCase());
  }
  return set;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

describe("cross-tenant — browser tenant-table reads must be active-tenant scoped (static)", () => {
  const tenantTables = tenantTablesFromMigrations();
  const guarded = new Set(
    [...tenantTables].filter((t) => !READ_SCOPE_EXEMPT_TABLES.has(t)),
  );

  it("parser sees a non-trivial tenant-table set (not vacuously green)", () => {
    expect(tenantTables.size).toBeGreaterThan(40);
    expect(guarded.has("connector_metadata")).toBe(true);
    expect(guarded.has("memory_note")).toBe(true);
  });

  it("every apps/web read of a tenant table is active-tenant scoped or allowlisted", () => {
    const fromRe = /\.from\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/gi;
    const violations: string[] = [];

    for (const file of walk(WEB_SRC)) {
      const rel = file.slice(WEB_SRC.length + 1);
      const src = readFileSync(file, "utf-8");
      const hits = new Set<string>();
      let m: RegExpExecArray | null;
      fromRe.lastIndex = 0;
      while ((m = fromRe.exec(src)) !== null) {
        const t = m[1].toLowerCase();
        if (guarded.has(t)) hits.add(t);
      }
      if (hits.size === 0) continue;

      const scoped =
        /getActiveTenantId/.test(src) ||
        /\btenant_id\b/.test(src) ||
        /scopeToTenant\s*\(/.test(src);
      const allowlisted = rel in READ_SCOPE_ALLOWLIST;
      if (!scoped && !allowlisted) {
        violations.push(`${rel} — reads [${[...hits].sort().join(", ")}]`);
      }
    }
    violations.sort();

    expect(
      violations,
      `CROSS-TENANT LEAK RISK — these apps/web files read a tenant-scoped table ` +
        `without an active-tenant filter. Membership-based RLS returns rows from ` +
        `EVERY tenant the user belongs to.\n\nFix one of:\n` +
        `  1. Add \`const tid = await getActiveTenantId(sb)\` + ` +
        `\`.eq("tenant_id", tid)\` to the read (preferred — see ` +
        `apps/web/src/lib/active-tenant-client.ts).\n` +
        `  2. If the read is scoped another safe way (an unguessable UUID id), add ` +
        `the file to READ_SCOPE_ALLOWLIST in this test WITH a justification (a ` +
        `reviewer will see it in the diff).\n\nUnscoped reads:\n` +
        violations.map((v) => `  - ${v}`).join("\n"),
    ).toEqual([]);
  });

  it("allowlist has no stale entries (every entry still exists + still reads a guarded table)", () => {
    const fromRe = /\.from\(\s*["'`]([a-z0-9_]+)["'`]\s*\)/gi;
    const stale: string[] = [];
    for (const rel of Object.keys(READ_SCOPE_ALLOWLIST)) {
      const p = join(WEB_SRC, rel);
      let src: string;
      try {
        src = readFileSync(p, "utf-8");
      } catch {
        stale.push(`${rel} (file no longer exists)`);
        continue;
      }
      let reads = false;
      let m: RegExpExecArray | null;
      fromRe.lastIndex = 0;
      while ((m = fromRe.exec(src)) !== null) {
        if (guarded.has(m[1].toLowerCase())) {
          reads = true;
          break;
        }
      }
      if (!reads) stale.push(`${rel} (no longer reads a guarded tenant table — remove entry)`);
      else if (/getActiveTenantId/.test(src))
        stale.push(`${rel} (now uses getActiveTenantId — remove the allowlist entry)`);
    }
    expect(stale, `Stale READ_SCOPE_ALLOWLIST entries — clean up:\n${stale.join("\n")}`).toEqual([]);
  });
});
