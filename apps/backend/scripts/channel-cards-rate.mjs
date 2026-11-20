#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardsDb, checkChannel, pickTenants } from "./channel-cards-db.mjs";

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const onlyTenant = arg("--tenant");
const onlyChannel = arg("--channel");
const outDir = arg("--out");

export const CAP = 5;
export const STALE_DAYS = 7;
export const NEAR_DUP = 0.5;
export const MANY_BLANKS = 3;
export const DRAFT_TYPES = new Set(["text_post", "image_post", "video_post"]);
export const RETAIN_OVERFLOW = new Set(["chatgpt_ads"]);
export const REQUIRE_CLIENT = new Set(["chatgpt_ads"]);
export const isCustomer = (r) => {
  const resp = r.step?.responsibility;
  return REQUIRE_CLIENT.has(r.channel_slug) ? resp === "client" : resp !== "zavi";
};

const STOP = new Set(
  "a an the to on in of for and or your you with from at by is are be this that it its as into our my now today".split(" "),
);

export function tokens(s) {
  return new Set(
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9$% ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOP.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, "")),
  );
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}

export const OPEN = (r, now = Date.now()) =>
  r.status === "pending" || (r.status === "snoozed" && (!r.snoozed_until || Date.parse(r.snoozed_until) <= now));

export function visibleText(step) {
  const d = step?.deliverable;
  return [step?.title, step?.body, d?.label, d?.content].filter(Boolean).join("\n");
}

const LEAK = [
  /\baction #\d/i,
  /\[[0-9a-f]{8}\]/i,
  /(?<![\/=\w-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i,
  /\bpublish gates?\b/i,
  /\b(run_id|tool_call|tenant_id|exec_class)\b/,
  /^zavi:/i,
  /\bmanual card\b/i,
  /\bstep \d+ above\b/i,
];
const BLANK = /\[(?:CONFIRM|OPERATOR[^\]]*|TODO|FILL[^\]]*)[:\]]/gi;
const NON_ACTION = /^(no|nothing|none|skip|optional)\b/i;

export function rateCard(card, ctx) {
  const step = card.step ?? {};
  const text = visibleText(step);
  const fails = {};
  const t = tokens(card.title);

  fails.NON_ACTION = NON_ACTION.test(card.title.trim());
  fails.NO_DELIVERABLE = !step.deliverable?.content && !card.exec_class;
  fails.INTERNAL_LEAK = LEAK.some((re) => re.test(text));
  const blanks = (text.match(BLANK) ?? []).length;
  fails.MANY_BLANKS = blanks > MANY_BLANKS;
  fails.STALE = (ctx.now - Date.parse(card.proposed_at)) / 86400000 > STALE_DAYS;

  const chanOpen = ctx.open.filter((o) => o.channel_slug === card.channel_slug);
  const side = (r) => DRAFT_TYPES.has(r.action_type);
  const sameSide = chanOpen.filter((o) => isCustomer(o) && side(o) === side(card));
  fails.OVER_CAP = !RETAIN_OVERFLOW.has(card.channel_slug) && isCustomer(card) && sameSide.length > CAP;
  const newestRun = chanOpen.reduce((m, o) => (o.proposed_at > m.proposed_at ? o : m), chanOpen[0]);
  fails.SUPERSEDED_OPEN = !!newestRun && card.run_id !== newestRun.run_id;

  const dupOf = (pool) =>
    pool
      .filter((o) => o.id !== card.id)
      .map((o) => ({ o, sim: jaccard(t, o._t) }))
      .filter((x) => x.sim >= NEAR_DUP)
      .sort((a, b) => b.sim - a.sim)[0];
  const sameChan = dupOf(chanOpen);
  const crossChan = dupOf(ctx.open.filter((o) => o.channel_slug !== card.channel_slug));
  const done = dupOf(ctx.rows.filter((o) => o.status === "acted"));
  const rejected = dupOf(ctx.rows.filter((o) => o.status === "rejected"));
  fails.DUP_IN_CHANNEL = !!sameChan;
  fails.DUP_CROSS_CHANNEL = !!crossChan;
  fails.ALREADY_DONE = !!done;
  fails.REJECTED_AGAIN = !!rejected;

  const matches = { sameChan, crossChan, done, rejected };
  return { fails, blanks, matches };
}

export const SOFT = new Set(["NO_DELIVERABLE", "STALE", "SUPERSEDED_OPEN"]);

export const CHECKS = [
  "DUP_IN_CHANNEL",
  "DUP_CROSS_CHANNEL",
  "ALREADY_DONE",
  "REJECTED_AGAIN",
  "SUPERSEDED_OPEN",
  "OVER_CAP",
  "STALE",
  "NON_ACTION",
  "NO_DELIVERABLE",
  "MANY_BLANKS",
  "INTERNAL_LEAK",
];

