import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { createClient } from "@supabase/supabase-js";

const isIntegration = process.env.INTEGRATION === "1";
const sb = isIntegration
  ? createClient(
      process.env.SUPABASE_URL || "http://127.0.0.1:54321",
      process.env.SUPABASE_SERVICE_ROLE_KEY || "service-role-key-from-supabase-status",
    )
  : null;

const TENANT_ID = "11111111-1111-1111-1111-111111111111";

describe.skipIf(!isIntegration)(
  "github default-repo refresh interaction (integration)",
  () => {
    beforeAll(async () => {
      await sb!
        .from("tenants")
        .upsert({ id: TENANT_ID, slug: "qa-default-repo-fixture", display_name: "QA" });
    });

    beforeEach(async () => {
      await sb!
        .from("connector_metadata")
        .delete()
        .eq("tenant_id", TENANT_ID)
        .eq("slug", "github");
      await sb!
        .from("tenant_config_audit")
        .delete()
        .eq("tenant_id", TENANT_ID)
        .eq("target", "github.default_repo");
    });

    it("default auto-clears when set_github_connection drops the repo from the array", async () => {
      const r1 = await sb!.rpc("set_github_connection", {
        p_tenant_id: TENANT_ID,
        p_installation_id: 999999,
        p_account_login: "acme",
        p_account_type: "Organization",
        p_repo_ids: [101, 102],
        p_repo_full_names: ["acme/web", "acme/api"],
        p_scopes: ["repo"],
      });
      expect(r1.error).toBeNull();

      const r2 = await sb!
        .from("connector_metadata")
        .update({ default_repo_full_name: "acme/web" })
        .eq("tenant_id", TENANT_ID)
        .eq("slug", "github");
      expect(r2.error).toBeNull();

      const r3 = await sb!.rpc("set_github_connection", {
        p_tenant_id: TENANT_ID,
        p_installation_id: 999999,
        p_account_login: "",
        p_account_type: "",
        p_repo_ids: [102],
        p_repo_full_names: ["acme/api"],
        p_scopes: ["repo"],
      });
      expect(r3.error, "set_github_connection MUST NOT fail the CHECK").toBeNull();

      const { data } = await sb!
        .from("connector_metadata")
        .select("default_repo_full_name, repo_full_names")
        .eq("tenant_id", TENANT_ID)
        .eq("slug", "github")
        .maybeSingle();
      expect(data?.default_repo_full_name).toBeNull();
      expect(data?.repo_full_names).toEqual(["acme/api"]);

      const audit = await sb!
        .from("tenant_config_audit")
        .select("action, prev_value, next_value, meta")
        .eq("tenant_id", TENANT_ID)
        .eq("target", "github.default_repo")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      expect(audit.data?.action).toBe("clear");
      expect(audit.data?.prev_value).toBe("acme/web");
      expect(audit.data?.meta).toMatchObject({ source: "set_github_connection_refresh" });
    });

    it("get_or_create_tenant_sandbox refuses unconnected repo", async () => {
      await sb!.rpc("set_github_connection", {
        p_tenant_id: TENANT_ID,
        p_installation_id: 999999,
        p_account_login: "acme",
        p_account_type: "Organization",
        p_repo_ids: [201],
        p_repo_full_names: ["acme/api"],
        p_scopes: ["repo"],
      });

      const r = await sb!.rpc("get_or_create_tenant_sandbox", {
        p_tenant_id: TENANT_ID,
        p_repo_full_name: "evil/exfil",
      });
      expect(r.error).not.toBeNull();
      expect(r.error?.message).toMatch(/not in tenant connected repos/);
    });
  },
);
