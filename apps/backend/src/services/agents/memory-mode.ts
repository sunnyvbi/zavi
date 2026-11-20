
export type MemoryModeCtx = { memory_mode?: "on" | "off" };

export function memoryOff(ctx: MemoryModeCtx): boolean {
  return ctx.memory_mode === "off";
}

export function readMemoryMode(payload: unknown): "off" | undefined {
  if (
    payload &&
    typeof payload === "object" &&
    (payload as { memory_mode?: unknown }).memory_mode === "off"
  ) {
    return "off";
  }
  return undefined;
}

const BRAIN_TOOL_PREFIXES = ["memory__", "brain__", "tenant_skill__"];

export function stripMemoryToolsIfOff<T extends { name: string }>(
  tools: T[],
  ctx: MemoryModeCtx,
): T[] {
  if (!memoryOff(ctx)) return tools;
  return tools.filter(
    (t) => !BRAIN_TOOL_PREFIXES.some((p) => t.name.startsWith(p)),
  );
}
