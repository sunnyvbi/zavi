
import { ExpectedToolError } from "@/services/tools/types";

export const DEPENDENCY_ALLOWLIST: ReadonlySet<string> = new Set([
  "@supabase/supabase-js",
  "next",
  "react",
  "react-dom",
  "@types/node",
  "@types/react",
  "@types/react-dom",
  "autoprefixer",
  "postcss",
  "tailwindcss",
  "typescript",
  "@radix-ui/react-slot",
  "tailwindcss-animate",
  "pg",
  "bcryptjs",
  "@types/pg",
  "@types/bcryptjs",
  "zod",
  "date-fns",
  "clsx",
  "tailwind-merge",
  "lucide-react",
  "class-variance-authority",
  "swr",
  "@tanstack/react-query",
]);

export const MIN_PACKAGE_AGE_DAYS = 90;
export const MIN_WEEKLY_DOWNLOADS = 1_000;

const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS_API = "https://api.npmjs.org/downloads/point/last-week";

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

async function fetchWithRetry(
  url: string,
  doFetch: typeof fetch,
  what: string,
): Promise<Response> {
  let last: Response | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, { method: "GET" });
    } catch (e) {
      if (attempt === MAX_ATTEMPTS - 1) {
        throw new ExpectedToolError(
          "registry_unreachable",
          `dependency admission: could not reach ${what} (${String(e)}). Failing closed — an ` +
            `unverified package is not admitted. Retry.`,
        );
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
      continue;
    }
    if (!RETRY_STATUSES.has(res.status)) return res;
    last = res;
    if (attempt < MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
  }
  throw new ExpectedToolError(
    "registry_unreachable",
    `dependency admission: ${what} returned HTTP ${last?.status} after ${MAX_ATTEMPTS} attempts ` +
      `(likely rate-limited). Failing closed. Retry.`,
  );
}

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export type RepoFileRead =
  | { kind: "found"; content: string }
  | { kind: "absent" }
  | { kind: "error"; detail: string };

export interface DependencyAdmissionDeps {
  fetchImpl?: typeof fetch;
  readRepoFile?: (path: string) => Promise<RepoFileRead>;
}

interface PackageJsonShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export function extractDependencies(pkg: PackageJsonShape): Array<[string, string]> {
  return [
    ...Object.entries(pkg.dependencies ?? {}),
    ...Object.entries(pkg.devDependencies ?? {}),
  ];
}

export function isExactPin(spec: string): boolean {
  return EXACT_VERSION_RE.test(spec.trim());
}

interface PackageLockShape {
  packages?: Record<
    string,
    {
      version?: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    }
  >;
}

export function siblingLockPath(pkgPath: string): string {
  return pkgPath.replace(/package\.json$/, "package-lock.json");
}

export function resolveLockEntry(
  packages: Record<string, unknown>,
  ownerPath: string,
  name: string,
): string | undefined {
  let dir = ownerPath;
  for (;;) {
    const candidate = dir === "" ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (packages[candidate] !== undefined) return candidate;
    if (dir === "") return undefined;
    const cut = dir.lastIndexOf("/node_modules/");
    dir = cut === -1 ? "" : dir.slice(0, cut);
  }
}

export function lockSyncFailures(pkg: PackageJsonShape, lock: PackageLockShape): string[] {
  if (lock.packages === undefined) return [];

  const packages = lock.packages;
  const root = packages[""] ?? {};
  const rootSpecs: Record<string, string> = { ...root.dependencies, ...root.devDependencies };
  const failures: string[] = [];

  for (const [name, spec] of extractDependencies(pkg)) {
    const locked = rootSpecs[name];
    if (locked === undefined) {
      failures.push(`"${name}" is declared in package.json but missing from the lock file`);
    } else if (locked !== spec) {
      failures.push(`"${name}" is "${spec}" in package.json but "${locked}" in the lock file`);
    } else if (packages[`node_modules/${name}`] === undefined) {
      failures.push(`"${name}" has no resolved entry ("node_modules/${name}") in the lock file`);
    }
  }

  for (const [entryPath, entry] of Object.entries(packages)) {
    for (const [optName, optSpec] of Object.entries(entry.optionalDependencies ?? {})) {
      const owner = entryPath === "" ? "the root package" : `"${entryPath}"`;
      const resolved = resolveLockEntry(packages, entryPath, optName);
      if (resolved === undefined) {
        failures.push(
          `${owner} declares optional dependency "${optName}" but the lock has no resolved ` +
            `entry for it — npm ci aborts with "Missing: ${optName} from lock file"`,
        );
        continue;
      }
      const lockedVersion = packages[resolved]?.version;
      if (isExactPin(optSpec) && lockedVersion !== undefined && lockedVersion !== optSpec) {
        failures.push(
          `${owner} declares optional dependency "${optName}" at "${optSpec}" but the lock ` +
            `resolves it to "${resolved}" at "${lockedVersion}"`,
        );
      }
    }
  }
  return failures;
}

