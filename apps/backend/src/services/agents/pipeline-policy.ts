
export const PROTECTED_PATH_HOLD_REASON = "protected_path" as const;

export type PreviewPolicy = "branch_preview" | "none";

export type AppPipelinePolicy = {
  protected_globs: string[];
  freeze: boolean;
  preview: PreviewPolicy;
};

export const CORE_PROTECTED_GLOBS: readonly string[] = [
  "**/.env*",
  "**/secrets/**",
  "supabase/migrations/**",
  "**/auth/**",
] as const;

export const DEFAULT_PROTECTED_GLOBS: readonly string[] = [
  ...CORE_PROTECTED_GLOBS,
  "**/middleware/**",
  "**/billing/**",
  "**/webhooks/**",
] as const;

export const DEFAULT_APP_PIPELINE_POLICY: AppPipelinePolicy = {
  protected_globs: [],
  freeze: false,
  preview: "branch_preview",
};

const MAX_APP_PROTECTED_GLOBS = 100;

export function parseAppPipelinePolicy(external_ref: unknown): AppPipelinePolicy {
  const ref =
    external_ref && typeof external_ref === "object" && !Array.isArray(external_ref)
      ? (external_ref as Record<string, unknown>)
      : {};
  const protected_globs = Array.isArray(ref.protected_globs)
    ? (ref.protected_globs as unknown[])
        .filter((g): g is string => typeof g === "string" && g.trim().length > 0)
        .map((g) => g.trim())
        .slice(0, MAX_APP_PROTECTED_GLOBS)
    : [];
  const freeze = ref.freeze === true;
  const preview: PreviewPolicy = ref.preview_policy === "none" ? "none" : "branch_preview";
  return { protected_globs, freeze, preview };
}

export function resolveProtectedGlobs(policy: AppPipelinePolicy): string[] {
  const set = new Set<string>(DEFAULT_PROTECTED_GLOBS);
  for (const g of policy.protected_globs) {
    if (typeof g === "string" && g.trim().length > 0) set.add(g.trim());
  }
  return [...set];
}

export function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\/+/, "").trim();
}

function globToRegExp(glob: string): RegExp {
  let out = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (".+?^${}()|[]\\".indexOf(c) !== -1) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  out += "$";
  return new RegExp(out);
}

export function matchProtectedGlob(path: string, globs: string[]): string | null {
  const p = normalizeRepoPath(path);
  if (!p) return null;
  for (const g of globs) {
    if (typeof g !== "string" || g.length === 0) continue;
    if (globToRegExp(g).test(p)) return g;
  }
  return null;
}

export type ProtectedPathHit = { path: string; glob: string };

export function findProtectedPathHits(
  paths: Array<string | null | undefined>,
  globs: string[],
): ProtectedPathHit[] {
  const seen = new Set<string>();
  const hits: ProtectedPathHit[] = [];
  for (const raw of paths) {
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    const norm = normalizeRepoPath(raw);
    if (!norm || seen.has(norm)) continue;
    const glob = matchProtectedGlob(norm, globs);
    if (glob) {
      seen.add(norm);
      hits.push({ path: norm, glob });
    }
  }
  return hits;
}

export function coerceProtectedPathHits(value: unknown): ProtectedPathHit[] {
  if (!Array.isArray(value)) return [];
  const out: ProtectedPathHit[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const path = (v as { path?: unknown }).path;
    const glob = (v as { glob?: unknown }).glob;
    if (typeof path === "string" && path.trim().length > 0) {
      out.push({ path: path.trim(), glob: typeof glob === "string" ? glob : "" });
    }
  }
  return out;
}

export function describeProtectedHits(hits: ProtectedPathHit[]): string {
  if (hits.length === 0) return "";
  const shown = hits.slice(0, 8).map((h) => `\`${h.path}\` (${h.glob})`);
  const more = hits.length > shown.length ? ` +${hits.length - shown.length} more` : "";
  return shown.join(", ") + more;
}
