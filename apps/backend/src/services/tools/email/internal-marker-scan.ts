
export type MarkerScanResult = {
  clean: string;
  stripped: string[];
  empty: boolean;
};

const INTERNAL_LINE_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "approval_queued", re: /queued for your approval/i },
  { name: "approval_url", re: /\/workspace\?tab=approvals/i },
  { name: "needs_you_url", re: /\/workspace\?tab=needs-you/i },
  { name: "decision_id", re: /\bdecision(?:_id)?\b\s*[`'"(:]/i },
  { name: "approve_cta", re: /^\s*approve (it )?(manually )?at\b/i },
  { name: "backstamp", re: /backstamp/i },
  { name: "praxis_tool", re: /\bpraxis__[a-z_]+/i },
  { name: "handoff_marker", re: /\bpraxis__handoff\b/i },
  { name: "run_id_marker", re: /\bagent_run(_id)?\b/i },
];

const REPLY_PREFIX = /^\s*\*{0,2}reply to\s+[^:]{1,120}:\*{0,2}\s*/i;

const MIN_MEANINGFUL_CHARS = 24;

export function scanInternalMarkers(body: string): MarkerScanResult {
  const stripped = new Set<string>();
  const kept: string[] = [];

  for (const line of (body ?? "").split("\n")) {
    const hit = INTERNAL_LINE_PATTERNS.find((p) => p.re.test(line));
    if (hit) {
      stripped.add(hit.name);
      continue;
    }
    kept.push(line);
  }

  let clean = kept.join("\n").trim();
  if (REPLY_PREFIX.test(clean)) {
    clean = clean.replace(REPLY_PREFIX, "").trim();
    stripped.add("reply_prefix");
  }
  clean = clean.replace(/\n{3,}/g, "\n\n").trim();

  return {
    clean,
    stripped: [...stripped],
    empty: clean.replace(/[\s*_`>-]/g, "").length < MIN_MEANINGFUL_CHARS,
  };
}
