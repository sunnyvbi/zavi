
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const SUPA_URL = process.env.SUPABASE_URL ?? "";
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const SUPA_ANON = process.env.SUPABASE_ANON_KEY ?? "";
const RUN_FLAG = process.env.RUN_DB_TESTS_AGAINST_PROD === "1";
const IS_PROD_URL = /wmycgyjsenvgtczlupoe/.test(SUPA_URL);
const SHOULD_RUN = RUN_FLAG && IS_PROD_URL && !!SUPA_SERVICE && !!SUPA_ANON;

type TenantConfig = {
  id: string;
  email: string;
  password: string;
  suffix: string;
};

function loadTenants(): TenantConfig[] {
  const t: TenantConfig[] = [];
  const upcarPw = process.env.QA_TEST_PASSWORD;
  const upcarEmail = process.env.QA_TEST_EMAIL;
  if (upcarPw && upcarEmail) {
    t.push({
      id: "73db45ff-457e-4541-bc8f-bdb625390204",
      email: upcarEmail,
      password: upcarPw,
      suffix: "73db45ff",
    });
  }
  const privatePw = process.env.QA_PRIVATE_TEST_PASSWORD;
  if (privatePw) {
    t.push({
      id: "e0fe9ea8-52e0-448e-80ff-5e68e8f81b3e",
      email: "ravi+private@upcar.ai",
      password: privatePw,
      suffix: "e0fe9ea8",
    });
  }
  const apnaPw = process.env.QA_APNA_TEST_PASSWORD;
  if (apnaPw) {
    t.push({
      id: "5f05d826-7793-45d1-88f9-c5c5bb3f0347",
      email: "ravi+apna@upcar.ai",
      password: apnaPw,
      suffix: "5f05d826",
    });
  }
  return t;
}

function svc(): SupabaseClient {
  return createClient(SUPA_URL, SUPA_SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signIn(email: string, password: string): Promise<string | null> {
  const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: SUPA_ANON,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token?: string };
  return body.access_token ?? null;
}

function userClient(jwt: string): SupabaseClient {
  return createClient(SUPA_URL, SUPA_ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

const RUN_TAG = randomUUID().slice(0, 8);

describe.skipIf(!SHOULD_RUN)(
  "slack_channels RLS . per-tenant isolation (PROD-gated, runs on RUN_DB_TESTS_AGAINST_PROD=1 + prod SUPABASE_URL)",
  () => {
    const tenants = loadTenants();

    const insertedChannelIds = new Map<string, string>();

    beforeAll(async () => {
      if (tenants.length < 2) {
        // eslint-disable-next-line no-console
        console.warn(
          `[slack_channels_rls] only ${tenants.length} tenant(s) resolved (need ≥2 to verify cross-tenant isolation). Skipping inserts. Set QA_TEST_PASSWORD, QA_PRIVATE_TEST_PASSWORD, QA_APNA_TEST_PASSWORD in apps/backend/.env to enable full coverage.`,
        );
        return;
      }
      const sb = svc();
      await sb
        .from("slack_channels")
        .delete()
        .like("channel_id", "TEST_RLS_%");

      for (const t of tenants) {
        const channelId = `TEST_RLS_${t.suffix}_${RUN_TAG}`;
        insertedChannelIds.set(t.id, channelId);
        const { error } = await sb.from("slack_channels").insert({
          tenant_id: t.id,
          channel_id: channelId,
          name: `test-rls-${t.suffix}`,
        });
        if (error) {
          throw new Error(
            `seed insert failed for tenant ${t.id}: ${error.message}`,
          );
        }
      }
    });

    afterAll(async () => {
      const sb = svc();
      await sb
        .from("slack_channels")
        .delete()
        .like("channel_id", "TEST_RLS_%");
    });

    it("each tenant's user-scoped JWT sees ONLY its own tenant's slack_channels row", async () => {
      if (tenants.length < 2) {
        // eslint-disable-next-line no-console
        console.warn(
          "[slack_channels_rls] skipping cross-tenant assertion . need ≥2 resolvable tenants.",
        );
        return;
      }
      for (const t of tenants) {
        const jwt = await signIn(t.email, t.password);
        if (!jwt) {
          // eslint-disable-next-line no-console
          console.warn(
            `[slack_channels_rls] could not sign in ${t.email}; skipping tenant ${t.id}`,
          );
          continue;
        }
        const ub = userClient(jwt);
        const { data, error } = await ub
          .from("slack_channels")
          .select("tenant_id, channel_id")
          .like("channel_id", "TEST_RLS_%");
        expect(error).toBeNull();
        const rows = data ?? [];
        for (const row of rows) {
          expect(row.tenant_id).toBe(t.id);
        }
        const expectedChannelId = insertedChannelIds.get(t.id);
        expect(rows.map((r) => r.channel_id)).toContain(expectedChannelId);
      }
    });

    it("no tenant can see another tenant's row (cross-tenant negative)", async () => {
      if (tenants.length < 2) return;
      for (const viewer of tenants) {
        const jwt = await signIn(viewer.email, viewer.password);
        if (!jwt) continue;
        const ub = userClient(jwt);
        const { data, error } = await ub
          .from("slack_channels")
          .select("channel_id")
          .like("channel_id", "TEST_RLS_%");
        expect(error).toBeNull();
        const seenIds = (data ?? []).map((r) => r.channel_id);
        for (const other of tenants) {
          if (other.id === viewer.id) continue;
          const forbidden = insertedChannelIds.get(other.id);
          expect(seenIds).not.toContain(forbidden);
        }
      }
    });
  },
);