async function main() {
  if (onlyChannel) checkChannel(onlyChannel);
  const db = cardsDb({ prod: args.includes("--prod") });
  const targets = pickTenants(await db.tenants(), onlyTenant);
  if (onlyTenant && !targets.length) throw new Error(`no tenant with cards matches --tenant ${onlyTenant} (${db.source})`);

  const now = Date.now();
  const all = [];
  const pairs = [];
  for (const tn of targets) {
    const rows = await db.actions(tn.id);
    for (const r of rows) r._t = tokens(r.title);
    const open = rows.filter((r) => OPEN(r, now));
    const ctx = { rows, open, now };
    for (const card of open) {
      if (onlyChannel && card.channel_slug !== onlyChannel) continue;
      const { fails, blanks, matches } = rateCard(card, ctx);
      all.push({ tenant: tn.slug, kind: tn.kind, id: card.id, channel: card.channel_slug, title: card.title, blanks, fails });
      for (const [kind, m] of Object.entries(matches)) {
        const bothRated = kind === "sameChan" || (kind === "crossChan" && !onlyChannel);
        if (m && (!bothRated || card.id < m.o.id)) {
          pairs.push({ tenant: tn.slug, channel: card.channel_slug, kind, sim: +m.sim.toFixed(2), a: `${card.channel_slug}: ${card.title}`, b: `${m.o.channel_slug} [${m.o.status}]: ${m.o.title}` });
        }
      }
    }
  }

  const scope = `${db.source}; tenant ${onlyTenant ?? "all"}; channel ${onlyChannel ?? "all"}`;
  if (!all.length) {
    console.log(`No open cards (${scope}).`);
    return;
  }
  const report = render(all, pairs, scope);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "report.md"), report);
    writeFileSync(join(outDir, "cards.json"), JSON.stringify(all, null, 1));
    writeFileSync(join(outDir, "pairs.json"), JSON.stringify(pairs, null, 1));
  }
  console.log(report);
}

function pct(n, d) {
  return d ? `${Math.round((100 * n) / d)}%` : "-";
}

function render(all, pairs, scope) {
  const clean = (c) => CHECKS.every((k) => SOFT.has(k) || !c.fails[k]);
  const lines = [];
  const tenants = [...new Set(all.map((c) => c.tenant))];
  lines.push(`# Channel card rating (Layer A, deterministic) ${new Date().toISOString().slice(0, 10)}`);
  lines.push("");
  lines.push(`Source: ${scope}.`);
  lines.push(`${all.length} open cards, ${tenants.length} tenants. CLEAN = trips no hard check (soft: ${[...SOFT].join(", ")}).`);
  lines.push("");
  lines.push("## Failure rate per check (all tenants)");
  lines.push("| check | cards | rate |");
  lines.push("|---|---|---|");
  for (const k of CHECKS) {
    const n = all.filter((c) => c.fails[k]).length;
    lines.push(`| ${k}${SOFT.has(k) ? " (soft)" : ""} | ${n} | ${pct(n, all.length)} |`);
  }
  const nc = all.filter(clean).length;
  lines.push(`| **CLEAN** | ${nc} | ${pct(nc, all.length)} |`);
  lines.push("");
  lines.push("## Per tenant");
  lines.push(`| tenant | open | clean | ${CHECKS.join(" | ")} |`);
  lines.push(`|---|---|---|${CHECKS.map(() => "---").join("|")}|`);
  for (const t of tenants) {
    const cs = all.filter((c) => c.tenant === t);
    lines.push(`| ${t} | ${cs.length} | ${cs.filter(clean).length} | ${CHECKS.map((k) => cs.filter((c) => c.fails[k]).length).join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Per channel (all tenants)");
  const chans = [...new Set(all.map((c) => c.channel))].sort();
  lines.push(`| channel | open | clean | ${CHECKS.join(" | ")} |`);
  lines.push(`|---|---|---|${CHECKS.map(() => "---").join("|")}|`);
  for (const ch of chans) {
    const cs = all.filter((c) => c.channel === ch);
    lines.push(`| ${ch} | ${cs.length} | ${cs.filter(clean).length} | ${CHECKS.map((k) => cs.filter((c) => c.fails[k]).length).join(" | ")} |`);
  }
  lines.push("");
  lines.push("## Cards that trip a check");
  for (const c of all) {
    const hard = CHECKS.filter((k) => c.fails[k] && !SOFT.has(k));
    const soft = CHECKS.filter((k) => c.fails[k] && SOFT.has(k));
    if (hard.length || soft.length) lines.push(`- [${c.tenant}] ${c.channel}: ${c.title} :: ${[...hard, ...soft.map((k) => `${k} (soft)`)].join(", ")}`);
  }
  lines.push("");
  lines.push(`## Similar-title pairs (Jaccard >= ${NEAR_DUP}); label these by hand to set the threshold`);
  for (const p of pairs.sort((a, b) => b.sim - a.sim)) lines.push(`- ${p.sim} ${p.kind} [${p.tenant}] ${p.a}  <->  ${p.b}`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
