
import { serviceClient } from "@/services/supabase";
import { logEvent } from "@/services/logging/logEvent";
import { getBoolSetting } from "@/services/settings";
import { asTenantId, tenantClient } from "@/services/tenant-client";
import { withGeneratedAppClient } from "@/services/website/app-data";
import {
  runAcceptanceBattery,
  ownerLoginSmokeCheck,
  type SmokeCheck,
  type FetchLike,
  type AcceptanceBatteryResult,
} from "@/services/provisioning/acceptance-gate";
import type { ConductorNode } from "@/services/agents/conductor";

export type AcceptanceGateMode = "off" | "shadow" | "enforce";

export function resolveAcceptanceGateMode(): AcceptanceGateMode {
  const raw = (process.env.BUILD_ACCEPTANCE_GATE_MODE ?? "").trim().toLowerCase();
  if (raw === "shadow") return "shadow";
  if (raw === "enforce") return "enforce";
  return "off";
}

export function acceptanceGateKilled(): boolean {
  return (process.env.BUILD_ACCEPTANCE_GATE_MODE ?? "").trim().toLowerCase() === "off";
}

export const BOOKING_SMOKE_CLAIM_KEY = "acceptance:booking_smoke";
export const OWNER_LOGIN_CLAIM_KEY = "acceptance:owner_login";

async function claimOnce(conductor_run_id: string, dedup_key: string): Promise<boolean> {
  const { error } = await serviceClient()
    .from("conductor_dispatch_claims")
    .insert({ conductor_run_id, dedup_key });
  return !error;
}

type SmokeInput = {
  tenant_id: string;
  conductor_run_id: string;
  node: ConductorNode;
  refine?: boolean;
};

function isFirstBuild(input: SmokeInput): boolean {
  if (input.refine === true) return false;
  return typeof (input.node.payload as { pre_refine_sha?: unknown } | undefined)?.pre_refine_sha !== "string";
}

async function hasEarlierFullBuild(input: SmokeInput): Promise<boolean> {
  try {
    const { data, error } = await tenantClient(asTenantId(input.tenant_id))
      .from("conductor_runs")
      .select("id")
      .eq("kind", "build_app")
      .eq("status", "done")
      .neq("id", input.conductor_run_id)
      .is("goal_graph->0->payload->>refine_mode", null)
      .limit(1);
    if (error) return true;
    return (data ?? []).length > 0;
  } catch {
    return true;
  }
}

async function bookingSmokeClaim(input: SmokeInput): Promise<(() => Promise<boolean>) | undefined> {
  if (!isFirstBuild(input)) return undefined;
  if (await hasEarlierFullBuild(input)) return undefined;
  const on = await getBoolSetting("build_booking_smoke", input.tenant_id).catch(() => false);
  if (!on) return undefined;
  return () => claimOnce(input.conductor_run_id, BOOKING_SMOKE_CLAIM_KEY).catch(() => false);
}

const SMOKE_USER_EMAIL_RE = /^zavi-smoke-[a-z0-9-]+@zavi\.invalid$/;

async function deleteAuthProbeUsers(input: SmokeInput): Promise<void> {
  try {
    await withGeneratedAppClient(asTenantId(input.tenant_id), (client) =>
      client.query("DELETE FROM public.users WHERE email LIKE 'acc-probe-%@zavi.invalid'"),
    );
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "acceptance_gate",
      code: "acceptance.auth_probe.cleanup_failed",
      tenant_id: input.tenant_id,
      run_id: input.conductor_run_id,
      error: e,
      meta: { tool_name: "acceptance_gate" },
    }).catch(() => {});
  }
}

async function deleteOwnerLoginSmokeUser(input: SmokeInput, email: string): Promise<void> {
  if (!SMOKE_USER_EMAIL_RE.test(email)) return;
  try {
    await withGeneratedAppClient(asTenantId(input.tenant_id), (client) =>
      client.query("DELETE FROM public.users WHERE email = $1", [email]),
    );
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "acceptance_gate",
      code: "acceptance.owner_login.cleanup_failed",
      tenant_id: input.tenant_id,
      run_id: input.conductor_run_id,
      error: e,
      meta: { tool_name: "acceptance_gate" },
    }).catch(() => {});
  }
}

function ownerLoginCheck(input: SmokeInput): SmokeCheck | undefined {
  if (!isFirstBuild(input)) return undefined;
  return ownerLoginSmokeCheck({
    runId: input.conductor_run_id,
    claim: () => claimOnce(input.conductor_run_id, OWNER_LOGIN_CLAIM_KEY).catch(() => false),
    cleanup: (email) => deleteOwnerLoginSmokeUser(input, email),
  });
}

export async function resolveTenantAcceptanceGate(
  tenant_id: string,
): Promise<{ mode: AcceptanceGateMode; smokeGate: boolean; smokeOnly: boolean }> {
  if (acceptanceGateKilled()) return { mode: "off", smokeGate: false, smokeOnly: false };
  const envMode = resolveAcceptanceGateMode();
  const smokeGate = await getBoolSetting("build_smoke_gate", tenant_id).catch(() => false);
  if (!smokeGate) return { mode: envMode, smokeGate: false, smokeOnly: false };
  if (envMode === "enforce") return { mode: "enforce", smokeGate: true, smokeOnly: false };
  return { mode: "enforce", smokeGate: true, smokeOnly: true };
}

