
import { inngest } from "../client";
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import {
  getRenderCustomDomainStatus,
  verifyRenderCustomDomain,
} from "@/services/provisioning/render-custom-domain";
import { ensureDnsCname } from "@/services/provisioning/cloudflare-dns";
import { builtinBaseDomain } from "@/services/provisioning/builtin-url";
import {
  advanceBuiltinDomain,
  type BuiltinDomainRow,
  type BuiltinHealDeps,
} from "@/services/provisioning/builtin-domain-heal";
import { CredentialNotConfigured } from "@/services/provisioning/github-repo";

const MAX_ROWS_PER_RUN = 200;
const MAX_ATTEMPTS = 96;

type PendingRow = {
  id: string;
  render_service_id: string;
  render_custom_domain_id: string | null;
  hostname: string;
  status: string;
  attempts: number | null;
};

export const customDomainVerifySweepFn = inngest.createFunction(
  { id: "custom-domain-verify-sweep" },
  { cron: "*/15 * * * *" },
  async ({ logger }) => {
    if (process.env.PRAXIS_CUSTOM_DOMAIN_SWEEP_ENABLED === "0") {
      logger.info("custom-domain-verify-sweep: disabled via env");
      return { checked: 0, verified: 0, pending: 0, failed: 0 };
    }

    const sb = serviceClient();
    const nowIso = new Date().toISOString();

    const { data, error } = await sb
      .from("tenant_custom_domains")
      .select("id, render_service_id, render_custom_domain_id, hostname, status, attempts")
      .in("status", ["dns_required", "verifying"])
      .or(`next_check_at.is.null,next_check_at.lte.${nowIso}`)
      .limit(MAX_ROWS_PER_RUN);

    if (error) {
      logger.error(`custom-domain-verify-sweep: query failed: ${error.message}`);
      throw new Error(`custom-domain-verify-sweep query failed: ${error.message}`);
    }

    const rows = (data ?? []) as PendingRow[];
    let verified = 0;
    let pending = 0;
    let failed = 0;

    for (const row of rows) {
      const attempts = (row.attempts ?? 0) + 1;
      try {
        const rs = await getRenderCustomDomainStatus(
          row.render_service_id,
          row.render_custom_domain_id ?? row.hostname,
        );
        if (rs === "verified") {
          await sb.rpc("set_tenant_custom_domain_state", {
            p_id: row.id,
            p_status: "verified",
            p_next_check_at: null,
            p_last_error: null,
          });
          verified++;
        } else if (attempts >= MAX_ATTEMPTS) {
          await sb.rpc("set_tenant_custom_domain_state", {
            p_id: row.id,
            p_status: "failed",
            p_attempts: attempts,
            p_next_check_at: null,
            p_last_error: "Domain didn't verify in time — double-check the DNS record at your registrar.",
          });
          failed++;
        } else {
          const delayMin = 15 * Math.min(attempts, 8);
          const next = new Date(Date.now() + delayMin * 60_000).toISOString();
          await sb.rpc("set_tenant_custom_domain_state", {
            p_id: row.id,
            p_status: "verifying",
            p_attempts: attempts,
            p_next_check_at: next,
            p_last_error: null,
          });
          pending++;
        }
      } catch (e) {
        if (e instanceof CredentialNotConfigured) {
          logger.warn("custom-domain-verify-sweep: RENDER_API_KEY not configured — stopping sweep");
          break;
        }
        const next = new Date(Date.now() + 30 * 60_000).toISOString();
        await sb.rpc("set_tenant_custom_domain_state", {
          p_id: row.id,
          p_status: row.status,
          p_attempts: attempts,
          p_next_check_at: next,
          p_last_error: (e as Error).message.slice(0, 300),
        });
        pending++;
      }
    }

    let builtinVerified = 0;
    const { data: builtinRows } = await sb
      .from("tenant_resources")
      .select("tenant_id, external_ref")
      .eq("resource_kind", "domain")
      .eq("mode", "provisioned")
      .or("external_ref->>status.eq.verifying,external_ref->>status.is.null")
      .limit(MAX_ROWS_PER_RUN);
    const healDeps: BuiltinHealDeps = {
      baseDomain: builtinBaseDomain(),
      async loadHosting(tenant_id) {
        const { data } = await sb
          .from("tenant_resources")
          .select("external_ref")
          .eq("tenant_id", tenant_id)
          .eq("resource_kind", "hosting")
          .maybeSingle();
        const ref = ((data as { external_ref?: Record<string, unknown> | null } | null)?.external_ref ?? {}) as Record<string, unknown>;
        return {
          serviceId: typeof ref.render_service_id === "string" ? ref.render_service_id : null,
          url: typeof ref.url === "string" ? ref.url : null,
        };
      },
      ensureCname: (hostname, target) => ensureDnsCname(hostname, target, {}, false, { onlyReplaceOnrender: true }),
      renderStatus: (serviceId, idOrHost) => getRenderCustomDomainStatus(serviceId, idOrHost),
      requestVerify: (serviceId, customDomainId) => verifyRenderCustomDomain(serviceId, customDomainId),
      async save(tenant_id, external_ref) {
        const { error } = await sb.rpc("set_tenant_resource", {
          p_tenant_id: tenant_id,
          p_resource_kind: "domain",
          p_mode: "provisioned",
          p_status: "ready",
          p_provider: "render+cloudflare",
          p_external_ref: external_ref,
          p_vault_key: null,
        });
        if (error) throw new Error(`set_tenant_resource (domain) failed: ${error.message}`);
      },
    };
    for (const br of (builtinRows ?? []) as BuiltinDomainRow[]) {
      try {
        if ((await advanceBuiltinDomain(br, healDeps)) === "live") builtinVerified++;
      } catch (e) {
        if (e instanceof CredentialNotConfigured) break;
        logger.warn(
          `custom-domain-verify-sweep: builtin heal failed for tenant ${br.tenant_id}: ${(e as Error).message}`,
        );
      }
    }

    logger.info(
      `custom-domain-verify-sweep: checked ${rows.length} (verified ${verified}, pending ${pending}, failed ${failed}); builtin verified ${builtinVerified}`,
    );
    await logEvent({
      level: "info",
      source: "custom-domain-verify-sweep",
      code: "swept",
      meta: { checked: rows.length, verified, pending, failed, builtin_verified: builtinVerified },
    });

    return { checked: rows.length, verified, pending, failed, builtin_verified: builtinVerified };
  },
);
