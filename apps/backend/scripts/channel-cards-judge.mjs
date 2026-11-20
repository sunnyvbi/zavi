#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardsDb, checkChannel, pickTenants } from "./channel-cards-db.mjs";
import { OPEN, visibleText } from "./channel-cards-rate.mjs";

const args = process.argv.slice(2);
const arg = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};

const PER_CALL_OUT = 6000;
const PER_RUN_EVIDENCE = 60000;
const CARD_CHARS = 5000;
const CONCURRENCY = 6;

export function stratify(cards, n) {
  const groups = new Map();
  for (const c of cards) {
    const k = `${c.tenant}|${c.channel_slug}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  }
  const lists = [...groups.values()];
  const out = [];
  for (let i = 0; out.length < n && lists.some((l) => l.length > i); i++) {
    for (const l of lists) if (l[i] && out.length < n) out.push(l[i]);
  }
  return out;
}

export function evidenceText(toolCalls) {
  let clipped = false;
  const parts = [];
  let total = 0;
  for (const c of toolCalls ?? []) {
    if (c.status && c.status !== "ok" && c.status !== "success") continue;
    let out = String(c.output_preview ?? "");
    if (out.length > PER_CALL_OUT) {
      out = out.slice(0, PER_CALL_OUT);
      clipped = true;
    }
    const block = `### ${c.name}\ninput: ${String(c.input_preview ?? "").slice(0, 300)}\noutput:\n${out}\n`;
    if (total + block.length > PER_RUN_EVIDENCE) {
      clipped = true;
      break;
    }
    parts.push(block);
    total += block.length;
  }
  if ((toolCalls ?? []).some((c) => String(c.output_preview ?? "").length >= 8000)) clipped = true;
  return { text: parts.join("\n"), clipped };
}

const LIVE_PAGES_PER_RUN = 5;
const LIVE_PAGE_CHARS = 25000;

