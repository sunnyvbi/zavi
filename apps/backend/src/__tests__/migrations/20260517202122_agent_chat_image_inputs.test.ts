import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20260517202122_agent_chat_image_inputs.sql",
  ),
  "utf-8",
);

describe("20260517202122_agent_chat_image_inputs.sql", () => {
  it("creates the agent-chat-images bucket idempotently, 5MB cap, png/jpeg/webp only", () => {
    expect(sql).toMatch(/insert into storage\.buckets/i);
    expect(sql).toMatch(/'agent-chat-images'/);
    expect(sql).toMatch(/5242880/);
    expect(sql).toMatch(/'image\/png'/);
    expect(sql).toMatch(/'image\/jpeg'/);
    expect(sql).toMatch(/'image\/webp'/);
    expect(sql).not.toMatch(/'image\/gif'/);
    expect(sql).toMatch(/on conflict \(id\) do update/i);
  });

  it("denies anon + authenticated direct storage access (all I/O via service-role)", () => {
    expect(sql).toMatch(/agent_chat_images_deny_anon_select/);
    expect(sql).toMatch(/agent_chat_images_deny_anon_insert/);
    expect(sql).toMatch(/agent_chat_images_deny_authenticated_select/);
    expect(sql).toMatch(/agent_chat_images_deny_authenticated_insert/);
  });

  it("uses drop-if-exists for all policies (idempotent re-apply)", () => {
    const dropCount = (sql.match(/drop policy if exists/g) ?? []).length;
    expect(dropCount).toBeGreaterThanOrEqual(4);
  });

  it("adds the attachments column to agent_thread_messages (nullable, idempotent)", () => {
    expect(sql).toMatch(
      /alter table agent_thread_messages\s+add column if not exists attachments jsonb/i,
    );
  });

  it("creates send_agent_chat_turn_v2 (NOT an overload — explicit v2 name)", () => {
    expect(sql).toMatch(/create or replace function send_agent_chat_turn_v2/i);
    expect(sql).toMatch(/text\[\]/);
    expect(sql).toMatch(
      /grant execute on function send_agent_chat_turn_v2\(text, text, text, uuid, text\[\]\) to authenticated/i,
    );
  });

  it("enforces tenant-scoped path regex inside the v2 RPC (defense-in-depth)", () => {
    expect(sql).toMatch(/v_tenant_id::text \|\| '\/\[0-9a-f-\]\{36\}/);
    expect(sql).toMatch(/png\|jpg\|jpeg\|webp/);
    expect(sql).toMatch(/does not belong to tenant/);
  });

  it("caps image_paths at 4 per turn", () => {
    expect(sql).toMatch(/array_length\(p_image_paths, 1\)[^>]*> 4/);
  });

  it("allows image-only turns (empty message OK when image_paths present)", () => {
    expect(sql).toMatch(
      /coalesce\(p_message, ''\) = '' and coalesce\(array_length\(p_image_paths, 1\), 0\) = 0/,
    );
  });

  it("writes attachments to thread row + image_paths to agent_runs.payload", () => {
    expect(sql).toMatch(/attachments\)/);
    expect(sql).toMatch(/jsonb_build_object\([^)]*'image_paths'/);
  });

  it("does NOT modify the existing 4-arg send_agent_chat_turn (deploy-order safe)", () => {
    expect(sql).not.toMatch(
      /create or replace function send_agent_chat_turn\(\s*p_agent_slug/i,
    );
    expect(sql).not.toMatch(/drop function .*send_agent_chat_turn\(/i);
  });

  it("uses a single transactional begin/commit", () => {
    expect(sql).toMatch(/^begin;/m);
    expect(sql).toMatch(/^commit;\s*$/m);
  });
});
