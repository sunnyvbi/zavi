
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type AuthoringReferences = { technique: string; exemplar: string };

const TECHNIQUE_REL = join("references", "TECHNIQUE.md");
const EXEMPLAR_REL = join("examples", "authored-fernwork.tsx");

function findEnginePackageDir(): string | null {
  const explicit = (process.env.LAUNCH_VIDEO_ENGINE_DIR || "").trim();
  if (explicit && existsSync(join(explicit, TECHNIQUE_REL))) return explicit;

  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "packages", "launch-video");
    if (existsSync(join(candidate, TECHNIQUE_REL))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let cached: AuthoringReferences | null | undefined;

export function loadAuthoringReferences(): AuthoringReferences | null {
  if (cached !== undefined) return cached;
  const pkg = findEnginePackageDir();
  if (!pkg) {
    // eslint-disable-next-line no-console
    console.warn("[launch-video] authoring references not found; authored films disabled for this process");
    cached = null;
    return cached;
  }
  try {
    cached = {
      technique: readFileSync(join(pkg, TECHNIQUE_REL), "utf8"),
      exemplar: readFileSync(join(pkg, EXEMPLAR_REL), "utf8"),
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[launch-video] authoring references unreadable: ${(e as Error).message}`);
    cached = null;
  }
  return cached;
}

export function __resetAuthoringReferencesCache(): void {
  cached = undefined;
}
