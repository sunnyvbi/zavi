
import { validateRoutineSpec } from "./routine-spec";

export type RoutineTrustLevel = "markdown_only" | "assets" | "scripts_executables";

const EXECUTABLE_SIGNAL_KEYS = new Set([
  "tool",
  "tools",
  "steps",
  "step",
  "run",
  "exec",
  "cmd",
  "command",
  "script",
  "scripts",
  "shell",
  "bash",
  "code",
  "entrypoint",
]);

const ASSET_SIGNAL_KEYS = new Set(["assets", "asset", "files", "file", "attachments", "resources"]);

const MAX_SCAN_DEPTH = 8;

interface ScanResult {
  exec: boolean;
  asset: boolean;
}

function scanContent(v: unknown, depth: number): ScanResult {
  if (depth > MAX_SCAN_DEPTH) return { exec: true, asset: false };
  if (v === null || typeof v !== "object") return { exec: false, asset: false };
  if (Array.isArray(v)) {
    let exec = false;
    let asset = false;
    for (const el of v) {
      const r = scanContent(el, depth + 1);
      exec = exec || r.exec;
      asset = asset || r.asset;
    }
    return { exec, asset };
  }
  let exec = false;
  let asset = false;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (EXECUTABLE_SIGNAL_KEYS.has(k)) exec = true;
    if (ASSET_SIGNAL_KEYS.has(k)) asset = true;
    const r = scanContent(val, depth + 1);
    exec = exec || r.exec;
    asset = asset || r.asset;
  }
  return { exec, asset };
}

export function deriveRoutineTrustLevel(content: unknown): RoutineTrustLevel {
  if (validateRoutineSpec(content).ok) return "scripts_executables";

  if (typeof content === "string") return "markdown_only";

  if (typeof content !== "object" || content === null) return "scripts_executables";

  const { exec, asset } = scanContent(content, 0);
  if (exec) return "scripts_executables";

  return asset ? "assets" : "markdown_only";
}

export function requiresExecutableGauntlet(level: RoutineTrustLevel): boolean {
  return level === "scripts_executables";
}