export function fetchedUrls(toolCalls) {
  const urls = [];
  for (const c of toolCalls ?? []) {
    if (!/web_fetch/.test(String(c.name)) || (c.status && c.status !== "ok")) continue;
    const m = String(c.input_preview ?? "").match(/https?:\/\/[^\s"'\\]+/);
    if (m && !urls.includes(m[0])) urls.push(m[0]);
  }
  return urls.slice(0, LIVE_PAGES_PER_RUN);
}

export function pageText(html) {
  return String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function livePages(urls) {
  const out = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 (card-judge)" } });
      if (!res.ok) continue;
      out.push(`### LIVE ${url}\n${pageText(await res.text()).slice(0, LIVE_PAGE_CHARS)}`);
    } catch {
    }
  }
  return out.join("\n\n");
}

function cardText(c) {
  const s = c.step ?? {};
  const ev = Array.isArray(s.evidence) ? s.evidence.join(" | ") : "";
  return `[card ${c.id}] channel=${c.channel_slug} blocking=${s.blocking === true}\n${visibleText(s).slice(0, CARD_CHARS)}\nCITED EVIDENCE: ${ev.slice(0, 1500)}`;
}

export const CARD_JUDGES = ["TRUE", "WORTH_NOW", "RIGHT_GOAL", "PREMISE_CHECKED", "PER_ITEM_EVIDENCE", "STEPS_FOLLOWABLE", "NUMBERS_CONSISTENT", "BLOCKING_FLAGGED"];
const BOARD_JUDGES = new Set(["NUMBERS_CONSISTENT", "BLOCKING_FLAGGED"]);
const judgeArg = (() => {
  const i = process.argv.indexOf("--judges");
  return i >= 0 ? new Set(process.argv[i + 1].split(",")) : null;
})();
const wanted = (n) => !judgeArg || judgeArg.has(n);

const OUTPUT_RULE =
  'Answer with ONLY a JSON array, one object per card, in the order given: [{"id":"<card id>","pass":true|false|null,"reason":"<one sentence>"}]. ' +
  "null means you could not check (say why). No prose outside the JSON.";

export const JUDGES = {
  TRUE: (company, evidence, cards) =>
    `You check action cards that an AI growth tool wrote for the founder of ${company}.
Question, and ONLY this question: does every SPECIFIC claim the card makes about this company (its site, pages, accounts, numbers, prices, people, customers, competitors, what is or is not set up) trace to the evidence below?
- FAIL if any such claim is contradicted by the evidence, or appears nowhere in it.
- General marketing advice, recommendations and opinions are not claims. "[CONFIRM: ...]" slots are fine; they ask the founder to check.
- The card's own "CITED EVIDENCE" line is the tool's claim about what it saw, not proof. Check it against the evidence.
- The run's stored tool results are ${evidence.clipped ? "CLIPPED (8 KB per call)" : "complete"}. ${evidence.live ? "Full LIVE copies of the pages the run read are included, fetched today; they may differ slightly from run time. A claim backed by EITHER copy is supported." : ""}
- Claims about what the TOOL itself did or holds (a post it staged, a file or PDF it rendered, an approval card it created, its own limits or settings) live outside this evidence. They are neither supported nor contradicted here: ignore them for pass/fail, and if they are the ONLY specific claims, answer null.
- Answer null (not false) ONLY when the claim is about something neither copy could show (for example an ad account's settings when that tool result is clipped), and say what is missing.
- Ignore trivial mismatches that would not mislead the founder (rounding, a character count off by a few, a spend figure a day out of date).
Do not judge usefulness, tone or length.

COMPANY FACTS (stored by the founder and onboarding; the agents read these too):
${evidence.facts || "(none stored)"}

EVIDENCE (tool results from the run that wrote these cards):
${evidence.text}

${evidence.live ? `LIVE PAGES (fetched today, full text):\n${evidence.live}` : ""}

CARDS:
${cards.map(cardText).join("\n\n")}

${OUTPUT_RULE}`,

  WORTH_NOW: (company, _evidence, cards, siblings) =>
    `You review action cards that an AI growth tool wrote for the founder of ${company}. The founder runs the company; the tool (Zavi) writes the cards.
Question, and ONLY this question: should a sensible founder of THIS company do this card now?
PASS only if all hold:
- It is an action the founder (or their team) can take, not an observation, a status note, or a task for the tool itself.
- It is addressed to the founder, not to a third person about the founder.
- It plausibly moves growth for this company, and the card says why.
FAIL otherwise, and name which condition failed. Judge the card on its own merits: whether another card repeats it, and whether its facts are true, are separate checks.

CARDS TO JUDGE:
${cards.map(cardText).join("\n\n")}

${OUTPUT_RULE}`,

  RIGHT_GOAL: (company, _evidence, cards) =>
    `You review action cards that an AI growth tool wrote for the founder of ${company}.
Question, and ONLY this question: does the card judge the thing it acts on (a campaign, page, post, account, channel) against THAT thing's own goal?
- FAIL if it evaluates or changes something using a metric the thing was not set up to produce (for example an awareness or engagement campaign judged on purchases or conversions) without saying so and offering to keep it as it is.
- null if the card does not judge the performance of an existing thing (a new post, a setup task).
${cards.map(cardText).join("\n\n")}

${OUTPUT_RULE}`,

  PREMISE_CHECKED: (company, _evidence, cards) =>
    `You review action cards that an AI growth tool wrote for the founder of ${company}.
Question, and ONLY this question: before recommending a change, does the card establish that the problem it fixes actually exists AND matters here?
- FAIL if the need for the change rests on an assumption the card does not check or state (for example fixing a conversion setting without showing any campaign uses it, or calling something "0 conversions" without saying which conversion count it means).
- null if the card recommends no fix (a new post, an outreach message).
${cards.map(cardText).join("\n\n")}

${OUTPUT_RULE}`,

  PER_ITEM_EVIDENCE: (company, _evidence, cards) =>
    `You review action cards that an AI growth tool wrote for the founder of ${company}.
Question, and ONLY this question: when the card acts on SEVERAL items (keywords, rules, creators, pages, ads, audiences), does it name each item and give the numbers behind each one's recommendation?
- FAIL if it applies one action to a group without per-item evidence, or refers to items ("2 rules", "3 creators") without naming them.
- FAIL too if each item shows only the one number that argues for the action: the founder needs enough per item to see the case against it as well (for a cut or pause, the activity alongside the missing result).
- null if the card acts on a single item, or the items do not exist yet (new ads or posts to create have no numbers).
${cards.map(cardText).join("\n\n")}

${OUTPUT_RULE}`,

  STEPS_FOLLOWABLE: (company, _evidence, cards) =>
    `You review action cards that an AI growth tool wrote for the founder of ${company}, who may not be an expert in this channel.
Question, and ONLY this question: could the founder follow the card's instructions without help?
PASS only if each step is ONE action, names the exact screen, setting or page, the steps are in order, every setting needed is on the card (not in a separate file or "another card"), and the words are plain (no internal terms).
- null if the card has no instructions to follow (for example ready-to-paste copy with nothing else to do).
${cards.map(cardText).join("\n\n")}

${OUTPUT_RULE}`,

  NUMBERS_CONSISTENT: (company, board, cards) =>
    `Below is every open action card on ${company}'s growth board, then the cards to judge.
Question, and ONLY this question: does any figure a JUDGED card states (spend, dates, day counts, time windows, signups, counts of states or cities, prices) contradict a figure for the SAME fact on another card on the board?
- The founder reads the whole board at once. Two cards showing DIFFERENT figures for the same thing (the same campaign's spend, window, signup count, number of markets) is a contradiction to them even if each was true when written (an older snapshot next to a newer one).
- pass=false if contradicted (name both figures and the other card). pass=true if consistent. null if the card states no such figure.
BOARD:
${board.map((b) => `- [${b.channel_slug}] ${b.title} :: ${visibleText(b.step).replace(/\s+/g, " ").slice(0, 700)}`).join("\n")}

JUDGE:
${cards.map(cardText).join("\n\n")}

${OUTPUT_RULE}`,

  BLOCKING_FLAGGED: (company, board, cards) =>
    `Below are the open action cards on one channel of ${company}'s growth board (each shows blocking=true/false), then the cards to judge.
A card is BLOCKING when other cards on this channel cannot work or cannot be measured until it is done (a tracking pixel or conversion tag, creating or connecting the account, a required approval).
Question, and ONLY this question: is the judged card's blocking flag right?
- pass=false if a card that blocks others is not flagged, or a flagged card blocks nothing.
CHANNEL BOARD:
${board.map((b) => `- blocking=${b.step?.blocking === true} ${b.title}`).join("\n")}

JUDGE:
${cards.map(cardText).join("\n\n")}

${OUTPUT_RULE}`,

  SAME_WORK: (pairs) =>
    `Each item below is a pair of action cards from one company's growth board. For each pair: are they the SAME work?
Two cards are the SAME work when doing one makes the other pointless: the same target and the same change, or, for content (a post, pin, article, video, email), the same pitch to the same audience even with a reworded headline. NOT the same work: parts of a series (email 1 and email 2), the same change on different targets (two pages, two platforms, two creators), content on a genuinely different topic or angle, a step that prepares for another card, and a broad catch-all card versus a specific card inside it.
Answer with ONLY a JSON array: [{"id":"<pair id>","pass":true|false,"reason":"<one sentence>"}] where pass=true means SAME work.

${pairs.map((p) => `[pair ${p.id}]\nA: ${p.a}\nB: ${p.b}`).join("\n\n")}`,
};

const ENGINE = arg("--engine") ?? "codex";
const GROK_CALL = join(process.env.HOME ?? "", ".claude/skills/super-engineer/lib/grok-call.sh");

function codex(prompt, outFile) {
  if (ENGINE === "grok") return grok(prompt, outFile);
  return new Promise((resolve) => {
    const KEEP = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR", "CODEX_HOME"];
    const env = Object.fromEntries(KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    const cwd = mkdtempSync(join(tmpdir(), "card-judge-"));
    const p = spawn("codex", ["exec", "-", "-s", "read-only", "--skip-git-repo-check", "-C", cwd, "-o", outFile], {
      cwd,
      stdio: ["pipe", "ignore", "pipe"],
      env,
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0 || !existsSync(outFile)) return resolve({ error: `codex exit ${code}: ${err.slice(-300)}` });
      resolve({ text: readFileSync(outFile, "utf8") });
    });
    p.stdin.end(prompt);
  });
}

function grok(prompt, outFile) {
  return new Promise((resolve) => {
    const KEEP = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "TMPDIR", "GROK_BIN"];
    const env = Object.fromEntries(KEEP.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    const cwd = mkdtempSync(join(tmpdir(), "card-judge-"));
    const promptFile = join(cwd, "prompt.md");
    writeFileSync(promptFile, prompt);
    const p = spawn("bash", [GROK_CALL, "exec", promptFile], { cwd, stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => {
      if (code !== 0 || !out.trim()) return resolve({ error: `grok exit ${code}: ${err.slice(-300)}` });
      writeFileSync(outFile, out);
      resolve({ text: out });
    });
  });
}

export function parseVerdicts(text, ids) {
  const m = String(text ?? "").match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const want = new Set(ids);
  const out = {};
  for (const v of Array.isArray(arr) ? arr : []) {
    if (!v || !want.has(String(v.id))) continue;
    if (v.pass !== true && v.pass !== false && v.pass !== null) continue;
    out[String(v.id)] = { pass: v.pass, reason: String(v.reason ?? "").slice(0, 400) };
  }
  return out;
}

async function pool(tasks, n) {
  const results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < tasks.length) {
        const k = i++;
        results[k] = await tasks[k]();
      }
    }),
  );
  return results;
}

