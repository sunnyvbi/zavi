import { readFileSync, readdirSync } from "node:fs";

import { classifyLabel, cardsName } from "./cook-truth.mjs";

const arg = (n, d = null) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const DIR = arg("dir", process.env.VERDICT_REPLAY_DIR ?? ".verdict-replay");

const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : "-");

const files = readdirSync(DIR).filter((f) => f.startsWith("cards-") && f.endsWith(".jsonl"));
if (files.length === 0) {
  console.error(`no cards-*.jsonl in ${DIR} — run cards-replay.mjs first`);
  process.exit(1);
}

const rows = [];
for (const f of files) {
  const lines = readFileSync(`${DIR}/${f}`, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const byChannel = {};
  for (const l of lines) (byChannel[l.channel] ??= []).push(l);
  for (const [channel, g] of Object.entries(byChannel)) {
    const ok = g.filter((l) => !l.err && l.n_cards > 0);
    const cards = ok.reduce((a, l) => a + l.n_cards, 0);
    let unusable = 0;
    const rankable = ok
      .map((l) => {
        const truth = (l.truth ?? []).filter((t) => classifyLabel(t).usable);
        if (!truth.length) { if ((l.truth ?? []).length) unusable += 1; return null; }
        const text = JSON.stringify(l.cards);
        return { hit: cardsName(text, truth[0]).hit === true, any: truth.some((t) => cardsName(text, t).hit === true) };
      })
      .filter(Boolean);
    const truths = new Set(ok.map((l) => (l.truth ?? [])[0]).filter(Boolean));
    const tenantIds = ok.map((l) => l.tenant_id).filter(Boolean);
    const tenants = tenantIds.length ? new Set(tenantIds).size : "-";
    rows.push({
      channel,
      lane: f.replace(/^cards-|\.jsonl$/g, ""),
      n: g.length,
      err: g.filter((l) => l.err).length,
      scored: `${rankable.length}/${ok.length}`,
      truths: truths.size,
      tenants,
      unusable,
      catch: pct(rankable.filter((r) => r.hit).length, rankable.length),
      top3: pct(rankable.filter((r) => r.any).length, rankable.length),
      raw: pct(ok.filter((l) => l.caught_top).length, ok.length),
      outcome: pct(ok.reduce((a, l) => a + (l.outcome_cards ?? l.money_cards ?? 0), 0), cards),
      exec: pct(ok.reduce((a, l) => a + l.proposal_cards, 0), cards),
      jargon: pct(ok.reduce((a, l) => a + l.jargon_cards, 0), cards),
      ids: pct(ok.reduce((a, l) => a + l.id_cards, 0), cards),
    });
  }
}

rows.sort((a, b) => a.channel.localeCompare(b.channel) || a.lane.localeCompare(b.lane));
const cols = ["channel", "lane", "n", "err", "scored", "catch", "truths", "tenants", "unusable", "top3", "raw", "outcome", "exec", "jargon", "ids"];
const w = Object.fromEntries(cols.map((c) => [c, Math.max(c.length, ...rows.map((r) => String(r[c]).length))]));
console.log(cols.map((c) => c.padEnd(w[c])).join("  "));
for (const r of rows) console.log(cols.map((c) => String(r[c]).padEnd(w[c])).join("  "));
console.log(
  [
    "",
    "catch  named the truth the run's own evidence says mattered. NEVER report it",
    "       without the two columns to its right.",
    "truths DISTINCT truth strings behind that %. Two means the oracle has two",
    "       answers, however many bundles ran.",
    "tenant DISTINCT tenants behind it. ONE means N=1 wearing an N=20 costume —",
    "       that is what meta_ads was on 2026-09-19 (20 bundles, 2 truths, 1 tenant).",
    "unusab bundles that HAD a truth no card could echo (free text). Not a miss,",
    "       an absence: excluded from catch rather than scored zero.",
    "raw    same, unrestricted labels. Shown so the gap is visible; do not report",
    "       it without saying which one it is.",
    "scored bundles with a usable truth / bundles that returned cards.",
    "outcome share of cards naming a real quantity for THAT channel's kind (money",
    "       for paid, delivery/engagement for organic).",
    "exec   share of cards the product could carry out itself. Watch this: every",
    "       prompt-cut lane measured so far roughly halved it.",
  ].join("\n"),
);
