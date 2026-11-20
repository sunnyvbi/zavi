
import { logEvent } from "@/services/logging/logEvent";

export type FailClosedMode = "shadow" | "warn" | "enforce";

const VALID_MODES: readonly FailClosedMode[] = ["shadow", "warn", "enforce"];

export function getCapabilityFailclosedMode(): FailClosedMode {
  const raw = (process.env.CAPABILITY_FAILCLOSED_MODE ?? "").trim().toLowerCase();
  return (VALID_MODES as readonly string[]).includes(raw)
    ? (raw as FailClosedMode)
    : "enforce";
}

export function isTenantFailclosedBypassed(
  tenant_id: string | null | undefined,
): boolean {
  if (!tenant_id) return false;
  const raw = process.env.CAPABILITY_FAILCLOSED_BYPASS_TENANTS ?? "";
  if (!raw.trim()) return false;
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(tenant_id);
}

export function shouldEnforceFailclosed(
  tenant_id?: string | null,
): boolean {
  if (isTenantFailclosedBypassed(tenant_id)) return false;
  return getCapabilityFailclosedMode() === "enforce";
}

export function resolveCapabilityFailclosedMode(
  tenant_id?: string | null,
): FailClosedMode {
  if (isTenantFailclosedBypassed(tenant_id)) return "shadow";
  return getCapabilityFailclosedMode();
}

export function capabilityFailclosedEnforces(
  tenant_id?: string | null,
): boolean {
  return shouldEnforceFailclosed(tenant_id);
}

export function logCapabilityWouldBlock(args: {
  tenant_id?: string | null;
  run_id?: string | null;
  server_id: string;
  tool_name: string;
  gate: string;
  agent_slug?: string;
}): void {
  const mode = getCapabilityFailclosedMode();
  void logEvent({
    level: "warn",
    source: "capability.failclosed",
    code: "would_block",
    message: `would_block gate=${args.gate} mode=${mode}`,
    tenant_id: args.tenant_id ?? null,
    run_id: args.run_id ?? null,
    meta: {
      server_id: args.server_id,
      tool_name: args.tool_name,
      ...(args.agent_slug ? { agent_slug: args.agent_slug } : {}),
    },
  });
}
