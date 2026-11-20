
import type { DispatcherResult } from "./types";

export const INNGEST_STEP_RETURN_BUDGET_BYTES = 512 * 1024;

const FILE_CONTENT_ELIDED = "[elided: full content persisted in the open_pr decision row]";
const RAW_RESPONSE_CAP_BYTES = 64 * 1024;
const PROMPT_SNAPSHOT_CAP_BYTES = 64 * 1024;
const TRUNCATION_MARKER = "\n…[truncated to keep the run-agent step under Inngest's payload limit; full text was not persisted]";

function byteLen(x: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(x) ?? "", "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function capString(s: string, capBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= capBytes) return s;
  let out = s.slice(0, capBytes);
  while (Buffer.byteLength(out, "utf8") > capBytes && out.length > 0) {
    out = out.slice(0, -1024);
  }
  return out + TRUNCATION_MARKER;
}

function elideParsedFileBodies(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object") return parsed;
  const p = parsed as Record<string, unknown>;
  const files = p.files;
  if (!Array.isArray(files)) return parsed;
  return {
    ...p,
    files: files.map((f) => {
      if (!f || typeof f !== "object") return f;
      const fc = f as Record<string, unknown>;
      const next: Record<string, unknown> = { ...fc };
      if (typeof fc.content === "string" && fc.content.length > 0) {
        next.content = FILE_CONTENT_ELIDED;
      }
      if (typeof fc.diff === "string" && fc.diff.length > 0) {
        next.diff = FILE_CONTENT_ELIDED;
      }
      return next;
    }),
  };
}

export function capDispatchResultForInngest(
  result: DispatcherResult,
  budgetBytes: number = INNGEST_STEP_RETURN_BUDGET_BYTES,
): DispatcherResult {
  if (byteLen(result) <= budgetBytes) return result;

  let trimmed: DispatcherResult = {
    ...result,
    parsed: elideParsedFileBodies(result.parsed),
  };
  if (byteLen(trimmed) <= budgetBytes) return trimmed;

  if (typeof trimmed.raw_response_text === "string") {
    trimmed = {
      ...trimmed,
      raw_response_text: capString(trimmed.raw_response_text, RAW_RESPONSE_CAP_BYTES),
    };
  }
  if (byteLen(trimmed) <= budgetBytes) return trimmed;

  if (typeof trimmed.prompt_snapshot === "string") {
    trimmed = {
      ...trimmed,
      prompt_snapshot: capString(trimmed.prompt_snapshot, PROMPT_SNAPSHOT_CAP_BYTES),
    };
  }
  return trimmed;
}
