
export type EnvelopeCoercion = { value: unknown; notes: string[] };

export type DisplayCap =
  | number
  | { max: number; direction: "head" | "tail" | "empty" }
  | { maxItems: number };

const isItemCap = (c: DisplayCap): c is { maxItems: number } =>
  typeof c === "object" && "maxItems" in c;
const capMax = (c: DisplayCap): number =>
  typeof c === "number" ? c : isItemCap(c) ? c.maxItems : c.max;
const capDirection = (c: DisplayCap): "head" | "tail" | "empty" =>
  typeof c === "number" || isItemCap(c) ? "head" : c.direction;

const ADVICE_ENVELOPE_CAPS: Record<string, DisplayCap> = {
  rendered_markdown: 20000,
  "diagnosis.goal_restated": 500,
  "diagnosis.key_signals[]": 600,
  "research_findings[].summary": 1200,
  "recommendations.decide_today[].title": 180,
  "recommendations.decide_today[].rationale": 1200,
  "recommendations.decide_today[].estimated_impact": 1200,
  "recommendations.decide_today[].disconfirming_signal": 600,
  "recommendations.next_30d[].title": 180,
  "recommendations.next_30d[].rationale": 1200,
  "recommendations.next_30d[].estimated_impact": 1200,
  "recommendations.watch_for[].trigger": 600,
  "recommendations.watch_for[].what_to_do": 600,
  "recommendations.lead_priority": 300,
  "recommendations.deprioritize[]": 200,
  "dispatch_proposals[].brief": 1200,
  "dispatch_proposals[].why": 400,
  "dissent.what_not_to_do": 600,
  "dissent.why": 400,
  "recommendations.decide_today": { maxItems: 5 },
  "recommendations.deprioritize": { maxItems: 3 },
  "clarifications_needed.questions[]": 400,
  "clarifications_needed.questions": { maxItems: 5 },
};

const SEO_GEO_CAPS: Record<string, DisplayCap> = {
  ...ADVICE_ENVELOPE_CAPS,
  "diagnosis.key_signals": { maxItems: 8 },
  research_findings: { maxItems: 8 },
  "recommendations.next_30d": { maxItems: 8 },
  "recommendations.watch_for": { maxItems: 5 },
};

const DISPLAY_CAPS: Record<string, Record<string, DisplayCap>> = {
  engineer: {
    title: 120,
    rendered_markdown: 4000,
    body: 8000,
    customer_summary: 600,
    "diagnosis.not_reproduced_reason": 500,
    "test_results.output_tail": { max: 4000, direction: "tail" },
  },
  advisor: ADVICE_ENVELOPE_CAPS,
  "seo-geo": SEO_GEO_CAPS,
  fundraising: {
    "investors[].fit_rationale": 600,
    "investors[].evidence_text": { max: 600, direction: "empty" },
    "investors[].evidence_span": { max: 400, direction: "empty" },
    "deep.who_they_are": 6000,
    "deep.why_this_company": 6000,
    "deep.how_to_reach.warm_path": 2000,
    "deep.how_to_reach.best_channel": 300,
    "deep.how_to_reach.who_to_go_through": 1000,
    "deep.draft_message": 6000,
    "deep.no_draft_reason": 600,
    "deep.pushbacks[].objection": 600,
    "deep.pushbacks[].honest_answer": 2000,
    "deep.pushbacks": { maxItems: 8 },
    "deep.sources[].claim": 600,
  },
  pm: {
    rendered_markdown: 16000,
    "backlog[].reversal_trigger": 300,
    "strategy.reframe_options[].reversal_trigger": 300,
    "strategy.reframe_options[].metrics": { maxItems: 6 },
  },
  research: {
    "validation[].text": 600,
    "blocks[].chips[].text": 600,
  },
};

function truncated(
  v: string,
  cap: number,
  direction: "head" | "tail" | "empty" = "head",
): string | null {
  if (v.length <= cap) return null;
  if (direction === "empty") return "";
  return direction === "tail"
    ? "…" + v.slice(v.length - (cap - 3))
    : v.slice(0, cap - 3) + "…";
}

function coercePath(
  root: Record<string, unknown>,
  path: string,
  cap: number,
  direction: "head" | "tail" | "empty" = "head",
): number {
  const segments = path.split(".");

  function walk(node: unknown, depth: number): number {
    if (depth === segments.length) {
      return 0;
    }
    let seg = segments[depth];
    const isArray = seg.endsWith("[]");
    if (isArray) seg = seg.slice(0, -2);

    const isLast = depth === segments.length - 1;

    if (isArray && isLast) {
      const container =
        node && typeof node === "object"
          ? (node as Record<string, unknown>)[seg]
          : undefined;
      if (!Array.isArray(container)) return 0;
      let n = 0;
      for (let i = 0; i < container.length; i++) {
        if (typeof container[i] === "string") {
          const t = truncated(container[i] as string, cap, direction);
          if (t !== null) {
            container[i] = t;
            n++;
          }
        }
      }
      return n;
    }

    const child =
      node && typeof node === "object"
        ? (node as Record<string, unknown>)[seg]
        : undefined;

    if (!isArray && isLast) {
      if (
        child !== undefined &&
        typeof child === "string" &&
        node &&
        typeof node === "object"
      ) {
        const t = truncated(child, cap, direction);
        if (t !== null) {
          (node as Record<string, unknown>)[seg] = t;
          return 1;
        }
      }
      return 0;
    }

    if (isArray) {
      if (!Array.isArray(child)) return 0;
      let n = 0;
      for (const el of child) n += walk(el, depth + 1);
      return n;
    }

    return walk(child, depth + 1);
  }

  return walk(root, 0);
}

