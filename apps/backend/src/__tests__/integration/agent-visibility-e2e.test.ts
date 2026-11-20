
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createClient } from "@supabase/supabase-js";

const isIntegration = process.env.INTEGRATION === "1";
const sb = isIntegration
  ? createClient(
      process.env.SUPABASE_URL || "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
        "service-role-key-from-supabase-status",
    )
  : null;

const TENANT_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "33333333-3333-3333-3333-333333333333";

const DISABLED_SLUG = "agent-coach";
const ALWAYS_ON_SLUG = "engineer";

describe.skipIf(!isIntegration)(
  "agent visibility e2e (integration)",
  () => {
    beforeAll(async () => {
      await sb!
        .from("tenants")
        .upsert({
          id: TENANT_ID,
          slug: "qa-agent-visibility-fixture",
          display_name: "QA Agent Visibility",
        });
      await sb!
        .from("tenant_users")
        .upsert({
          tenant_id: TENANT_ID,
          user_id: USER_ID,
          role: "owner",
        });
    });

    beforeEach(async () => {
      await sb!
        .from("tenant_agent_kill_switch")
        .delete()
        .eq("tenant_id", TENANT_ID);
    });

    it("default-disabled agent + no override → resolver returns default_disabled", async () => {
      const { data } = await sb!
        .from("tenant_agent_kill_switch")
        .select("override_state")
        .eq("tenant_id", TENANT_ID)
        .eq("agent_slug", DISABLED_SLUG)
        .maybeSingle();
      expect(data).toBeNull();
    });

    it("tenant visible-override row enables dispatch (codex CX-4 fix)", async () => {
      const { error: insErr } = await sb!
        .from("tenant_agent_kill_switch")
        .insert({
          tenant_id: TENANT_ID,
          agent_slug: DISABLED_SLUG,
          source: "tenant",
          override_state: "visible",
          killed_by: USER_ID,
          reason: "test opt-in",
        });
      expect(insErr).toBeNull();

      const { data } = await sb!
        .from("tenant_agent_kill_switch")
        .select("override_state, source")
        .eq("tenant_id", TENANT_ID)
        .eq("agent_slug", DISABLED_SLUG)
        .maybeSingle();
      expect(data?.override_state).toBe("visible");
      expect(data?.source).toBe("tenant");

      const { data: killCheck } = await sb!
        .from("tenant_agent_kill_switch")
        .select("agent_slug")
        .eq("tenant_id", TENANT_ID)
        .eq("agent_slug", DISABLED_SLUG)
        .eq("override_state", "hidden")
        .maybeSingle();
      expect(killCheck).toBeNull();
    });

    it("always_on slug cannot be hidden via set_kill_switch RPC", async () => {
      const { error } = await sb!.rpc("set_kill_switch", {
        p_tenant_id: TENANT_ID,
        p_agent_slug: ALWAYS_ON_SLUG,
        p_kill: true,
        p_reason: "test always_on hide",
        p_override_state: "hidden",
        p_always_on_slugs: [ALWAYS_ON_SLUG],
      });
      expect(error).not.toBeNull();
      expect((error as { code?: string })?.code).toBe("42501");
    });

    it("always_on slug cannot be hidden via staff_set_tenant_agent_hidden RPC", async () => {
      const { error } = await sb!.rpc("staff_set_tenant_agent_hidden", {
        p_tenant_id: TENANT_ID,
        p_agent_slug: ALWAYS_ON_SLUG,
        p_hide: true,
        p_reason: "test staff always_on hide",
        p_override_state: "hidden",
        p_always_on_slugs: [ALWAYS_ON_SLUG],
      });
      expect(error).not.toBeNull();
      expect((error as { code?: string })?.code).toBe("42501");
      expect((error as { message?: string })?.message).toMatch(
        /always_on|locked visible/,
      );

      const { data } = await sb!
        .from("tenant_agent_kill_switch")
        .select("agent_slug")
        .eq("tenant_id", TENANT_ID)
        .eq("agent_slug", ALWAYS_ON_SLUG)
        .maybeSingle();
      expect(data).toBeNull();
    });

    it("staff_set_tenant_agent_hidden with p_hide=false on always_on is a no-op (not 42501)", async () => {
      const { error } = await sb!.rpc("staff_set_tenant_agent_hidden", {
        p_tenant_id: TENANT_ID,
        p_agent_slug: ALWAYS_ON_SLUG,
        p_hide: false,
        p_reason: null,
        p_override_state: "hidden",
        p_always_on_slugs: [ALWAYS_ON_SLUG],
      });
      expect(error).toBeNull();
    });

    it("staff_set_tenant_agent_hidden with p_override_state=visible writes the opt-in row", async () => {
      const { error } = await sb!.rpc("staff_set_tenant_agent_hidden", {
        p_tenant_id: TENANT_ID,
        p_agent_slug: DISABLED_SLUG,
        p_hide: true,
        p_reason: "test staff opt-in",
        p_override_state: "visible",
        p_always_on_slugs: [],
      });
      expect(error).toBeNull();

      const { data } = await sb!
        .from("tenant_agent_kill_switch")
        .select("override_state, source, reason")
        .eq("tenant_id", TENANT_ID)
        .eq("agent_slug", DISABLED_SLUG)
        .maybeSingle();
      expect(data).toMatchObject({
        override_state: "visible",
        source: "staff",
        reason: "test staff opt-in",
      });
    });
  },
);