function enforcedVerdict(result: AcceptanceBatteryResult, smokeOnly: boolean): AcceptanceBatteryResult {
  if (!smokeOnly) return result;
  const invariants = result.invariants.filter((i) => i.smoke);
  const firstFailure = invariants.find((i) => !i.pass)?.name ?? "";
  return { pass: firstFailure === "", invariants, firstFailure };
}

type ActiveMode = "shadow" | "enforce";

async function readLiveUrl(tenant_id: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("tenant_resources")
    .select("external_ref")
    .eq("tenant_id", tenant_id)
    .eq("resource_kind", "hosting")
    .eq("mode", "provisioned")
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) return "";
  const row =
    (data as Array<{ external_ref?: Record<string, unknown> | null }> | null)?.[0] ?? null;
  const url = row?.external_ref?.url;
  return typeof url === "string" ? url : "";
}

function slugFromUrl(url: string): string {
  try {
    return new URL(url).hostname.split(".")[0] ?? "";
  } catch {
    return "";
  }
}

const realFetch: FetchLike = (url, init) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  return fetch(url, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
    redirect: init?.redirect ?? "manual",
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t)) as unknown as ReturnType<FetchLike>;
};

async function logGateRun(args: {
  tenant_id: string;
  conductor_run_id: string;
  mode: ActiveMode;
  result: AcceptanceBatteryResult;
  shadow: AcceptanceBatteryResult | null;
  repairs: number;
}): Promise<void> {
  const passCount = args.result.invariants.filter((i) => i.pass).length;
  await logEvent({
    level: args.result.pass ? "info" : "warn",
    source: "acceptance_gate",
    code: `acceptance.${args.mode}.${args.result.pass ? "pass" : "fail"}`,
    tenant_id: args.tenant_id,
    run_id: args.conductor_run_id,
    meta: {
      tool_name: "acceptance_gate",
      acceptance_mode: args.mode,
      acceptance_verdict: args.result.pass ? "pass" : "fail",
      acceptance_failed_invariant: args.result.firstFailure || "none",
      acceptance_pass_count: passCount,
      acceptance_total: args.result.invariants.length,
      acceptance_repairs: args.repairs,
      ...(args.shadow
        ? {
            acceptance_shadow_verdict: args.shadow.pass ? "pass" : "fail",
            acceptance_shadow_failed_invariant: args.shadow.firstFailure || "none",
          }
        : {}),
    },
  });
}

export async function acceptanceProbe(input: {
  tenant_id: string;
  conductor_run_id: string;
  node: ConductorNode;
  refine?: boolean;
}): Promise<{ mode: ActiveMode; pass: boolean; signal: string }> {
  const { mode, smokeGate, smokeOnly } = await resolveTenantAcceptanceGate(input.tenant_id);
  if (mode === "off") return { mode: "shadow", pass: true, signal: "" };
  const active: ActiveMode = mode;

  try {
    const url = await readLiveUrl(input.tenant_id);
    if (!url) {
      await logEvent({
        level: "info",
        source: "acceptance_gate",
        code: `acceptance.${active}.skip_no_url`,
        tenant_id: input.tenant_id,
        run_id: input.conductor_run_id,
        meta: { tool_name: "acceptance_gate", acceptance_mode: active, acceptance_verdict: "skip" },
      });
      return { mode: active, pass: true, signal: "" };
    }

    const battery = await runAcceptanceBattery(
      {
        baseUrl: url,
        appSlug: slugFromUrl(url),
        smokeGate,
        claimBookingSmoke: smokeGate ? await bookingSmokeClaim(input) : undefined,
        ownerLoginCheck: smokeGate ? ownerLoginCheck(input) : undefined,
        starterDetailsCheck: isFirstBuild(input) && (await getBoolSetting("site_meta_and_404", input.tenant_id).catch(() => false)),
      },
      realFetch,
    ).finally(() => deleteAuthProbeUsers(input));
    const result = enforcedVerdict(battery, smokeOnly);
    const repairs =
      typeof input.node.acceptance_attempts === "number" ? input.node.acceptance_attempts : 0;
    await logGateRun({
      tenant_id: input.tenant_id,
      conductor_run_id: input.conductor_run_id,
      mode: active,
      result,
      shadow: smokeOnly ? battery : null,
      repairs,
    });

    const firstFail = result.invariants.find((i) => !i.pass);
    const signal = firstFail ? `${firstFail.name}: ${firstFail.evidence}` : "";
    return { mode: active, pass: result.pass, signal };
  } catch (e) {
    await logEvent({
      level: "warn",
      source: "acceptance_gate",
      code: `acceptance.${active}.error`,
      tenant_id: input.tenant_id,
      run_id: input.conductor_run_id,
      error: e,
      meta: { tool_name: "acceptance_gate", acceptance_mode: active },
    }).catch(() => {});
    return { mode: active, pass: true, signal: "" };
  }
}