async function judge() {
  const outDir = arg("--out");
  if (!outDir) throw new Error("--out DIR is required");
  mkdirSync(join(outDir, "raw"), { recursive: true });
  const sampleN = Number(arg("--sample") ?? 40);
  const only = arg("--tenant");
  const onlyChannel = arg("--channel");
  if (onlyChannel) checkChannel(onlyChannel);
  if (ENGINE !== "codex" && ENGINE !== "grok") throw new Error(`--engine must be codex or grok, got ${ENGINE}`);
  const db = cardsDb({ prod: args.includes("--prod") });

  const onlySet = only ? new Set(only.split(",").map((x) => x.trim())) : null;
  const tenants = pickTenants(await db.tenants(), only);
  const now = Date.now();
  const titles = arg("--titles") ? JSON.parse(readFileSync(arg("--titles"), "utf8")).map((x) => x.title ?? x) : null;
  const boards = new Map();
  const cards = [];
  for (const t of tenants) {
    const rows = await db.actions(t.id);
    const open = rows.filter((r) => OPEN(r, now));
    const named = (titles ? rows.filter((r) => titles.some((q) => r.title.includes(q))) : open).filter(
      (r) => !onlyChannel || r.channel_slug === onlyChannel,
    );
    if (!named.length) continue;
    boards.set(t.slug, [...new Map([...open, ...named].map((r) => [r.id, r])).values()]);
    for (const r of named) cards.push({ ...r, tenant: t.slug, tenant_id: t.id, company: t.display_name || t.slug, site: typeof t.product_url === "string" ? t.product_url : t.product_url?.marketing ?? null });
  }
  const idsFile = arg("--ids");
  const sample = idsFile
    ? (() => {
        const want = new Set(JSON.parse(readFileSync(idsFile, "utf8")).map((x) => x.id ?? x));
        return cards.filter((c) => want.has(c.id));
      })()
    : stratify(cards, sampleN);
  console.error(`sampled ${sample.length} of ${cards.length} open cards across ${boards.size} tenants (${db.source}, judge engine ${ENGINE})`);
  if (!sample.length) {
    console.log(`No open cards to judge (tenant ${only ?? "all"}, channel ${onlyChannel ?? "all"}).`);
    return;
  }

  const byRun = new Map();
  for (const c of sample) {
    if (!byRun.has(c.run_id)) byRun.set(c.run_id, []);
    byRun.get(c.run_id).push(c);
  }
  const facts = new Map();
  for (const c of sample) {
    if (facts.has(c.tenant_id)) continue;
    const rows = await db.facts(c.tenant_id);
    facts.set(c.tenant_id, [`site: ${c.site ?? "unknown"}`, ...rows.map((f) => `${f.key}: ${String(f.value_text ?? "").slice(0, 400)}`)].join("\n"));
  }
  const evidence = new Map();
  for (const runId of byRun.keys()) {
    const toolCalls = await db.toolCalls(runId);
    const ev = evidenceText(toolCalls);
    ev.live = await livePages(fetchedUrls(toolCalls));
    ev.facts = facts.get(byRun.get(runId)[0].tenant_id) ?? "";
    evidence.set(runId, ev);
  }

  const tasks = [];
  for (const [runId, batch] of byRun) {
    const { tenant, company } = batch[0];
    const siblings = boards.get(tenant).filter((s) => !batch.some((b) => b.id === s.id));
    for (const name of CARD_JUDGES.filter((n) => wanted(n))) {
      tasks.push(async () => {
        const prompt = BOARD_JUDGES.has(name)
          ? JUDGES[name](company, name === "NUMBERS_CONSISTENT" ? boards.get(tenant) : boards.get(tenant).filter((b) => b.channel_slug === batch[0].channel_slug), batch)
          : JUDGES[name](company, evidence.get(runId), batch, siblings);
        const r = await codex(prompt, join(outDir, "raw", `${name}-${runId}.txt`));
        const v = r.error ? null : parseVerdicts(r.text, batch.map((b) => b.id));
        if (!v) console.error(`judge ${name} run ${runId}: ${r.error ?? "unparseable output"}`);
        return { name, runId, verdicts: v ?? {} };
      });
    }
  }

  const pairsFile = arg("--pairs");
  let pairs = [];
  if (pairsFile) {
    pairs = JSON.parse(readFileSync(pairsFile, "utf8"))
      .filter((p) => (p.kind === "sameChan" || p.kind === "crossChan") && (!onlySet || onlySet.has(p.tenant)))
      .filter((p) => !onlyChannel || (p.channel ?? String(p.a).split(":")[0]) === onlyChannel)
      .map((p, i) => ({ ...p, id: `p${i}` }));
    if (pairs.length) {
      tasks.push(async () => {
        const r = await codex(JUDGES.SAME_WORK(pairs), join(outDir, "raw", "SAME_WORK.txt"));
        const v = r.error ? null : parseVerdicts(r.text, pairs.map((p) => p.id));
        if (!v) console.error(`judge SAME_WORK: ${r.error ?? "unparseable output"}`);
        return { name: "SAME_WORK", verdicts: v ?? {} };
      });
    }
  }

  const results = await pool(tasks, CONCURRENCY);
  const answered = results.filter((r) => Object.keys(r.verdicts).length > 0).length;
  if (answered === 0) throw new Error(`every judge call failed (${results.length} calls); nothing to report`);
  if (answered < results.length) console.error(`WARNING: ${results.length - answered} of ${results.length} judge calls returned nothing`);
  const judged = sample.map((c) => {
    const get = (name) => results.find((r) => r.name === name && r.runId === c.run_id)?.verdicts[c.id] ?? null;
    const verdicts = Object.fromEntries(CARD_JUDGES.map((n) => [n, get(n)]));
    return {
      id: c.id,
      tenant: c.tenant,
      company: c.company,
      site: c.site,
      channel: c.channel_slug,
      title: c.title,
      evidence_clipped: evidence.get(c.run_id)?.clipped ?? null,
      card: visibleText(c.step).slice(0, CARD_CHARS),
      ...verdicts,
    };
  });
  const sameWork = results.find((r) => r.name === "SAME_WORK")?.verdicts ?? {};
  const pairOut = pairs.map((p) => ({ ...p, SAME_WORK: sameWork[p.id] ?? null }));

  writeFileSync(join(outDir, "judged.json"), JSON.stringify(judged, null, 1));
  writeFileSync(join(outDir, "pairs-judged.json"), JSON.stringify(pairOut, null, 1));
  writeFileSync(join(outDir, "label.html"), labelPage(judged, pairOut));
  console.log(summary(judged, pairOut));
}

