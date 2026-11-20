
import { scrubQueryForCapture } from "@/services/memory/eval-capture-scrub";

export const DELEGATION_CONTEXT_MAX_BYTES = 16 * 1024;

const RECENT_FINDING_TEXT_CAP = 2_000;
const RECALL_BODY_CAP = 1_500;
const THREAD_MESSAGE_CAP = 2_000;
const MAX_RECENT_FINDINGS = 6;
const MAX_RECALL_HITS = 6;
const MAX_THREAD_MESSAGES = 6;

export const TRUNCATION_MARKER = "[…delegation_context truncated to ~16KB]";

export type DelegationIncludeSlice = "recent_findings" | "recall" | "thread_excerpt";

export type RecentFinding = {
  tool_name: string;
  text: string;
  ts?: number;
};

export type RecallHit = {
  note_id: string;
  title: string;
  body: string;
};

export type ThreadMessageExcerpt = {
  role: "user" | "assistant" | string;
  text: string;
  ts?: number;
};

export type DelegationContextInput = {
  recent_findings?: readonly RecentFinding[];
  recall?: readonly RecallHit[];
  thread_excerpt?: readonly ThreadMessageExcerpt[];
  include?: readonly DelegationIncludeSlice[];
};

export type DelegationContextMode = "intent_only" | "full";

export type DelegationContextBundle = {
  mode: "full";
  built_at: number;
  included: DelegationIncludeSlice[];
  recent_findings?: RecentFinding[];
  recall?: RecallHit[];
  thread_excerpt?: ThreadMessageExcerpt[];
  truncated: boolean;
};

function shouldInclude(
  slice: DelegationIncludeSlice,
  include: readonly DelegationIncludeSlice[] | undefined,
): boolean {
  if (!include || include.length === 0) return true;
  return include.includes(slice);
}

function clip(text: string, max: number, truncFlag: { hit: boolean }): string {
  if (typeof text !== "string") return "";
  if (text.length <= max) return text;
  truncFlag.hit = true;
  return `${text.slice(0, Math.max(0, max - TRUNCATION_MARKER.length - 1))} ${TRUNCATION_MARKER}`;
}

function clipArray<T>(arr: readonly T[] | undefined, max: number, truncFlag: { hit: boolean }): T[] {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  if (arr.length <= max) return [...arr];
  truncFlag.hit = true;
  return arr.slice(arr.length - max);
}

function scrubFinding(f: RecentFinding, truncFlag: { hit: boolean }): RecentFinding {
  return {
    tool_name: typeof f.tool_name === "string" ? f.tool_name.slice(0, 80) : "",
    text: scrubQueryForCapture(clip(f.text ?? "", RECENT_FINDING_TEXT_CAP, truncFlag)),
    ...(typeof f.ts === "number" ? { ts: f.ts } : {}),
  };
}

function scrubRecall(r: RecallHit, truncFlag: { hit: boolean }): RecallHit {
  return {
    note_id: typeof r.note_id === "string" ? r.note_id.slice(0, 200) : "",
    title: scrubQueryForCapture(typeof r.title === "string" ? r.title.slice(0, 200) : ""),
    body: scrubQueryForCapture(clip(r.body ?? "", RECALL_BODY_CAP, truncFlag)),
  };
}

function scrubMsg(m: ThreadMessageExcerpt, truncFlag: { hit: boolean }): ThreadMessageExcerpt {
  return {
    role: typeof m.role === "string" ? m.role.slice(0, 16) : "user",
    text: scrubQueryForCapture(clip(m.text ?? "", THREAD_MESSAGE_CAP, truncFlag)),
    ...(typeof m.ts === "number" ? { ts: m.ts } : {}),
  };
}

export function buildDelegationContext(
  input: DelegationContextInput,
): DelegationContextBundle {
  const truncFlag = { hit: false };
  const include = input.include;

  const included: DelegationIncludeSlice[] = [];
  let findings: RecentFinding[] | undefined;
  let recall: RecallHit[] | undefined;
  let thread: ThreadMessageExcerpt[] | undefined;

  if (shouldInclude("recent_findings", include)) {
    const capped = clipArray(input.recent_findings, MAX_RECENT_FINDINGS, truncFlag);
    findings = capped.map((f) => scrubFinding(f, truncFlag));
    included.push("recent_findings");
  }
  if (shouldInclude("recall", include)) {
    const capped = clipArray(input.recall, MAX_RECALL_HITS, truncFlag);
    recall = capped.map((r) => scrubRecall(r, truncFlag));
    included.push("recall");
  }
  if (shouldInclude("thread_excerpt", include)) {
    const capped = clipArray(input.thread_excerpt, MAX_THREAD_MESSAGES, truncFlag);
    thread = capped.map((m) => scrubMsg(m, truncFlag));
    included.push("thread_excerpt");
  }

  const trySerialize = (): { bytes: number; ok: boolean } => {
    const obj: Omit<DelegationContextBundle, "built_at"> = {
      mode: "full",
      included,
      ...(findings ? { recent_findings: findings } : {}),
      ...(recall ? { recall } : {}),
      ...(thread ? { thread_excerpt: thread } : {}),
      truncated: truncFlag.hit,
    };
    const json = JSON.stringify(obj);
    return { bytes: json.length, ok: json.length <= DELEGATION_CONTEXT_MAX_BYTES };
  };

  let attempts = 0;
  while (attempts < 50) {
    const { ok } = trySerialize();
    if (ok) break;
    truncFlag.hit = true;
    if (recall && recall.length > 0) {
      recall.shift();
    } else if (thread && thread.length > 0) {
      thread.shift();
    } else if (findings && findings.length > 0) {
      findings.shift();
    } else {
      break;
    }
    attempts += 1;
  }

  return {
    mode: "full",
    built_at: Date.now(),
    included,
    ...(findings ? { recent_findings: findings } : {}),
    ...(recall ? { recall } : {}),
    ...(thread ? { thread_excerpt: thread } : {}),
    truncated: truncFlag.hit,
  };
}
