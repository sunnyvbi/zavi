import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260517220721_chat_image_jpg_only_paths.sql",
  ),
  "utf-8",
);

describe("20260517220721_chat_image_jpg_only_paths.sql", () => {
  it("replaces send_agent_chat_turn_v2 (signature unchanged from v1)", () => {
    expect(sql).toMatch(/create or replace function send_agent_chat_turn_v2/i);
    expect(sql).toMatch(/p_image_paths text\[\]/);
    expect(sql).toMatch(
      /grant execute on function send_agent_chat_turn_v2\(text, text, text, uuid, text\[\]\) to authenticated/i,
    );
  });

  it("tightens path regex to .jpg only (drops png/jpeg/webp)", () => {
    expect(sql).toMatch(/v_tenant_id::text \|\| '\/\[0-9a-f-\]\{36\}\\\.jpg\$'/);
    const codeOnly = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(codeOnly).not.toMatch(/\(png\|jpg\|jpeg\|webp\)/);
  });

  it("does NOT recreate the bucket, attachments column, or RLS policies", () => {
    expect(sql).not.toMatch(/insert into storage\.buckets/i);
    expect(sql).not.toMatch(/alter table agent_thread_messages/i);
    expect(sql).not.toMatch(/create policy/i);
  });

  it("keeps image-only turn allowance + 4-image cap", () => {
    expect(sql).toMatch(
      /coalesce\(p_message, ''\) = '' and coalesce\(array_length\(p_image_paths, 1\), 0\) = 0/,
    );
    expect(sql).toMatch(/array_length\(p_image_paths, 1\)[^>]*> 4/);
  });

  it("uses transactional begin/commit", () => {
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/^commit;\s*$/m);
  });

  it("raises with errcode 42501 on tenant-prefix mismatch", () => {
    expect(sql).toMatch(/raise exception '[^']*does not belong to tenant[^']*'.*using errcode = '42501'/i);
  });
});
