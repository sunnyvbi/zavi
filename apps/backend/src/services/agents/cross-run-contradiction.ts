
import { parseHumanNumbers } from "@/agents/research/human-number";

const MS_PER_DAY = 86_400_000;

const DELTA_PCT = 20;

const WINDOW = 60;

const BUSINESS_NOUNS = [
  "host",
  "fleet",
  "user",
  "guest",
  "booking",
  "trip",
  "listing",
  "signup",
  "conversion",
  "revenue",
  "gmv",
  "arr",
  "mrr",
  "approval",
];

const NOUN_RE = new RegExp(
  `\\b(${BUSINESS_NOUNS.join("|")})s?\\b`,
  "gi",
);

export type RecallHitLite = {
  agent_slug?: string | null;
  created_at?: string | null;
  body?: string | null;
};

export function relativeAge(
  createdAt?: string | null,
  nowMs: number = Date.now(),
): string | undefined {
  if (!createdAt) return undefined;
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return undefined;
  if (createdMs > nowMs) return undefined;
  const days = Math.floor((nowMs - createdMs) / MS_PER_DAY);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

function normNoun(raw: string): string {
  const lower = raw.toLowerCase();
  return lower.endsWith("s") ? lower.slice(0, -1) : lower;
}

function topicNumbers(body: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!body) return out;
  for (const m of body.matchAll(NOUN_RE)) {
    const idx = m.index ?? 0;
    const noun = normNoun(m[1]);
    const window = body.slice(
      Math.max(0, idx - WINDOW),
      idx + m[0].length + WINDOW,
    );
    const nums = parseHumanNumbers(window);
    if (nums.length === 0) continue;
    const prev = out.get(noun) ?? [];
    out.set(noun, [...prev, ...nums]);
  }
  return out;
}

function contradicts(a: number, b: number): boolean {
  const lo = Math.min(Math.abs(a), Math.abs(b));
  const hi = Math.max(Math.abs(a), Math.abs(b));
  if (lo === 0) return hi > 0;
  return (hi - lo) / lo > DELTA_PCT / 100;
}

export function detectCrossRunContradiction(
  hits: RecallHitLite[],
): string | undefined {
  if (!hits || hits.length < 2) return undefined;

  const byNoun = new Map<string, Array<{ hit: number; value: number }>>();
  hits.forEach((h, i) => {
    const tn = topicNumbers(h.body ?? "");
    for (const [noun, nums] of tn) {
      const acc = byNoun.get(noun) ?? [];
      for (const value of nums) acc.push({ hit: i, value });
      byNoun.set(noun, acc);
    }
  });

  for (const [noun, entries] of byNoun) {
    const hitsSeen = new Set(entries.map((e) => e.hit));
    if (hitsSeen.size < 2) continue;
    for (let a = 0; a < entries.length; a++) {
      for (let b = a + 1; b < entries.length; b++) {
        if (entries[a].hit === entries[b].hit) continue;
        if (contradicts(entries[a].value, entries[b].value)) {
          const v1 = entries[a].value;
          const v2 = entries[b].value;
          return (
            `Prior context contains conflicting figures on overlapping topics ` +
            `(e.g. "${noun}": ${v1} vs ${v2} from different prior runs). ` +
            `Cross-check live operator data or recent human notes before ` +
            `asserting either as fact.`
          );
        }
      }
    }
  }
  return undefined;
}

const STATE_GROUPS: ReadonlyArray<readonly [readonly string[], readonly string[]]> = [
  [
    ["live", "launched", "shipped", "active", "online", "running"],
    [
      "pre-launch",
      "prelaunch",
      "not live",
      "not launched",
      "unlaunched",
      "not shipped",
      "paused",
      "suspended",
      "inactive",
      "offline",
      "deactivated",
      "deprecated",
      "retired",
      "shut down",
      "shutdown",
    ],
  ],
  [
    ["enabled", "turned on"],
    ["disabled", "turned off", "not enabled"],
  ],
  [
    ["approved", "accepted"],
    ["rejected", "denied", "declined", "not approved"],
  ],
  [
    ["allowed", "permitted", "whitelisted"],
    ["blocked", "forbidden", "prohibited", "not allowed", "disallowed", "banned"],
  ],
  [
    ["verified"],
    ["unverified", "not verified"],
  ],
  [
    ["available", "in stock", "in-stock"],
    ["unavailable", "out of stock", "out-of-stock", "sold out"],
  ],
];

