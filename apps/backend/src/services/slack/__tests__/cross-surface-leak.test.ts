
import { describe, it, expect, vi, beforeEach } from "vitest";

type IndexRow = {
  tenant_id: string;
  source_team_id: string;
  channel_id: string;
  ts: string;
  thread_ts: string | null;
  text_redacted: string;
  conversation_type: "channel_public" | "channel_private" | "dm" | "mpim";
  source_user_ids: string[];
};
type ChannelMember = { tenant_id: string; team_id: string; channel_id: string; slack_user_id: string };

const db = {
  index: [] as IndexRow[],
  channel_members: [] as ChannelMember[],
  index_state: [] as Array<{ tenant_id: string; disabled_at: string | null }>,
  identities: [] as Array<{ tenant_id: string; external_id: string; member_id: string }>,
  members: [] as Array<{ id: string; status: string; last_active_at: string | null }>,
  tenant_settings: [] as Array<{ tenant_id: string; key: string; value: unknown }>,
  app_settings: [] as Array<{ key: string; value: unknown }>,
};

function reset() {
  db.index = [];
  db.channel_members = [];
  db.index_state = [];
  db.identities = [];
  db.members = [];
  db.tenant_settings = [];
  db.app_settings = [];
}

function markAllAuthorsActive() {
  const ids = new Set(db.index.flatMap((r) => r.source_user_ids));
  let n = 0;
  for (const sid of ids) {
    const mid = `m_${sid}`;
    db.identities.push({ tenant_id: "*", external_id: sid, member_id: mid });
    db.members.push({ id: mid, status: "active", last_active_at: "2026-07-01T00:00:00Z" });
    n++;
  }
  return n;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyChain = any;

vi.mock("@/services/supabase", () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  serviceClient: (): any => {
    const from = (table: string): AnyChain => {
      const eqs: Record<string, unknown> = {};
      const neqs: Record<string, unknown> = {};
      const ins: Record<string, string[]> = {};
      let orFilter: string | null = null;
      const chain: AnyChain = {
        select: () => chain,
        eq: (c: string, v: unknown) => { eqs[c] = v; return chain; },
        neq: (c: string, v: unknown) => { neqs[c] = v; return chain; },
        in: (c: string, v: string[]) => { ins[c] = v; return chain; },
        or: (f: string) => { orFilter = f; return chain; },
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => {
          if (table === "tenant_slack_index_state") {
            const row = db.index_state.find((s) => s.tenant_id === eqs.tenant_id);
            return Promise.resolve({ data: row ?? null, error: null });
          }
          if (table === "tenant_app_setting") {
            const row = db.tenant_settings.find(
              (s) => s.tenant_id === eqs.tenant_id && s.key === eqs.key,
            );
            return Promise.resolve({ data: row ? { value: row.value } : null, error: null });
          }
          if (table === "app_setting") {
            const row = db.app_settings.find((s) => s.key === eqs.key);
            return Promise.resolve({ data: row ? { value: row.value } : null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve: (v: unknown) => void) => {
          if (table === "slack_message_index") {
            let rows = db.index.filter(
              (r) =>
                r.tenant_id === eqs.tenant_id &&
                r.source_team_id === eqs.source_team_id &&
                r.ts !== neqs.ts,
            );
            if (orFilter) {
              const needles = orFilter
                .split(",")
                .map((s) => s.replace("text_redacted.ilike.%", "").replace(/%$/, "").toLowerCase());
              rows = rows.filter((r) =>
                needles.some((n) => r.text_redacted.toLowerCase().includes(n)),
              );
            }
            resolve({ data: rows, error: null });
          } else if (table === "slack_channel_members") {
            const rows = db.channel_members.filter(
              (m) =>
                m.tenant_id === eqs.tenant_id &&
                m.slack_user_id === eqs.slack_user_id &&
                (eqs.team_id === undefined || m.team_id === eqs.team_id) &&
                (ins.channel_id ? ins.channel_id.includes(m.channel_id) : true),
            );
            resolve({ data: rows.map((r) => ({ channel_id: r.channel_id })), error: null });
          } else if (table === "team_member_identities") {
            const rows = db.identities.filter((r) => (ins.external_id ? ins.external_id.includes(r.external_id) : true));
            resolve({ data: rows.map((r) => ({ external_id: r.external_id, member_id: r.member_id })), error: null });
          } else if (table === "team_members") {
            const rows = db.members.filter((m) => (ins.id ? ins.id.includes(m.id) : true));
            resolve({ data: rows, error: null });
          } else {
            resolve({ data: [], error: null });
          }
        },
      };
      return chain;
    };
    return { from };
  },
}));

import { retrieveRelatedSlackContext } from "../cross-surface-context";
import { resolveVisibilityBulkBySlackUser } from "../permission-resolver";

beforeEach(reset);

describe("cross-surface rollover — LEAK contract (E3, merge-blocking)", () => {
  it("#6 CROSS-TENANT: asker in tenant A never sees tenant B's rows", async () => {
    db.index.push(
      { tenant_id: "B", source_team_id: "TB", channel_id: "C9", ts: "10.1", thread_ts: null,
        text_redacted: "SECRET tenant B roadmap pricing", conversation_type: "channel_public", source_user_ids: ["Ub"] },
      { tenant_id: "B", source_team_id: "TB", channel_id: "D9", ts: "10.2", thread_ts: null,
        text_redacted: "SECRET tenant B pricing dm", conversation_type: "dm", source_user_ids: ["U1"] },
    );
    markAllAuthorsActive();
    const block = await retrieveRelatedSlackContext({
      tenant_id: "A", team_id: "TA", asker_slack_user_id: "U1", exclude_ts: "0", query_text: "what is our pricing roadmap",
    });
    expect(block).toBe("");
    expect(block).not.toContain("SECRET");
  });

  it("#7 CROSS-USER: asker U1 never sees U2's DM in the SAME tenant", async () => {
    db.index.push(
      { tenant_id: "A", source_team_id: "TA", channel_id: "D2", ts: "20.1", thread_ts: null,
        text_redacted: "U2 private salary pricing discussion", conversation_type: "dm", source_user_ids: ["U2"] },
      { tenant_id: "A", source_team_id: "TA", channel_id: "C1", ts: "20.2", thread_ts: null,
        text_redacted: "U1 asked about pricing in the public channel", conversation_type: "channel_public", source_user_ids: ["U1"] },
    );
    markAllAuthorsActive();
    const block = await retrieveRelatedSlackContext({
      tenant_id: "A", team_id: "TA", asker_slack_user_id: "U1", exclude_ts: "0", query_text: "pricing question",
    });
    expect(block).not.toContain("salary");
    expect(block).toContain("public channel");
  });

  it("CROSS-WORKSPACE within a tenant: private channel in team TB not visible to a TA asker even with a colliding channel id membership", async () => {
    db.index.push({
      tenant_id: "A", source_team_id: "TB", channel_id: "G1", ts: "30.1", thread_ts: null,
      text_redacted: "workspace TB private channel pricing", conversation_type: "channel_private", source_user_ids: ["Ux"],
    });
    db.channel_members.push({ tenant_id: "A", team_id: "TA", channel_id: "G1", slack_user_id: "U1" });
    markAllAuthorsActive();
    const block = await retrieveRelatedSlackContext({
      tenant_id: "A", team_id: "TA", asker_slack_user_id: "U1", exclude_ts: "0", query_text: "pricing",
    });
    expect(block).toBe("");
    const [verdict] = await resolveVisibilityBulkBySlackUser({
      tenant_id: "A", team_id: "TA", asker_slack_user_id: "U1",
      candidate_rows: [{ channel_id: "G1", conversation_type: "channel_private", source_user_ids: ["Ux"], source_team_id: "TB" }],
    });
    expect(verdict.visible).toBe(false);
  });

  it("kill-switch (disabled_at set) → fails closed to empty", async () => {
    db.index.push({ tenant_id: "A", source_team_id: "TA", channel_id: "C1", ts: "40.1", thread_ts: null,
      text_redacted: "U1 pricing public", conversation_type: "channel_public", source_user_ids: ["U1"] });
    db.index_state.push({ tenant_id: "A", disabled_at: "2026-07-01T00:00:00Z" });
    markAllAuthorsActive();
    const block = await retrieveRelatedSlackContext({
      tenant_id: "A", team_id: "TA", asker_slack_user_id: "U1", exclude_ts: "0", query_text: "pricing",
    });
    expect(block).toBe("");
  });

  it("no keywords in the message → no retrieval, empty block", async () => {
    db.index.push({ tenant_id: "A", source_team_id: "TA", channel_id: "C1", ts: "50.1", thread_ts: null,
      text_redacted: "anything", conversation_type: "channel_public", source_user_ids: ["U1"] });
    markAllAuthorsActive();
    const block = await retrieveRelatedSlackContext({
      tenant_id: "A", team_id: "TA", asker_slack_user_id: "U1", exclude_ts: "0", query_text: "hi ok yes",
    });
    expect(block).toBe("");
  });

  it("happy path: asker's own DM + public channel surface (permission-checked)", async () => {
    db.index.push(
      { tenant_id: "A", source_team_id: "TA", channel_id: "D1", ts: "60.1", thread_ts: null,
        text_redacted: "U1 own dm about the pricing launch", conversation_type: "dm", source_user_ids: ["U1"] },
      { tenant_id: "A", source_team_id: "TA", channel_id: "C1", ts: "60.2", thread_ts: null,
        text_redacted: "U1 pricing thread in public channel", conversation_type: "channel_public", source_user_ids: ["U1"] },
    );
    markAllAuthorsActive();
    const block = await retrieveRelatedSlackContext({
      tenant_id: "A", team_id: "TA", asker_slack_user_id: "U1", exclude_ts: "0", query_text: "pricing launch",
    });
    expect(block).toContain("own dm about the pricing");
    expect(block).toContain("public channel");
  });

  it("HARDENING: feature flag explicitly OFF (tenant override false) → empty, no injection", async () => {
    db.index.push({ tenant_id: "A", source_team_id: "TA", channel_id: "C1", ts: "70.1", thread_ts: null,
      text_redacted: "U1 pricing public", conversation_type: "channel_public", source_user_ids: ["U1"] });
    db.tenant_settings.push({ tenant_id: "A", key: "slack_cross_surface_rollover", value: false });
    markAllAuthorsActive();
    const block = await retrieveRelatedSlackContext({
      tenant_id: "A", team_id: "TA", asker_slack_user_id: "U1", exclude_ts: "0", query_text: "pricing",
    });
    expect(block).toBe("");
  });

  it("HARDENING: Slack Connect / guest sender (not a rostered member) does NOT get channel_public", async () => {
    db.index.push({ tenant_id: "A", source_team_id: "TA", channel_id: "C1", ts: "80.1", thread_ts: null,
      text_redacted: "internal-only pricing roadmap in a public channel", conversation_type: "channel_public", source_user_ids: ["Umember"] });
    markAllAuthorsActive();
    const block = await retrieveRelatedSlackContext({
      tenant_id: "A", team_id: "TA", asker_slack_user_id: "Uguest", exclude_ts: "0", query_text: "pricing roadmap",
    });
    expect(block).toBe("");
    expect(block).not.toContain("internal-only");
  });
});

describe("resolveVisibilityBulkBySlackUser fail-closed", () => {
  it("empty asker_slack_user_id → all denied", async () => {
    const out = await resolveVisibilityBulkBySlackUser({
      tenant_id: "A", team_id: "TA", asker_slack_user_id: "",
      candidate_rows: [{ channel_id: "C1", conversation_type: "channel_public", source_user_ids: ["U1"] }],
    });
    expect(out[0].visible).toBe(false);
  });
  it("empty team_id → all denied", async () => {
    const out = await resolveVisibilityBulkBySlackUser({
      tenant_id: "A", team_id: "", asker_slack_user_id: "U1",
      candidate_rows: [{ channel_id: "C1", conversation_type: "channel_public", source_user_ids: ["U1"] }],
    });
    expect(out[0].visible).toBe(false);
  });
  it("dm: author sees own, non-participant denied", async () => {
    reset();
    db.identities.push({ tenant_id: "A", external_id: "U1", member_id: "mU1" });
    db.members.push({ id: "mU1", status: "active", last_active_at: "2026-07-01T00:00:00Z" });
    const rows = [{ channel_id: "D1", conversation_type: "dm" as const, source_user_ids: ["U1"] }];
    const asAuthor = await resolveVisibilityBulkBySlackUser({ tenant_id: "A", team_id: "TA", asker_slack_user_id: "U1", candidate_rows: rows });
    const asOther = await resolveVisibilityBulkBySlackUser({ tenant_id: "A", team_id: "TA", asker_slack_user_id: "U2", candidate_rows: rows });
    expect(asAuthor[0].visible).toBe(true);
    expect(asOther[0].visible).toBe(false);
  });
});
