export function isHttpRoutePath(p: string): boolean {
  if (typeof p !== "string") return false;
  const s = p.toLowerCase();
  if (s.includes("__tests__") || /\.(test|spec)\.[tj]sx?$/.test(s)) return false;
  return (
    /(^|\/)routes\//.test(s) ||
    /(^|\/)(controllers|handlers)\//.test(s) ||
    /(^|\/)(app|pages)\/api\//.test(s) ||
    /(^|\/)route\.[tj]sx?$/.test(s) ||
    /(controller|handler|router)\.[tj]sx?$/.test(s)
  );
}
