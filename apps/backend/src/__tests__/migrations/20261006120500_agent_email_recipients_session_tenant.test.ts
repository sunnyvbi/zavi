import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "..", "..", "supabase", "migrations");

const ALL_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

function winningBody(fn: string): { file: string; body: string } {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+(public\\.)?${fn}\\s*\\(`, "gi");
  let winner: { file: string; body: string } | null = null;
  for (const m of ALL_SQL) {
    for (const hit of m.sql.matchAll(re)) {
      const rest = m.sql.slice(hit.index ?? 0);
      const open = rest.indexOf("$$");
      const close = rest.indexOf("$$", open + 2);
      winner = { file: m.file, body: rest.slice(0, close + 2) };
    }
  }
  if (!winner) throw new Error(`no migration defines ${fn}`);
  return winner;
}

function codeOnly(body: string): string {
  return body
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

describe.each(["add_agent_email_recipient", "remove_agent_email_recipient"])(
  "%s resolves the session's active tenant",
  (fn) => {
    const { file, body } = winningBody(fn);
    const code = codeOnly(body);

    it("resolves the tenant through app_active_tenant()", () => {
      expect(code, file).toMatch(/select public\.app_active_tenant\(\) into v_tenant_id/);
    });

    it("never falls back to the caller's oldest membership", () => {
      expect(code, file).not.toMatch(/order by tu\.created_at/);
      expect(code, file).not.toMatch(/limit 1/);
    });

    it("re-checks the caller is a member of the resolved tenant and fails closed", () => {
      expect(code, file).toMatch(
        /if v_tenant_id is null or not exists \(select 1 from public\.tenant_users tu where tu\.user_id = v_user_id and tu\.tenant_id = v_tenant_id\) then raise exception 'no_tenant_membership'/,
      );
      expect(code.indexOf("no_tenant_membership")).toBeLessThan(
        code.search(/(insert into|delete from) public\.agent_email_recipients/),
      );
    });

    it("keeps security definer with the pinned search_path", () => {
      expect(code).toMatch(/security definer set search_path = public, pg_temp/);
    });

    it("scopes the write to the resolved tenant", () => {
      if (fn === "add_agent_email_recipient") {
        expect(code).toMatch(/values \(v_tenant_id, v_email/);
        expect(code).toMatch(/where r\.tenant_id = v_tenant_id; if v_count >= c_max then raise exception 'recipient_cap_reached'/);
      } else {
        expect(code).toMatch(/delete from public\.agent_email_recipients r where r\.id = p_id and r\.tenant_id = v_tenant_id/);
        expect(code).toMatch(/return v_deleted > 0/);
      }
    });
  },
);

describe("agent_email_recipients grants and viewer trigger survive", () => {
  const all = ALL_SQL.map((m) => m.sql).join("\n");
  const latest = ALL_SQL.filter((m) => /function (public\.)?(add|remove)_agent_email_recipient\s*\(/i.test(m.sql)).pop()!;

  it("the latest definer re-grants execute to authenticated and service_role only", () => {
    for (const sig of ["add_agent_email_recipient(text, text)", "remove_agent_email_recipient(uuid)"]) {
      expect(latest.sql).toContain(`revoke all on function ${sig} from public, anon, authenticated;`);
      expect(latest.sql).toContain(`grant execute on function ${sig} to authenticated;`);
      expect(latest.sql).toContain(`grant execute on function ${sig} to service_role;`);
    }
    expect(latest.sql).not.toMatch(/grant[^;]*\bto\s+(public|anon)\b/i);
  });

  it("nothing drops the viewer-write trigger on agent_email_recipients", () => {
    expect(all).toMatch(/'agent_email_recipients'/);
    expect(latest.sql).not.toMatch(/zz_refuse_viewer_write|drop trigger/i);
  });
});