function rate(xs, key) {
  const v = xs.map((x) => x[key]?.pass);
  const p = v.filter((x) => x === true).length;
  const f = v.filter((x) => x === false).length;
  const n = v.filter((x) => x === null).length;
  return `${key}: pass ${p} / fail ${f} / could-not-check ${n}`;
}

function summary(judged, pairs) {
  const lines = [
    `# Layer B judges (${ENGINE === "grok" ? "Grok" : "Codex"}) on ${judged.length} cards`,
    "",
    ...CARD_JUDGES.filter(wanted).map((k) => (k === "TRUE" ? rate(judged, k).replace("TRUE", "SOURCED (key TRUE)") : rate(judged, k))),
  ];
  if (pairs.length) lines.push(rate(pairs, "SAME_WORK").replace("pass", "same").replace("fail", "different"));
  lines.push("", "## Fails");
  for (const j of judged) {
    for (const k of CARD_JUDGES) {
      if (j[k]?.pass === false) lines.push(`- ${k} [${j.tenant}] ${j.channel}: ${j.title}\n  ${j[k].reason}`);
    }
  }
  lines.push("", "Judges are UNVERIFIED until --score compares them with Ravi's labels.");
  return lines.join("\n");
}

function labelPage(judged, pairs) {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const q = (id, key, label, help) =>
    `<div class="q"><div class="ql"><b>${label}</b><div class="help">${help}</div></div><div class="opts">${[
      ["yes", "Yes"],
      ["no", "No"],
      ["skip", "Skip"],
    ]
      .map(([v, t]) => `<label class="opt ${v}"><input type="radio" name="${key}:${id}" value="${v}"><span>${t}</span></label>`)
      .join("")}</div></div>`;
  const HELP_TRUE =
    "Only specific facts about the company: numbers, prices, cities, what a page says, what is set up. Ignore advice. <b>No</b> if even one fact is wrong or invented. <b>Skip</b> if you would have to look it up.";
  const HELP_WORTH =
    "As this founder, today. <b>No</b> if it is a status note, addressed to someone else, a job for the tool, a repeat of another card, or busywork.";
  const HELP_SAME = "<b>Yes</b> only if doing one makes the other pointless. A series (email 1 vs 2) or the same change on different things is <b>No</b>.";
  const cardsHtml = judged
    .map(
      (j, i) => `<section class="card" data-n="${i + 1}">
<div class="meta">${i + 1} / ${judged.length} &middot; <b>${esc(j.company ?? j.tenant)}</b> &middot; ${esc(j.channel)}${j.site ? ` &middot; <a href="${esc(j.site)}" target="_blank" rel="noopener">open their site</a>` : ""}</div>
<h3>${esc(j.title)}</h3>
<pre class="body">${esc(j.card)}</pre>
${q(j.id, "TRUE", "1. Is every fact about the company true?", HELP_TRUE)}
${q(j.id, "WORTH_NOW", "2. Worth doing now?", HELP_WORTH)}</section>`,
    )
    .join("\n");
  const pairsHtml = pairs
    .map((p) => `<section class="card"><p class="pair">A: ${esc(p.a)}<br>B: ${esc(p.b)}</p>${q(p.id, "SAME_WORK", "Same piece of work?", HELP_SAME)}</section>`)
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Card labels</title>
<style>:root{--bg:#f7f7f5;--card:#fff;--fg:#151515;--mut:#666;--line:#e3e3e0;--yes:#1f8a4c;--no:#c0392b;--skip:#888}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1b1b1b;--fg:#eee;--mut:#9a9a9a;--line:#333}}
body{background:var(--bg);color:var(--fg);font:16px/1.5 system-ui;max-width:900px;margin:0 auto;padding:16px 16px 120px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
.meta{color:var(--mut);font-size:14px}.meta a{color:inherit}h3{margin:6px 0 10px;font-size:19px}
pre.body{white-space:pre-wrap;font:14px/1.5 ui-monospace,monospace;background:var(--bg);border-radius:8px;padding:12px;max-height:420px;overflow:auto;margin:0 0 12px}
.q{display:flex;gap:16px;justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding:12px 0;flex-wrap:wrap}
.ql{flex:1;min-width:260px}.help{color:var(--mut);font-size:13px;margin-top:2px}.opts{display:flex;gap:8px}
.opt input{display:none}.opt span{display:inline-block;padding:10px 18px;border:1px solid var(--line);border-radius:999px;cursor:pointer;min-width:48px;text-align:center}
.opt.yes input:checked+span{background:var(--yes);color:#fff;border-color:var(--yes)}.opt.no input:checked+span{background:var(--no);color:#fff;border-color:var(--no)}
.opt.skip input:checked+span{background:var(--skip);color:#fff;border-color:var(--skip)}.pair{margin:0 0 8px}
.bar{position:fixed;left:0;right:0;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:12px 16px;display:flex;gap:16px;justify-content:center;align-items:center}
button{font:inherit;padding:10px 20px;border-radius:999px;border:0;background:var(--fg);color:var(--bg);cursor:pointer}</style></head><body>
<h1>Label the cards</h1>
<p>Answer from what you know. <b>Skip whenever you are unsure</b>: a skip never counts. The AI judges' answers are hidden on purpose. Progress saves when you press Save.</p>
${cardsHtml}${pairs.length ? `<h2>Possible duplicates</h2>${pairsHtml}` : ""}
<div class="bar"><span id="prog"></span><button onclick="save()">Save labels.json</button></div>
<script>const total=document.querySelectorAll('.q').length;function upd(){document.getElementById('prog').textContent=document.querySelectorAll('input:checked').length+' / '+total+' answered'}document.addEventListener('change',upd);upd();
function save(){const o={};document.querySelectorAll('input:checked').forEach(i=>{const [k,id]=i.name.split(':');(o[id]=o[id]||{})[k]=i.value});const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(o,null,1)],{type:'application/json'}));a.download='labels.json';a.click()}</script>
</body></html>`;
}

export function agreement(items, labels, key) {
  let tp = 0, fn = 0, tn = 0, fp = 0, unchecked = 0;
  for (const it of items) {
    const human = labels[it.id]?.[key];
    if (human !== "yes" && human !== "no") continue;
    const j = it[key]?.pass;
    if (j === null || j === undefined) {
      unchecked++;
      continue;
    }
    const humanFail = human === "no";
    const judgeFail = j === false;
    if (key === "SAME_WORK") {
      if (human === "yes") j ? tp++ : fn++;
      else j ? fp++ : tn++;
      continue;
    }
    if (humanFail) judgeFail ? tp++ : fn++;
    else judgeFail ? fp++ : tn++;
  }
  const r = (a, b) => (a + b ? (a / (a + b)).toFixed(2) : "-");
  return { key, labelled: tp + fn + tn + fp, unchecked, tp, fn, tn, fp, TPR: r(tp, fn), TNR: r(tn, fp) };
}

function score(dir) {
  const labels = JSON.parse(readFileSync(join(dir, "labels.json"), "utf8"));
  const judged = JSON.parse(readFileSync(join(dir, "judged.json"), "utf8"));
  const pairs = existsSync(join(dir, "pairs-judged.json")) ? JSON.parse(readFileSync(join(dir, "pairs-judged.json"), "utf8")) : [];
  const rows = [
    ...CARD_JUDGES.map((k) => agreement(judged, labels, k)).filter((r) => r.labelled > 0 || r.key === "TRUE" || r.key === "WORTH_NOW"),
    agreement(pairs, labels, "SAME_WORK"),
  ];
  console.log("| judge | labelled | TPR (catches real fails) | TNR (passes real passes) | could-not-check |");
  console.log("|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.key} | ${r.labelled} | ${r.TPR} (${r.tp}/${r.tp + r.fn}) | ${r.TNR} (${r.tn}/${r.tn + r.fp}) | ${r.unchecked} |`);
  console.log("\nWith fewer than ~30 labels per judge these are directional only.");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = arg("--score");
  (s ? Promise.resolve(score(s)) : judge()).catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
