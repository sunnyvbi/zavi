import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildDistillSlackRpcPayload } from "../distill-event";

const SLACK_INDEX = {
  channel_id: "C123",
  ts: "1700000000.000100",
  author_user_id: "U123",
  text_redacted: "hello",
  thread_ts: null,
  msg_subtype: null,
  conversation_type: "channel_public" as const,
  is_private: false,
  source_team_id: "T123",
  source_user_ids: ["U123"],
};

const BASE = {
  tenant_id: "73db45ff-457e-4541-bc8f-bdb625390204",
  ingested_event_id: "ev-1",
  slack_message_index: SLACK_INDEX,
};

describe("buildDistillSlackRpcPayload", () => {
  it("OMITS the memory_note key entirely when there is nothing to store", () => {
    const p = buildDistillSlackRpcPayload({ ...BASE, memory_note: null });

    expect("memory_note" in p).toBe(false);
    expect(Object.keys(p).sort()).toEqual([
      "ingested_event_id",
      "slack_message_index",
      "tenant_id",
    ]);
  });

  it("serializes to JSON with no memory_note key (what the RPC actually receives)", () => {
    const wire = JSON.parse(
      JSON.stringify(buildDistillSlackRpcPayload({ ...BASE, memory_note: null })),
    );
    expect(Object.prototype.hasOwnProperty.call(wire, "memory_note")).toBe(false);
    expect(JSON.stringify(wire)).not.toContain("memory_note");
  });

  it("passes memory_note through untouched when there IS something to store", () => {
    const note = {
      title: "Referral program decided",
      body_markdown: "50 USD to the referring host.",
      source_ref: "slack:C123:1700000000.000100",
      tags: ["slack:company"],
      note_type: "tenant_reference",
      connector_object_keys: ["slack_channel:C123"],
    };
    const p = buildDistillSlackRpcPayload({ ...BASE, memory_note: note });

    expect(p.memory_note).toEqual(note);
    expect(p.tenant_id).toBe(BASE.tenant_id);
    expect(p.ingested_event_id).toBe(BASE.ingested_event_id);
    expect(p.slack_message_index).toEqual(SLACK_INDEX);
  });

  it("never lets the payload claim a tenant other than the caller's (C8)", () => {
    const p = buildDistillSlackRpcPayload({ ...BASE, memory_note: null });
    expect(p.tenant_id).toBe(BASE.tenant_id);
  });
});

describe("migration 20260728002303 — RPC-side guard (defense in depth)", () => {
  const raw = readFileSync(
    join(
      __dirname,
      "../../../../../supabase/migrations/20260728002303_fix_distill_slack_blank_memory_notes.sql",
    ),
    "utf8",
  );

  const sql = raw
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");

  it("guards the memory_note insert on jsonb_typeof AND a non-blank title", () => {
    expect(sql).toMatch(
      /if\s+v_memory_payload\s+is\s+not\s+null\s+and\s+jsonb_typeof\(v_memory_payload\)\s*<>\s*'null'\s+and\s+btrim\(coalesce\(v_memory_payload\s*->>\s*'title',\s*''\)\)\s*<>\s*''\s+then/i,
    );
  });

  it("preserves the C8 tenant trust boundary and the kill-switch gate (failsafe)", () => {
    expect(sql).toMatch(/raise exception 'distill_slack_event_write: tenant_id is required'/);
    expect(sql).toMatch(/v_killswitched\s*:=\s*not slack_index_visible\(v_tenant_id\)/);
    expect(sql).toMatch(/on conflict \(tenant_id, channel_id, ts\) do nothing/);
    expect(sql).toMatch(/connector_object_keys/);
    expect(sql).toMatch(/set search_path = public, pg_temp/);
  });

  it("keeps the grant lockdown (codex F8)", () => {
    expect(sql).toMatch(
      /revoke all on function distill_slack_event_write\(jsonb\) from public, authenticated, anon/,
    );
    expect(sql).toMatch(
      /grant execute on function distill_slack_event_write\(jsonb\) to service_role/,
    );
  });

  it("purges only rows matching the bug's EXACT shape, field by field", () => {
    const del = sql.slice(sql.indexOf("delete from memory_note"));
    for (const re of [
      /mn\.source\s*=\s*'auto_distill_slack'/,
      /coalesce\(mn\.title,\s*''\)\s*=\s*''/,
      /coalesce\(mn\.body_markdown,\s*''\)\s*=\s*''/,
      /mn\.content_hash is null/,
      /coalesce\(array_length\(mn\.tags,\s*1\),\s*0\)\s*=\s*0/,
      /mn\.source_ref is null/,
      /mn\.note_type\s*=\s*'untyped'/,
      /coalesce\(mn\.metadata,\s*'\{\}'::jsonb\)\s*=\s*'\{\}'::jsonb/,
      /coalesce\(mn\.connector_object_keys,\s*'\[\]'::jsonb\)\s*=\s*'\[\]'::jsonb/,
      /mn\.agent_slug is null/,
      /mn\.thread_id is null/,
      /mn\.slug is null/,
      /mn\.superseded_by is null/,
      /mn\.archived_at is null/,
      /mn\.valid_from is null/,
      /mn\.valid_to is null/,
    ]) {
      expect(del).toMatch(re);
    }
  });

  it("guards EVERY backlink FK — the aborting one and the silent SET NULL ones", () => {
    const del = sql.slice(sql.indexOf("delete from memory_note"));
    expect(del).toMatch(
      /not exists\s*\(\s*select 1 from memory_relation mr where mr\.source_note_id = mn\.id\s*\)/,
    );
    expect(del).toMatch(
      /not exists\s*\(\s*select 1 from takes tk where tk\.source_note_id = mn\.id\s*\)/,
    );
    expect(del).toMatch(
      /not exists\s*\(\s*select 1 from tenant_routines tr where tr\.source_note_id = mn\.id\s*\)/,
    );
    expect(del).not.toMatch(/from tenant_skills/);
    expect(del).toMatch(
      /not exists\s*\(\s*select 1 from memory_note other where other\.superseded_by = mn\.id\s*\)/,
    );
  });
});
