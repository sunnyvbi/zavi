import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const sql = readFileSync(
  join(
    __dirname,
    "../../../../../supabase/migrations/20261003140000_thread_message_body_allows_attachment_only.sql",
  ),
  "utf-8",
);

describe("20261003140000_thread_message_body_allows_attachment_only.sql", () => {
  it("replaces the body check under the same name", () => {
    expect(sql).toMatch(/drop constraint if exists agent_thread_messages_body_check/i);
    expect(sql).toMatch(/add constraint agent_thread_messages_body_check/i);
  });

  it("keeps the 32000 cap and allows an empty body only with attachments", () => {
    expect(sql).toMatch(/length\(body\) <= 32000/);
    expect(sql).toMatch(/length\(body\) >= 1/);
    expect(sql).toMatch(/jsonb_array_length\(attachments\) > 0/);
  });
});
