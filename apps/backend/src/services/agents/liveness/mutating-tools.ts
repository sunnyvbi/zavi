
export function parseToolName(raw: string): { area: string; verb: string } {
  const name = String(raw ?? "").toLowerCase().trim();
  const segs = name.split("__").filter((s) => s.length > 0);
  const verb = segs.length > 0 ? segs[segs.length - 1] : name;
  const area = segs.length >= 2 ? segs[segs.length - 2] : "";
  return { area, verb };
}

const LOW_SIGNAL_AREA_RE = /^(memory|brain)$/;
const LOW_SIGNAL_VERB_RE = /(anchor|distill)/;

const PROPOSE_VERB_RE = /^propose(_|$)/;

const MUTATING_AREA_VERBS: Record<string, RegExp> = {
  slack: /^(post_message|upload_file)$/,
  stripe: /^(create_payment|remit_to_tenant|submit_dispute_evidence)$/,
  email: /^(send|send_email)$/,
  provision: /.*/,
  github: /^(open_pr|create|write|commit|push|merge|update|create_pr|update_pr)$/,
  meta_ads: /^(create|update|pause|edit|delete)(_|$)/,
  google_ads: /^(create|update|pause|edit|delete)(_|$)/,
  paid_acquisition: /^(create|update|pause|edit|delete)(_|$)/,
  operator_db: /^(insert|update|write|create|delete|mutate)(_|$)/,
  outbound: /^(send)(_|$)/,
};

const MUTATING_VERB_ANYAREA_RE =
  /^(post_message|upload_file|create_payment|remit_to_tenant|submit_dispute_evidence|open_pr)$/;

export function isMutatingToolName(raw: string): boolean {
  const { area, verb } = parseToolName(raw);
  if (!verb) return false;
  if (LOW_SIGNAL_AREA_RE.test(area) || LOW_SIGNAL_VERB_RE.test(verb)) return false;
  if (PROPOSE_VERB_RE.test(verb)) return false;
  const areaRe = MUTATING_AREA_VERBS[area];
  if (areaRe && areaRe.test(verb)) return true;
  if (MUTATING_VERB_ANYAREA_RE.test(verb)) return true;
  return false;
}

export function hasMutatingSideEffect(
  toolCalls: ReadonlyArray<{ name?: string | null; status?: string | null }> | null | undefined,
): boolean {
  if (!Array.isArray(toolCalls)) return false;
  for (const t of toolCalls) {
    if (t && t.status === "ok" && typeof t.name === "string" && isMutatingToolName(t.name)) {
      return true;
    }
  }
  return false;
}
