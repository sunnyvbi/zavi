import { logEvent } from "@/services/logging/logEvent";
import { attribute, type AttributeOutcome } from "./store";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function clickIdFrom(raw: unknown): string | null {
  return typeof raw === "string" && UUID_RE.test(raw.trim()) ? raw.trim().toLowerCase() : null;
}

export async function attributeTenant(args: {
  tenantId: string;
  click: unknown;
  door: "activate" | "build_start" | "checkout";
  email: string | null;
  userId: string | null;
  attributeFn?: typeof attribute;
}): Promise<AttributeOutcome | "no_click" | "error"> {
  const clickId = clickIdFrom(args.click);
  if (!clickId) return "no_click";
  try {
    const out = await (args.attributeFn ?? attribute)(args.tenantId, clickId, args.door, args.email, args.userId);
    void logEvent({
      level: "info",
      source: "affiliates",
      code: `affiliate.attribute.${out}`.slice(0, 64),
      message: `affiliate attribution at ${args.door}: ${out}`,
      tenant_id: args.tenantId,
    });
    return out;
  } catch (e) {
    void logEvent({
      level: "error",
      source: "affiliates",
      code: "affiliate.attribute_failed",
      message: `affiliate attribution at ${args.door} failed: ${(e as Error).message?.slice(0, 200)}`,
      tenant_id: args.tenantId,
    });
    return "error";
  }
}
