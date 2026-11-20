import { resolveStaffModel, isClaudeKey, STAFF_MODEL_NAMES } from "@/services/llm/staff-model-switch";
import type { CapResult } from "@/services/auth/staff-model-access";

export type StaffModelDecision =
  | { kind: "none" }
  | { kind: "stamp"; staff_model: { key: string } }
  | { kind: "reject"; status: 400 | 429 | 503; code: string; message: string };

export async function decideStaffModel(
  input: { raw: string | undefined; userId: string; tenantId: string },
  deps: {
    isOwnerOrAdmin: (userId: string, tenantId: string) => Promise<boolean>;
    checkCap: () => Promise<CapResult>;
    hasOpenRouterKey: () => boolean;
  },
): Promise<StaffModelDecision> {
  const raw = input.raw?.trim();
  if (!raw || isClaudeKey(raw)) return { kind: "none" };
  try {
    if (!(await deps.isOwnerOrAdmin(input.userId, input.tenantId))) return { kind: "none" };
  } catch (e) {
    console.warn(`[staff-model] gate read failed, ignoring ?model=: ${(e as Error).message}`);
    return { kind: "none" };
  }
  const m = resolveStaffModel(raw);
  if (!m) {
    return { kind: "reject", status: 400, code: "unknown_model", message: `Unknown model "${raw}". Use one of: ${STAFF_MODEL_NAMES.join(", ")}.` };
  }
  if (m.kind === "openrouter" && !deps.hasOpenRouterKey()) {
    return { kind: "reject", status: 503, code: "openrouter_not_configured", message: "OpenRouter is not configured on this server." };
  }
  const cap = await deps.checkCap();
  if (!cap.ok) {
    return { kind: "reject", status: 429, code: "staff_model_cap", message: `Daily ?model= test cap reached ($${cap.cap}). Raise staff_model_test_daily_usd or try tomorrow.` };
  }
  return { kind: "stamp", staff_model: { key: m.key } };
}