export async function checkRegistry(
  name: string,
  deps: DependencyAdmissionDeps = {},
): Promise<string | null> {
  const doFetch = deps.fetchImpl ?? fetch;

  const metaRes = await fetchWithRetry(
    `${REGISTRY}/${encodeURIComponent(name)}`,
    doFetch,
    `the npm registry (verifying "${name}")`,
  );

  if (metaRes.status === 404) {
    return (
      `"${name}" does not exist on the npm registry (HTTP 404). This is a hallucinated ` +
      `package name. Do not invent dependencies — use a package you have verified exists.`
    );
  }
  if (!metaRes.ok) {
    throw new ExpectedToolError(
      "registry_unreachable",
      `dependency admission: npm registry returned HTTP ${metaRes.status} for "${name}". ` +
        `Failing closed. Retry.`,
    );
  }

  const meta = (await metaRes.json()) as { time?: Record<string, string> };
  const createdRaw = meta.time?.created;
  if (!createdRaw) {
    return `"${name}" has no creation timestamp on the registry — cannot establish provenance.`;
  }
  const ageDays = (Date.now() - new Date(createdRaw).getTime()) / 86_400_000;
  if (ageDays < MIN_PACKAGE_AGE_DAYS) {
    return (
      `"${name}" was first published ${Math.floor(ageDays)} days ago (minimum ${MIN_PACKAGE_AGE_DAYS}). ` +
      `A brand-new package matching a plausible-sounding name is the signature of a slopsquat ` +
      `(an attacker registering a name an LLM tends to hallucinate). Rejected.`
    );
  }

  const dlRes = await fetchWithRetry(
    `${DOWNLOADS_API}/${encodeURIComponent(name)}`,
    doFetch,
    `the npm downloads API (verifying "${name}")`,
  );
  if (!dlRes.ok) {
    throw new ExpectedToolError(
      "registry_unreachable",
      `dependency admission: npm downloads API returned HTTP ${dlRes.status} for "${name}". ` +
        `Failing closed. Retry.`,
    );
  }
  const dl = (await dlRes.json()) as { downloads?: number };
  if (typeof dl.downloads !== "number") {
    throw new ExpectedToolError(
      "registry_unreachable",
      `dependency admission: npm downloads API returned no download count for "${name}". ` +
        `Failing closed rather than assuming zero. Retry.`,
    );
  }
  const weekly = dl.downloads;
  if (weekly < MIN_WEEKLY_DOWNLOADS) {
    return (
      `"${name}" has ${weekly} weekly downloads (minimum ${MIN_WEEKLY_DOWNLOADS}). ` +
      `Effectively-unused packages are the slopsquat signature. Rejected.`
    );
  }

  return null;
}

export async function assertDependencyAdmission(
  files: ReadonlyArray<{ path: string; content?: string | null; action?: string }>,
  deps: DependencyAdmissionDeps = {},
): Promise<void> {
  const pkgFiles = files.filter(
    (f) =>
      (f.path === "package.json" || f.path.endsWith("/package.json")) &&
      f.action !== "delete" &&
      typeof f.content === "string",
  );
  if (pkgFiles.length === 0) return;

  for (const f of pkgFiles) {
    let pkg: PackageJsonShape;
    try {
      pkg = JSON.parse(f.content as string) as PackageJsonShape;
    } catch (e) {
      throw new ExpectedToolError(
        "invalid_package_json",
        `dependency admission: ${f.path} is not valid JSON (${String(e)}).`,
      );
    }

    for (const [name, spec] of extractDependencies(pkg)) {
      if (!isExactPin(spec)) {
        throw new ExpectedToolError(
          "dependency_not_pinned",
          `dependency admission: ${f.path} declares "${name}": "${spec}", which is not an exact ` +
            `version. Ranges and remote specs are mutable — tomorrow they can resolve to a ` +
            `different artifact than the one vetted today, defeating the lockfile. Pin exactly ` +
            `(e.g. "1.2.3").`,
        );
      }

      if (DEPENDENCY_ALLOWLIST.has(name)) continue;

      const reason = await checkRegistry(name, deps);
      if (reason) {
        throw new ExpectedToolError("dependency_rejected", `dependency admission: ${reason}`);
      }
    }

    const lockPath = siblingLockPath(f.path);
    const pushedLock = files.find(
      (l) => l.path === lockPath && l.action !== "delete" && typeof l.content === "string",
    );

    let lockSource: string;
    let lockRaw: string;
    if (pushedLock) {
      lockSource = `${lockPath} (in this push)`;
      lockRaw = pushedLock.content as string;
    } else if (deps.readRepoFile) {
      const existing = await deps.readRepoFile(lockPath);
      if (existing.kind === "error") {
        throw new ExpectedToolError(
          "lockfile_unverifiable",
          `dependency admission: could not read ${lockPath} to verify it still matches ${f.path} ` +
            `(${existing.detail}). Failing closed — an unverified lock is not admitted. Retry.`,
        );
      }
      if (existing.kind === "absent") continue;
      lockSource = `${lockPath} (already on the branch)`;
      lockRaw = existing.content;
    } else {
      throw new ExpectedToolError(
        "lockfile_missing",
        `dependency admission: ${f.path} is being written without ${lockPath}. The build runs ` +
          `\`npm ci\`, which refuses to install when the two disagree. Regenerate the lock ` +
          `(\`npm install --package-lock-only\`) and include ${lockPath} in the same push.`,
      );
    }

    let lock: PackageLockShape;
    try {
      lock = JSON.parse(lockRaw) as PackageLockShape;
    } catch (e) {
      if (!pushedLock) continue;
      throw new ExpectedToolError(
        "invalid_package_lock",
        `dependency admission: ${lockPath} is not valid JSON (${String(e)}).`,
      );
    }

    const failures = lockSyncFailures(pkg, lock);
    if (failures.length > 0) {
      throw new ExpectedToolError(
        "lockfile_out_of_sync",
        `dependency admission: ${f.path} does not match ${lockSource}, so \`npm ci\` would fail ` +
          `the build with EUSAGE. ${failures.join("; ")}. Run \`npm install --package-lock-only\` ` +
          `and push the regenerated ${lockPath} alongside ${f.path}.`,
      );
    }
  }
}
