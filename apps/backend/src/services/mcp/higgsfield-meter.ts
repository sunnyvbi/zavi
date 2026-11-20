
import { serviceClient } from "@/services/supabase";
import { isAllowedWriteTool } from "./write-allowlist";
import { deriveToolCapability } from "./tool-capability";

const METERED_SERVERS: ReadonlySet<string> = new Set<string>(["higgsfield"]);

const METERED_WRITE_TOOLS: Record<string, ReadonlySet<string>> = {
  higgsfield: new Set<string>(["generate_video", "generate_image"]),
};

const METERING_EXEMPT_TOOLS: Record<string, ReadonlySet<string>> = {
  higgsfield: new Set<string>(["generate_audio"]),
};

export function isMeteredWriteTool(server_id: string, real_tool_name: string): boolean {
  if (METERED_WRITE_TOOLS[server_id]?.has(real_tool_name)) return true;
  if (!METERED_SERVERS.has(server_id)) return false;
  if (METERING_EXEMPT_TOOLS[server_id]?.has(real_tool_name)) return false;
  if (!isAllowedWriteTool(server_id, real_tool_name)) return false;
  const cap = deriveToolCapability({ server_id, tool_name: real_tool_name });
  const isWrite = cap.write !== "no";
  const isMetered = cap.metered !== "no";
  return isWrite && isMetered;
}

export const DEFAULT_MEDIA_DAILY_CAP = 100;

export function resolveMediaDailyCap(): number {
  const raw = process.env.MEDIA_DAILY_GENERATE_CAP ?? process.env.HIGGSFIELD_DAILY_GENERATE_CAP;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MEDIA_DAILY_CAP;
  const n = Number(raw);
  if (n === 0) return 0;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MEDIA_DAILY_CAP;
}

export function utcDay(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function buildIdempotencyKey(run_id?: string, tool_use_id?: string): string {
  if (run_id && tool_use_id) return `${run_id}:${tool_use_id}`;
  return `nokey:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export type HiggsfieldGenerateDecision = "charged" | "already" | "over_cap";

export type PlatformGenerationSurface =
  | "pdf-image"
  | "blog-hero"
  | "lv-image"
  | "lv-video"
  | "lv-capture"
  | "gen-image"
  | "gen-video"
  | "gen-vo"
  | "gen-lipsync"
  | "gen-avatar"
  | "agent-image";

export type PlatformGateDecision = HiggsfieldGenerateDecision | "meter_error";

export type PlatformGate = {
  decision: PlatformGateDecision;
  idempotency_key: string;
  error?: string;
};

export async function meterPlatformGeneration(input: {
  tenant_id?: string | null;
  run_id?: string | null;
  surface: PlatformGenerationSurface;
  index: number | string;
}): Promise<PlatformGate> {
  const idempotency_key = `${input.run_id ?? "norun"}:${input.surface}:${input.index}`;
  if (!input.tenant_id || !input.run_id) {
    return {
      decision: "meter_error",
      idempotency_key,
      error: "missing tenant_id/run_id — refusing an unmeterable Higgsfield generation",
    };
  }
  try {
    const decision = await consumeHiggsfieldGenerateOrReject({
      tenant_id: input.tenant_id,
      idempotency_key,
      dailyCap: resolveMediaDailyCap(),
    });
    return { decision, idempotency_key };
  } catch (e) {
    return {
      decision: "meter_error",
      idempotency_key,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export type ConsumeHiggsfieldInput = {
  tenant_id: string;
  idempotency_key: string;
  dailyCap: number;
  day?: string;
};

export async function consumeHiggsfieldGenerateOrReject(
  input: ConsumeHiggsfieldInput,
): Promise<HiggsfieldGenerateDecision> {
  const { data, error } = await serviceClient().rpc("consume_higgsfield_generate_or_reject", {
    p_tenant_id: input.tenant_id,
    p_day: input.day ?? utcDay(),
    p_idempotency_key: input.idempotency_key,
    p_daily_cap: input.dailyCap,
  });
  if (error) {
    throw new Error(`consume_higgsfield_generate_or_reject failed: ${error.message}`);
  }
  return data as HiggsfieldGenerateDecision;
}
