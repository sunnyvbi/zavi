
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const isIntegration = process.env.INTEGRATION === "1";

const sb: SupabaseClient | null = isIntegration
  ? createClient(
      process.env.SUPABASE_URL || "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
        "service-role-key-from-supabase-status",
    )
  : null;

const TENANT_ID = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const AGENT_SLUG = "operator";
const SEEDED_TITLE = "test-episode-A1-bundle-a-loader-wire";
const SEEDED_BODY =
  "BUNDLE-A1-LOADER-CANARY-2026-05-27 — this is a seeded agent_experience note for the loadAgentEpisodic integration test. " +
  "Content here is opaque to the loader; the test only asserts the loader pulls it back.";

describe.skipIf(!isIntegration)("episodic context load (integration)", () => {
  beforeAll(async () => {
    if (!sb) return;
    await sb
      .from("tenants")
      .upsert(
        { id: TENANT_ID, slug: `bundle-a-test-${TENANT_ID.slice(0, 8)}`, display_name: "bundle-a-test" },
        { onConflict: "id" },
      );
    await sb.from("memory_note").insert({
      tenant_id: TENANT_ID,
      title: SEEDED_TITLE,
      body_markdown: SEEDED_BODY,
      source: "episode_distill",
      note_type: "agent_experience",
      agent_slug: AGENT_SLUG,
      trust_tier: 2,
    });
  });

  afterAll(async () => {
    if (!sb) return;
    await sb
      .from("memory_note")
      .delete()
      .eq("tenant_id", TENANT_ID)
      .eq("title", SEEDED_TITLE);
  });

  it("loadAgentEpisodic returns the seeded note's body, agent-slug-filtered", async () => {
    const { loadAgentEpisodic } = await import("../../services/memory/loader");
    const out = await loadAgentEpisodic(TENANT_ID, AGENT_SLUG);
    expect(out).toContain(SEEDED_TITLE);
    expect(out).toContain(SEEDED_BODY.slice(0, 60));
  });

  it("agent_slug filter excludes other agents' episodic notes", async () => {
    if (!sb) return;
    const OTHER_TITLE = "other-agent-episode-A1";
    await sb.from("memory_note").insert({
      tenant_id: TENANT_ID,
      title: OTHER_TITLE,
      body_markdown: "should NOT be returned for operator",
      source: "episode_distill",
      note_type: "agent_experience",
      agent_slug: "pm",
      trust_tier: 2,
    });

    try {
      const { loadAgentEpisodic } = await import("../../services/memory/loader");
      const out = await loadAgentEpisodic(TENANT_ID, AGENT_SLUG);
      expect(out).toContain(SEEDED_TITLE);
      expect(out).not.toContain(OTHER_TITLE);
      expect(out).not.toContain("should NOT be returned");
    } finally {
      await sb
        .from("memory_note")
        .delete()
        .eq("tenant_id", TENANT_ID)
        .eq("title", OTHER_TITLE);
    }
  });

  it("note_type filter excludes non-episodic notes for same agent", async () => {
    if (!sb) return;
    const PATTERN_TITLE = "pattern-not-episodic-A1";
    await sb.from("memory_note").insert({
      tenant_id: TENANT_ID,
      title: PATTERN_TITLE,
      body_markdown: "this is a pattern not an episodic note",
      source: "agent_write",
      note_type: "pattern",
      agent_slug: AGENT_SLUG,
      trust_tier: 2,
    });

    try {
      const { loadAgentEpisodic } = await import("../../services/memory/loader");
      const out = await loadAgentEpisodic(TENANT_ID, AGENT_SLUG);
      expect(out).toContain(SEEDED_TITLE);
      expect(out).not.toContain(PATTERN_TITLE);
    } finally {
      await sb
        .from("memory_note")
        .delete()
        .eq("tenant_id", TENANT_ID)
        .eq("title", PATTERN_TITLE);
    }
  });

  it("returns empty string when no episodic notes exist for the agent", async () => {
    const { loadAgentEpisodic } = await import("../../services/memory/loader");
    const FRESH_AGENT = "research";
    const out = await loadAgentEpisodic(TENANT_ID, FRESH_AGENT);
    expect(out).toBe("");
  });
});
