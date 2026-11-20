
export const BROADCAST_TRIGGERS: ReadonlySet<string> = new Set([
  "cron",
  "manual",
  "scheduled",
]);

export function isGenuineBroadcastTrigger(
  trigger: string | null | undefined,
): boolean {
  return typeof trigger === "string" && BROADCAST_TRIGGERS.has(trigger);
}
