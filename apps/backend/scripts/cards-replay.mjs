import { readFileSync, writeFileSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { truthFor, classifyLabel, cardsName } from "./cook-truth.mjs";
const run = promisify(execFile);
const DIR = process.env.VERDICT_REPLAY_DIR ?? ".verdict-replay";
const GROK_BIN = process.env.GROK_BIN ?? `${process.env.HOME}/.grok/bin/grok`;
const arg = (n, d = null) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

const ASK = `You are producing the action cards a small business owner sees for ONE growth channel.
Use ONLY the evidence given. Never invent a number, a name or a source.
Return ONLY minified JSON, no prose, no code fence:
{"cards":[{"headline":"<=80 chars","rationale":"<=300 chars","evidence":[{"value":"<=24 chars","caption":"<=60 chars"}],"estimate":[{"value":"<=24 chars","caption":"<=60 chars"}],"kind":"proposal"|"manual","deliverable":{"kind":"comment"|"post"|"thread"|"page_copy"|"none","text":"the FINISHED text the owner pastes, or empty when the card is a check they perform themselves"}}]}
3 to 5 cards, best first. "kind" is "proposal" when software could carry the change out on this channel without a person, "manual" when only the owner can do it.

Where a card asks the owner to publish something, WRITE THAT TEXT IN FULL in deliverable.text, finished and paste-ready, not a description of what to write. A card that says "reply helpfully" without the reply is not an action, it is homework.

"evidence" and "estimate" are OPTIONAL. Give them ONLY when the run's own evidence supports them; send [] otherwise. NEVER invent a number to fill a field, and never drop an otherwise good card because you have no number for it.`;

const ASK_REAL = `You are producing the founder-visible output of ONE growth-channel run.
Use ONLY the evidence given. Never invent a number, a name or a source.
Return ONLY minified JSON, no prose, no code fence:
{"rendered_markdown":"the audit the founder reads, markdown","steps":[{"title":"<=120 chars, one imperative action","body":"<=4000 chars, why it matters","blocking":true|false,"effort":"minutes"|"hours"|"days","evidence":["what this is grounded in - a page fetched this run, a row, a status"],"deliverable":{"kind":"post"|"thread"|"comment"|"dm"|"email"|"sms"|"ad"|"script"|"page_copy"|"code"|"brief"|"list"|"other","label":"<=80 chars","content":"the FINISHED text the founder pastes, <=6000 chars"}}]}
3 to 5 steps, best first.

EVERY step carries at least one item in "evidence". A step with nothing behind it is not a finding and is dropped before the founder sees it, so do not write one.

"blocking" is true ONLY when this makes the whole channel impossible until it is done - no conversion tag, no landing page, tracking dead. It is a precondition, not a priority.

Where a step asks the founder to publish something, WRITE THAT TEXT IN FULL in deliverable.content, finished and paste-ready, not a description of what to write. A step that says "reply helpfully" without the reply is not an action, it is homework.

"deliverable" is omitted for a step that is a check the founder performs themselves.`;

const JARGON = /\b(CPA|CPC|CTR|ROAS|n-?gram|impression share|SUBMIT_LEAD_FORM|PRESENCE_OR_INTEREST|BROAD|PHRASE|EXACT|PAUSED|ENABLED|ER|CPM)\b/;
const ID_RE = /\b\d{8,}\b/;
const OUTCOME = {
  waste: /(\$\s?[\d,]+(\.\d+)?|\d+\s*(bookings|sign-?ups|sales|conversions|clicks|leads))/i,
  underperformance: /(\d[\d,]*\s*(plays|views|impressions|reach|likes|comments|shares|saves|replies|subscribers)|\d+(\.\d+)?\s*%)/i,
  none: /(\d[\d,]*|\$\s?[\d,]+)/,
};

function extractJson(stdout) {
  let t = String(stdout).replace(/^```(?:json)?|```$/gm, "").trim();
  const fence = t.match(/\{[\s\S]*\}/);
  if (t.startsWith("{")) return t;
  return fence ? fence[0] : t;
}

function coverage(bundles) {
  const per = new Map();
  for (const b of bundles) {
    const t = truthFor(b);
    const s = per.get(b.channel) ?? { bundles: 0, rankable: 0, truths: new Set(), tenants: new Set(), unechoable: 0, kinds: new Set(), reasons: new Map() };
    s.bundles += 1;
    if (t.rows.length) {
      s.rankable += 1; s.kinds.add(t.kind);
      s.truths.add(t.rows[0].label); s.tenants.add(b.tenant_id);
      if (!classifyLabel(t.rows[0].label).usable) s.unechoable += 1;
    } else {
      s.reasons.set(t.reason, (s.reasons.get(t.reason) ?? 0) + 1);
    }
    per.set(b.channel, s);
  }
  return per;
}

function printCoverage(per) {
  console.log("\nCHANNEL COVERAGE  (what any number below actually rests on)");
  console.log("channel              bundles  truth-kind         rankable  truths  tenants  notes");
  for (const [ch, s] of [...per].sort((a, b) => b[1].bundles - a[1].bundles)) {
    const kind = s.kinds.size ? [...s.kinds].join("+") : "none";
    const notes = [];
    if (s.rankable && s.tenants.size < 2) notes.push(`SINGLE TENANT - treat as N=1, not N=${s.rankable}`);
    if (s.rankable && s.truths.size < 3) notes.push(`only ${s.truths.size} distinct truth string(s)`);
    if (s.unechoable) notes.push(`${s.unechoable} truth(s) unechoable (free text)`);
    if (!s.rankable) { const top = [...s.reasons].sort((a, b) => b[1] - a[1])[0]; if (top) notes.push(top[0]); }
    console.log(
      ch.padEnd(20), String(s.bundles).padStart(7), " ", kind.padEnd(18),
      String(s.rankable).padStart(8), String(s.truths.size).padStart(7), String(s.tenants.size).padStart(8),
      " ", notes.join(" · "),
    );
  }
  console.log("");
}

async function main() {
  const variantPath = arg("variant");
  const variantSet = arg("variant-set");
  const channelsArg = arg("channels");
  const coverageOnly = arg("coverage") !== null;
  if (!coverageOnly && !variantPath && !variantSet) throw new Error("--variant or --variant-set required");
  if (!channelsArg) throw new Error("--channels <slug[,slug]> is required (no default: a forgotten flag used to score one channel and report a sweep)");
  const label = arg("label", ((variantSet ?? variantPath ?? "coverage").split("/").pop()).replace(/\.md$/, ""));
  const channels = String(channelsArg).split(",");
  const limit = Number(arg("limit", "0"));
  const variantFor = (channel) =>
    variantSet ? readFileSync(`${DIR}/columns/${variantSet}.${channel}.md`, "utf8") : readFileSync(variantPath, "utf8");
  const injectMap = arg("truth-map") !== null || arg("money-map") !== null;
  const mapMode = arg("map-mode", "true");
  const onlyRankable = arg("only-rankable") !== null;
  const engine = String(arg("engine", "claude"));
  const contract = String(arg("contract", "cards"));

  const raw = JSON.parse(readFileSync(`${DIR}/bundles.json`, "utf8"));
  const all = channels.includes("all") ? raw : raw.filter((b) => channels.includes(b.channel));
  printCoverage(coverage(all));
  if (coverageOnly) return;

  if (onlyRankable) {
    const kinds = new Set(all.map((b) => truthFor(b).kind));
    if (kinds.size === 1 && kinds.has("none")) {
      throw new Error(
        `--only-rankable refused: no bundle for ${channels.join(",")} has a truth cook-truth.mjs can compute. ` +
        `If this channel's agreed Score is a kind cook-truth does not implement, add the plugin before filtering — ` +
        `dropping every bundle is not a zero, it is an unscorable channel. Re-run without --only-rankable to see the reasons.`,
      );
    }
  }

  let bundles = all;
  if (onlyRankable) {
    const dropped = new Map();
    bundles = all.filter((b) => {
      if (truthFor(b).rows.length) return true;
      dropped.set(b.channel, (dropped.get(b.channel) ?? 0) + 1);
      return false;
    });
    if (dropped.size) console.log(`--only-rankable DROPPED: ${[...dropped].map(([c, n]) => `${c}=${n}`).join(" ")}`);
  }
  const work = limit > 0 ? bundles.slice(0, limit) : bundles;
  if (!work.length) { console.log("nothing scoreable for these channels — the coverage table above IS the finding."); return; }

  const POOL = Number(arg("pool", "6"));
  const out = `${DIR}/cards-${label}.jsonl`; writeFileSync(out, "");
  console.log(`${label}: ${work.length} bundles (${channels.join(",")}) engine=${engine}${injectMap ? ` + truth map [${mapMode}]` : ""}`);

  const queue = [...work];
  const worker = async () => { for (;;) { const b = queue.shift(); if (!b) return; await one(b); } };
  const one = async (b) => {
    const t = truthFor(b);
    let evidence = b.evidence;
    if (injectMap && t.rows.length) {
      const ordered = mapMode === "inverted" ? [...t.rows].reverse() : t.rows;
      const unit = t.kind === "waste" ? (r) => `$${r.value.toFixed(2)} spent, 0 conversions`
        : (r) => `${(r.value * 100).toFixed(2)}% engagement on ${r.delivered} delivered`;
      const head = t.kind === "waste" ? "MONEY MAP (computed for you; largest wasted spend first)"
        : "DELIVERY MAP (computed for you; worst-performing delivered item first)";
      evidence = `${head}\n${ordered.map((r, i) => `${i + 1}. ${r.label} — ${unit(r)}`).join("\n")}\n\n---\n\n${evidence}`;
    }
    const user = `CHANNEL: ${b.channel}\nREADS THAT FAILED: ${b.failed_reads?.length ? b.failed_reads.join("; ") : "none"}\n\nEVIDENCE GATHERED THIS RUN:\n${evidence.slice(0, 55000)}`;
    let parsed = null, err = null;
    const system = `${variantFor(b.channel)}\n\n---\n\n${contract === "real" ? ASK_REAL : ASK}`;
    try {
      let stdout;
      if (engine === "grok") {
        const dir = mkdtempSync(join(tmpdir(), "cards-grok-"));
        const f = join(dir, "p.md");
        writeFileSync(f, `${system}\n\n---\n\n${user}`);
        ({ stdout } = await run(GROK_BIN, ["--prompt-file", f, "--output-format", "plain", "--no-plan", "--sandbox", "read-only"], { maxBuffer: 20e6, timeout: 600000 }));
      } else {
        ({ stdout } = await run("claude", ["-p", user, "--append-system-prompt", system, "--model", "sonnet", "--output-format", "text"], { maxBuffer: 20e6, timeout: 420000 }));
      }
      parsed = JSON.parse(extractJson(stdout));
    } catch (e) { err = String(e.message ?? e).slice(0, 180); }
    const cards = parsed?.cards ?? parsed?.steps ?? [];
    const text = JSON.stringify(cards);
    const top = t.rows[0] ?? null;
    const topHit = top ? cardsName(text, top.label) : { hit: null, why: t.reason || "no truth" };
    appendFileSync(out, JSON.stringify({
      label, engine, run_id: b.run_id, channel: b.channel, tenant_id: b.tenant_id, err,
      n_cards: cards.length,
      truth_kind: t.kind,
      truth_reason: t.reason || undefined,
      truth_instruments: t.instruments,
      truth: t.rows.map((r) => r.label),
      caught_top: topHit.hit,
      caught_why: topHit.why,
      caught_any_top3: t.rows.length ? (t.rows.some((r) => cardsName(text, r.label).hit === true) || null) : null,
      named_list_head: top ? cardsName(text, (mapMode === "inverted" ? t.rows[t.rows.length - 1] : top).label).hit : null,
      outcome_cards: cards.filter((c) => (OUTCOME[t.kind] ?? OUTCOME.none).test(JSON.stringify(c))).length,
      proposal_cards: cards.filter((c) => c.kind === "proposal").length,
      dropped_by_schema: cards.filter((c) => {
        const ev = c.evidence;
        const hasEv = typeof ev === "string" ? ev.trim().length > 0 : Array.isArray(ev) && ev.length > 0;
        const okEffort = !("effort" in c) || ["minutes", "hours", "days"].includes(String(c.effort));
        return !hasEv || !okEffort;
      }).length,
      jargon_cards: cards.filter((c) => JARGON.test(JSON.stringify(c))).length,
      id_cards: cards.filter((c) => ID_RE.test(`${c.headline} ${c.rationale}`)).length,
      deliverable_cards: cards.filter((c) => String(c.deliverable?.content ?? c.deliverable?.text ?? "").trim().length > 40).length,
      cards,
    }) + "\n");
    process.stdout.write(err ? "x" : ".");
  };
  await Promise.all(Array.from({ length: POOL }, worker));
  console.log(`\n-> ${out}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
