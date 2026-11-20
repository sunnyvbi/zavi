
export type RunOrigin = "standard" | "channel";

export function runOriginForTrigger(trigger: string | null | undefined): RunOrigin {
  return trigger === "channel_recipe" ? "channel" : "standard";
}