const STATE_WINDOW = 80;

const SUBJECT_STOPWORDS = new Set<string>([
  "feature", "features", "product", "products", "project", "projects",
  "system", "systems", "thing", "things", "page", "pages", "app", "apps",
  "tool", "tools", "service", "services", "item", "items", "update", "updates",
  "change", "changes", "status", "flow", "flows", "part", "parts", "section",
  "sections", "stuff", "work", "note", "notes", "task", "tasks", "stage",
  "stages", "mode", "modes", "state", "states", "thread", "threads",
  "this", "that", "these", "those", "there", "their", "they", "them",
  "then", "than", "with", "from", "have", "been", "were", "will", "would",
  "should", "could", "into", "over", "under", "about", "after", "before",
  "while", "when", "where", "which", "what", "whom", "your", "yours", "ours",
  "currently", "current", "still", "also", "just", "only", "very", "much",
  "more", "most", "some", "many", "such", "each", "both", "either", "other",
  "another", "again", "longer", "right", "left", "down", "back", "here",
  "being", "does", "done", "made", "make", "made",
]);

function subjectTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 4) continue;
    if (SUBJECT_STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

function findStatePositions(
  body: string,
  phrases: readonly string[],
): Array<{ phrase: string; idx: number }> {
  const out: Array<{ phrase: string; idx: number }> = [];
  for (const phrase of phrases) {
    const re = new RegExp(
      `\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "gi",
    );
    for (const m of body.matchAll(re)) {
      out.push({ phrase: phrase.toLowerCase(), idx: m.index ?? 0 });
    }
  }
  return out;
}

function subjectAround(
  body: string,
  matches: Array<{ phrase: string; idx: number }>,
): Set<string> {
  const acc = new Set<string>();
  for (const { phrase, idx } of matches) {
    const window = body.slice(
      Math.max(0, idx - STATE_WINDOW),
      idx + phrase.length + STATE_WINDOW,
    );
    for (const t of subjectTokens(window)) acc.add(t);
  }
  return acc;
}

export function detectGeneralContradiction(
  hits: RecallHitLite[],
): string | undefined {
  if (!hits || hits.length < 2) return undefined;

  for (let a = 0; a < hits.length; a++) {
    for (let b = a + 1; b < hits.length; b++) {
      const bodyA = hits[a].body ?? "";
      const bodyB = hits[b].body ?? "";
      if (!bodyA || !bodyB) continue;

      for (const [pos, neg] of STATE_GROUPS) {
        const aPos = findStatePositions(bodyA, pos);
        const aNeg = findStatePositions(bodyA, neg);
        const bPos = findStatePositions(bodyB, pos);
        const bNeg = findStatePositions(bodyB, neg);

        const aSide =
          aPos.length && !aNeg.length
            ? "pos"
            : aNeg.length && !aPos.length
              ? "neg"
              : null;
        const bSide =
          bPos.length && !bNeg.length
            ? "pos"
            : bNeg.length && !bPos.length
              ? "neg"
              : null;
        if (!aSide || !bSide || aSide === bSide) continue;

        const aMatches = aSide === "pos" ? aPos : aNeg;
        const bMatches = bSide === "pos" ? bPos : bNeg;
        const subjA = subjectAround(bodyA, aMatches);
        const subjB = subjectAround(bodyB, bMatches);
        const shared = [...subjA].filter((t) => subjB.has(t));
        if (shared.length === 0) continue;

        const subject = shared.sort((x, y) => y.length - x.length)[0];
        const stateA = aMatches[0].phrase;
        const stateB = bMatches[0].phrase;
        return (
          `Prior context disagrees on the status of "${subject}" ` +
          `(one prior note says "${stateA}", another says "${stateB}"). ` +
          `Cross-check live operator data or recent human notes before ` +
          `asserting either as current fact.`
        );
      }
    }
  }
  return undefined;
}
