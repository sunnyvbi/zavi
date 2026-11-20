
export function isBuilderClarifyEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BUILDER_CLARIFY !== "false";
}

export function isBuilderClarifyDynamicEnabled(): boolean {
  return process.env.NEXT_PUBLIC_BUILDER_CLARIFY_DYNAMIC !== "false";
}
