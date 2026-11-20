import { readStaffModelOverride } from "@/services/agents/engine/staff-model-override";

export function modelUsedFor(payload: unknown, declared: string): string {
  return readStaffModelOverride(payload)?.model_id ?? declared;
}

export function routingForPersist<R>(payload: unknown, routing: R | null): R | null {
  return readStaffModelOverride(payload) ? null : routing;
}