function coerceArrayPath(
  root: Record<string, unknown>,
  path: string,
  maxItems: number,
): number {
  const segments = path.split(".");

  function walk(node: unknown, depth: number): number {
    if (!node || typeof node !== "object") return 0;
    let seg = segments[depth];
    const isArrayHop = seg.endsWith("[]");
    if (isArrayHop) seg = seg.slice(0, -2);
    const child = (node as Record<string, unknown>)[seg];
    const isLast = depth === segments.length - 1;

    if (isLast) {
      if (!Array.isArray(child)) return 0;
      if (child.length <= maxItems) return 0;
      child.splice(maxItems);
      return 1;
    }

    if (isArrayHop) {
      if (!Array.isArray(child)) return 0;
      let n = 0;
      for (const el of child) n += walk(el, depth + 1);
      return n;
    }
    return walk(child, depth + 1);
  }

  return walk(root, 0);
}

function dropEmptyDissent(out: Record<string, unknown>): boolean {
  const dissent = out.dissent;
  if (dissent === null && "dissent" in out) {
    delete out.dissent;
    return true;
  }
  if (
    dissent == null ||
    typeof dissent !== "object" ||
    Array.isArray(dissent)
  ) {
    return false;
  }
  const values = Object.values(dissent as Record<string, unknown>);
  const allEmpty = values.every(
    (v) => typeof v === "string" && v.trim() === "",
  );
  if (!allEmpty) return false;
  delete out.dissent;
  return true;
}

function dropEmptyPmDeliveryStrategy(out: Record<string, unknown>): boolean {
  if (out.status === "strategy_memo" || !("strategy" in out)) return false;
  if (out.strategy === null) {
    delete out.strategy;
    return true;
  }
  if (typeof out.strategy !== "object" || Array.isArray(out.strategy)) {
    return false;
  }

  const strategy = out.strategy as Record<string, unknown>;
  const knownKeys = new Set([
    "premise_check",
    "reframe_options",
    "research_findings",
    "clarifications_needed",
  ]);
  if (Object.keys(strategy).some((key) => !knownKeys.has(key))) return false;

  const isEmpty =
    (strategy.premise_check === undefined || strategy.premise_check === "") &&
    (strategy.reframe_options === undefined ||
      (Array.isArray(strategy.reframe_options) &&
        strategy.reframe_options.length === 0)) &&
    (strategy.research_findings === undefined ||
      (Array.isArray(strategy.research_findings) &&
        strategy.research_findings.length === 0)) &&
    (strategy.clarifications_needed === undefined ||
      strategy.clarifications_needed === false);
  if (!isEmpty) return false;

  delete out.strategy;
  return true;
}

export function coerceEnvelope(slug: string, inner: unknown): EnvelopeCoercion {
  const caps = DISPLAY_CAPS[slug];
  if (!caps || inner == null || typeof inner !== "object") {
    return { value: inner, notes: [] };
  }
  const out = structuredClone(inner) as Record<string, unknown>;
  let mutated = false;
  const notes: string[] = [];
  for (const [field, cap] of Object.entries(caps)) {
    const n = isItemCap(cap)
      ? coerceArrayPath(out, field, cap.maxItems)
      : coercePath(out, field, capMax(cap), capDirection(cap));
    if (n > 0) {
      notes.push(
        isItemCap(cap)
          ? `${field} auto-trimmed to ${cap.maxItems} items`
          : n === 1
            ? `${field} auto-shortened to ${capMax(cap)} chars`
            : `${field} auto-shortened ${n} fields to ${capMax(cap)} chars`,
      );
      mutated = true;
    }
  }
  if (slug === "advisor" && dropEmptyDissent(out)) {
    notes.push("dissent omitted (model emitted an empty dissent object)");
    mutated = true;
  }
  if (slug === "pm" && dropEmptyPmDeliveryStrategy(out)) {
    notes.push(
      "strategy omitted (model emitted an empty delivery-mode placeholder)",
    );
    mutated = true;
  }
  return { value: mutated ? out : inner, notes };
}

export const __DISPLAY_CAPS = DISPLAY_CAPS;
