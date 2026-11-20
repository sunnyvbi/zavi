import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../../../../supabase/migrations");
const FILE = "20260718114500_list_agent_threads_feed.sql";
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");

const CODE = SQL.replace(/--.*$/gm, "");

describe("list_agent_threads_feed migration", () => {
  it("pins pg_temp on the security-definer search_path (20260711090514 forward guard)", () => {
    expect(CODE).toMatch(
      /create or replace function list_agent_threads_feed[\s\S]*?security definer set search_path = public, pg_temp/i,
    );
  });

  it("is a PURE READ — never soft-deletes threads (the whole reason it exists)", () => {
    expect(CODE).not.toMatch(/update\s+agent_threads/i);
    expect(CODE).not.toMatch(/set\s+deleted_at/i);
    expect(CODE).not.toMatch(/\b(delete\s+from|insert\s+into)\b/i);
  });

  it("has NO hard-coded 50-row cap — the page size comes from the clamped parameter", () => {
    expect(CODE).not.toMatch(/\blimit\s+50\b/i);
    expect(CODE).toMatch(/limit\s+v_lim\b/i);
    expect(CODE).toMatch(/v_lim\s*:=\s*least\(greatest\(coalesce\(p_limit,\s*50\),\s*1\),\s*\d+\)/i);
  });

  it("reply_count uses the guarded/floored form, never a bare count(*) - 1", () => {
    expect(CODE).toMatch(
      /greatest\(\s*mc\.total\s*-\s*case when fm\.id is null then 0 else 1 end\s*,\s*0\s*\)/i,
    );
    expect(CODE).not.toMatch(/count\(\*\)\s*-\s*1/i);
  });

  describe("reply_count arithmetic on the degenerate threads", () => {
    function evalReplyCount(totalMessages: number, hasFirstUserMessage: boolean): number {
      const expr = CODE.match(/greatest\(mc\.total[\s\S]*?\)::int as reply_count/i)?.[0];
      if (!expr) throw new Error("reply_count expression not found in the migration SQL");
      const js = expr
        .replace(/::int as reply_count/i, "")
        .replace(/greatest\(/gi, "Math.max(")
        .replace(/mc\.total/gi, String(totalMessages))
        .replace(
          /case when fm\.id is null then 0 else 1 end/gi,
          hasFirstUserMessage ? "1" : "0",
        );
      // eslint-disable-next-line no-new-func
      return Function(`"use strict"; return (${js});`)() as number;
    }

    it("zero-message thread reads 0, not -1 (the bare count(*) - 1 bug)", () => {
      expect(evalReplyCount(0, false)).toBe(0);
    });

    it("one-message thread (just the opening user message) reads 0 replies", () => {
      expect(evalReplyCount(1, true)).toBe(0);
    });

    it("still counts correctly once replies exist", () => {
      expect(evalReplyCount(4, true)).toBe(3);
    });

    it("an assistant-only thread (no user message) counts every message as a reply", () => {
      expect(evalReplyCount(2, false)).toBe(2);
    });
  });

  it("derives first_user_message from the EARLIEST user message, deterministically", () => {
    const lateral = CODE.match(/left join lateral \(\s*select m\.id, m\.body[\s\S]*?\) fm on true/i)?.[0] ?? "";
    expect(lateral).toMatch(/m\.sender_role = 'user'/i);
    expect(lateral).toMatch(/order by m\.created_at asc, m\.id asc/i);
    expect(lateral).toMatch(/limit 1/i);
  });

  it("keeps run_status and run_outcome on the SAME run so they cannot diverge", () => {
    expect(CODE).toMatch(/select r\.status, r\.outcome[\s\S]*?\) lr on true/i);
    expect(CODE).toMatch(/lr\.status as run_status/i);
    expect(CODE).toMatch(/lr\.outcome as run_outcome/i);
  });

  it("derives `pending` as the open-approval boolean (same semantics as list_agent_threads)", () => {
    expect(CODE).toMatch(/exists \([\s\S]*?join decisions d[\s\S]*?d\.status = 'proposed'[\s\S]*?\) as pending/i);
  });

  it("enforces auth + active tenant + membership INSIDE the definer, all 42501", () => {
    expect(CODE).toMatch(/if v_user_id is null then[\s\S]*?errcode = '42501'/i);
    expect(CODE).toMatch(/app_active_tenant\(\)[\s\S]*?if v_tenant_id is null then[\s\S]*?errcode = '42501'/i);
    expect(CODE).toMatch(
      /if not exists \(select 1 from tenant_users[\s\S]*?user_id = v_user_id and tenant_id = v_tenant_id\)[\s\S]*?errcode = '42501'/i,
    );
  });

  it("scopes every row to this user + tenant + agent, and hides closed threads", () => {
    expect(CODE).toMatch(/t\.agent_slug = p_agent_slug/i);
    expect(CODE).toMatch(/t\.user_id = v_user_id/i);
    expect(CODE).toMatch(/t\.tenant_id = v_tenant_id/i);
    expect(CODE).toMatch(/t\.deleted_at is null/i);
  });

  it("paginates by keyset (cursor + matching total order), not by offset", () => {
    expect(CODE).toMatch(/\(p_before is null or t\.last_message_at < p_before\)/i);
    expect(CODE).toMatch(/order by t\.last_message_at desc, t\.id desc/i);
    expect(CODE).not.toMatch(/\boffset\b/i);
  });

  it("returns the 8 existing columns plus the 2 new ones", () => {
    const sig = CODE.match(/returns table \([\s\S]*?\)\s*language plpgsql/i)?.[0] ?? "";
    for (const col of [
      "id uuid",
      "title text",
      "last_message_at timestamptz",
      "created_at timestamptz",
      "last_message text",
      "run_status text",
      "pending boolean",
      "run_outcome jsonb",
      "reply_count int",
      "first_user_message text",
    ]) {
      expect(sig).toContain(col);
    }
  });

  it("revokes from public and grants only to authenticated", () => {
    expect(CODE).toMatch(
      /revoke all on function public\.list_agent_threads_feed\(text, int, timestamptz\) from public/i,
    );
    expect(CODE).toMatch(
      /grant execute on function public\.list_agent_threads_feed\(text, int, timestamptz\) to authenticated/i,
    );
  });

  it("does NOT touch the existing list_agent_threads (it stays exactly as-is)", () => {
    expect(CODE).not.toMatch(/function list_agent_threads\s*\(/i);
    expect(CODE).not.toMatch(/drop function[\s\S]*list_agent_threads\b(?!_feed)/i);
  });
});
