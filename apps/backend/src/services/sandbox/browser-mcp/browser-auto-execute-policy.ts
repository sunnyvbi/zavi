
export const AUTO_EXECUTE_BROWSER_AGENTS: ReadonlySet<string> = new Set<string>([]);

export function isAutoExecuteBrowserAgent(slug?: string): boolean {
  return (
    !!slug &&
    slug !== "" &&
    (AUTO_EXECUTE_BROWSER_AGENTS as ReadonlySet<string>).has(slug)
  );
}

export const AUTO_EXECUTE_OPS: ReadonlySet<string> = new Set([
  "click",
  "fill",
]);

export function isInlineAutoExecutableOp(opName?: string): boolean {
  return !!opName && AUTO_EXECUTE_OPS.has(opName);
}
