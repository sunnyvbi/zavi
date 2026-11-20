
const INSTRUMENTS = [
  { re: /__(meta_ads|google_ads)__/, kind: "waste" },
  { re: /__(x_social__read_post_metrics|youtube_insights__read|social__list_posts)\b/, kind: "underperformance" },
];

const SCOUTING = /__apify__scrape_(tiktok|instagram|reddit)\b|__reddit__thread_read\b|__tiktok__get_creator_info\b/;

const NOT_AN_INSTRUMENT =
  /web_search|web_fetch|ToolSearch|__memory__|__report__|render_|rag_web_browser|__github__|growth__(read_action_outcomes|read_experiment_ledger|read_cohort|propose_|search_human_members)/;

const LABEL_KEYS = ["gram", "search_term", "term", "keyword", "campaign_name", "ad_group_name", "ad_name", "name", "title", "caption", "permalink"];
const SPEND_KEYS = ["spend_usd", "cost", "cost_usd", "spend"];
const OUTCOME_KEYS = ["conversions", "purchases", "sign_ups", "leads", "all_conversions"];
const DELIVERY_KEYS = ["plays", "impression_count", "impressions", "reach", "views", "view_count", "subscribers"];
const ENGAGE_KEYS = ["likes", "like_count", "comments", "comment_count", "shares", "saves", "reposts", "replies", "reply_count", "retweet_count", "engagements", "score"];

export function blocksOf(evidence) {
  const out = [];
  for (const part of evidence.split(/\n### /)) {
    const nl = part.indexOf("\n");
    if (nl < 0) continue;
    const tool = part.slice(0, nl).replace(/^### /, "").trim();
    if (!tool || tool.length > 80) continue;
    out.push({ tool, body: part.slice(nl) });
  }
  return out;
}

const leaves = (s) => [...s.replace(/\\+"/g, '"').matchAll(/\{[^{}]{10,2000}\}/g)].map((m) => m[0]);
const num = (o, k) => { const x = o.match(new RegExp(`"${k}"\\s*:\\s*(-?[\\d.]+)`)); return x ? Number(x[1]) : null; };
const label = (o) => { for (const k of LABEL_KEYS) { const x = o.match(new RegExp(`"${k}"\\s*:\\s*"([^"]{1,160})"`)); if (x) return x[1]; } return null; };
const firstNum = (o, keys) => { for (const k of keys) { const v = num(o, k); if (v !== null) return [k, v]; } return [null, null]; };

function wasteRows(body) {
  const rows = [];
  for (const o of leaves(body)) {
    const [, spend] = firstNum(o, SPEND_KEYS);
    if (spend === null || spend <= 0) continue;
    let outcome = 0, seen = false;
    for (const k of OUTCOME_KEYS) { const v = num(o, k); if (v !== null) { outcome += v; seen = true; } }
    if (!seen || outcome > 0) continue;
    const lab = label(o);
    if (lab) rows.push({ label: lab, value: spend, unit: "usd_spent" });
  }
  return rows.sort((a, b) => b.value - a.value);
}

function underperformanceRows(body) {
  const rows = [];
  for (const o of leaves(body)) {
    const [dk, delivered] = firstNum(o, DELIVERY_KEYS);
    if (delivered === null || delivered <= 0) continue;
    let eng = 0, seen = false;
    for (const k of ENGAGE_KEYS) { if (k === dk) continue; const v = num(o, k); if (v !== null) { eng += v; seen = true; } }
    if (!seen) continue;
    const lab = label(o);
    if (lab) rows.push({ label: lab, value: eng / delivered, unit: "engagement_rate", delivered });
  }
  if (rows.length < 3) return [];
  const med = [...rows].sort((a, b) => a.delivered - b.delivered)[Math.floor(rows.length / 2)].delivered;
  const above = rows.filter((r) => r.delivered >= med);
  return above.length >= 2 ? above.sort((a, b) => a.value - b.value) : [];
}

export function truthFor(bundle) {
  const own = [];
  for (const b of blocksOf(bundle.evidence)) {
    if (NOT_AN_INSTRUMENT.test(b.tool)) continue;
    const hit = INSTRUMENTS.find((i) => i.re.test(b.tool));
    if (hit) own.push({ ...b, kind: hit.kind });
  }
  if (!own.length) {
    const scouted = blocksOf(bundle.evidence).some((b) => SCOUTING.test(b.tool));
    if (scouted) {
      return { kind: "none", rows: [], instruments: [],
        reason: "only scouted third-party content (competitor/community posts) - nothing the tenant delivered" };
    }
    const failed = (bundle.failed_reads ?? []).length;
    return {
      kind: "none", rows: [], instruments: [],
      reason: failed ? `no channel instrument returned data (${failed} read(s) failed)` : "ran on research tools only (no channel instrument in evidence)",
    };
  }
  const byKind = new Map();
  for (const b of own) {
    const rows = b.kind === "waste" ? wasteRows(b.body) : underperformanceRows(b.body);
    if (!rows.length) continue;
    const cur = byKind.get(b.kind) ?? { rows: [], tools: [] };
    cur.rows.push(...rows); cur.tools.push(b.tool);
    byKind.set(b.kind, cur);
  }
  if (!byKind.size) {
    return { kind: "none", rows: [], instruments: own.map((o) => o.tool),
      reason: `channel instrument ran but returned no scoreable line (${own.length} block(s))` };
  }
  const [kind, best] = [...byKind].sort((a, b) => b[1].rows.length - a[1].rows.length)[0];
  const rows = kind === "waste" ? best.rows.sort((a, b) => b.value - a.value) : best.rows.sort((a, b) => a.value - b.value);
  return { kind, rows: rows.slice(0, 3), reason: "", instruments: [...new Set(best.tools)] };
}

const norm = (s) => String(s).toLowerCase().replace(/\\+[nrt]/g, " ").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set("the a an and or of for to in on at is it your you our we with from this that post ad ads page site com www https http".split(" "));
const COMMON = new Set("need advice help best new good great time people work make made get got use used want like look find new day week month year thing things way ways top real free full more most one two".split(" "));

export function classifyLabel(rawLabel) {
  const n = norm(rawLabel);
  if (!n) return { usable: false, class: "empty" };
  if (n.length > 40) return { usable: false, class: "too_long_to_echo" };
  const tokens = n.split(" ").filter((t) => t.length > 2 && !STOP.has(t));
  if (!tokens.length) return { usable: false, class: "stopwords_only" };
  return { usable: true, class: "echoable", tokens };
}

export function cardsName(cardsText, rawLabel) {
  const c = classifyLabel(rawLabel);
  if (!c.usable) return { hit: null, why: c.class };
  const hay = norm(cardsText);
  const n = norm(rawLabel);
  if (c.tokens.length === 1) {
    const t = c.tokens[0];
    if (t.length < 4 || COMMON.has(t)) return { hit: false, why: "label_not_distinctive" };
    return new RegExp(`\\b${t}\\b`).test(hay) ? { hit: true, why: `token:${t}` } : { hit: false, why: "absent" };
  }
  if (hay.includes(n)) return { hit: true, why: "exact" };
  const words = n.split(" ");
  for (let i = 0; i < words.length - 1; i += 1) {
    const bigram = `${words[i]} ${words[i + 1]}`;
    if (bigram.split(" ").every((w) => STOP.has(w) || COMMON.has(w))) continue;
    if (hay.includes(bigram)) return { hit: true, why: `phrase:${bigram}` };
  }
  return { hit: false, why: "absent" };
}
