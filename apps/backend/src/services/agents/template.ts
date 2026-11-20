
export class UnresolvedPlaceholderError extends Error {
  constructor(unresolved: string[]) {
    super(
      `Unresolved template placeholders: ${unresolved.join(", ")}. ` +
        `Either add them to the context or remove them from the template.`,
    );
    this.name = "UnresolvedPlaceholderError";
  }
}

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

export function interpolate(
  template: string,
  ctx: Record<string, unknown>,
): string {
  const result = template.replace(PLACEHOLDER, (match, rawPath: string) => {
    const path = rawPath.trim();
    const value = getByPath(ctx, path);
    if (value === undefined || value === null) {
      return match;
    }
    return String(value);
  });

  const unresolved: string[] = [];
  for (const m of result.matchAll(PLACEHOLDER)) {
    unresolved.push(m[1].trim());
  }
  if (unresolved.length > 0) {
    throw new UnresolvedPlaceholderError([...new Set(unresolved)]);
  }
  return result;
}
