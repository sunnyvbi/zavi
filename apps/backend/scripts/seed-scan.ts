
import "tsconfig-paths/register";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { resolve, sep } from "node:path";

import { checkRef, insideRepo, parseEnvFile, positiveInt, parseMemoryFree, parityVerdict, readManifest } from "@/services/start-card/seed/cli";

const PROD_REF = "wmycgyjsenvgtczlupoe";
const PRIVACY_VERSION = "2026-10-12";
const LEASE_TTL_MS = 15 * 60_000;

type Args = { cmd: string; pos: string[]; flags: Record<string, string> };

function parseArgs(argv: string[]): Args {
  const [cmd = "", ...rest] = argv;
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith("--")) flags[a.slice(2)] = "1";
      else {
        flags[a.slice(2)] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

function repoRoot(): string {
  return realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
}

function loadEnv(file: string | undefined, keepApiKeys: boolean): void {
  if (!file) throw new Error("--env <file> is required (a file outside the repo)");
  const path = realpathSync(resolve(file));
  const root = repoRoot();
  if (insideRepo(path, root, sep)) throw new Error(`refusing env file inside the repo: ${path}`);
  const env = parseEnvFile(readFileSync(path, "utf8"));
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  if (!keepApiKeys) {
    for (const k of ["ANTHROPIC_API_KEY", "ANCHOR_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKENS"]) delete process.env[k];
  }
}

function assertRef(expect: string): void {
  checkRef(process.env.SUPABASE_URL ?? "", expect);
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY missing");
}

function memoryFreePct(): Promise<number> {
  try {
    return Promise.resolve(parseMemoryFree(execFileSync("memory_pressure", { encoding: "utf8" })));
  } catch {
    return Promise.resolve(100);
  }
}

async function cmdCreate(a: Args) {
  const cap = Number(a.flags.cap);
  if (!Number.isFinite(cap) || cap <= 0) throw new Error("--cap <usd> is required");
  if (!a.flags.manifest) throw new Error("--manifest <file> is required");
  const items = readManifest(readFileSync(a.flags.manifest, "utf8"));
  const seed = await import("@/services/start-card/seed/store");
  const { SEED_SCORER_VERSION } = await import("@/services/start-card/seed/run-card");
  const id = await seed.createRun({
    manifest_hash: seed.manifestHash(items),
    pipeline_version: String(SEED_SCORER_VERSION),
    privacy_version: PRIVACY_VERSION,
    spend_cap_usd: cap,
  });
  await seed.addItems(id, items);
  console.log(`run ${id}: ${items.length} sites, cap $${cap}`);
}

async function cmdStatus(a: Args) {
  const runId = a.pos[0];
  const seed = await import("@/services/start-card/seed/store");
  const { globalClient } = await import("@/services/tenant-client");
  const run = await seed.getRun(runId);
  if (!run) throw new Error(`no run ${runId}`);
  const { data, error } = await globalClient().from("seed_run_items").select("state").eq("run_id", runId).limit(5000);
  if (error) throw new Error(error.message);
  const counts: Record<string, number> = {};
  for (const r of (data ?? []) as Array<{ state: string }>) counts[r.state] = (counts[r.state] ?? 0) + 1;
  console.log(JSON.stringify({ run: run.id, status: run.status, spent_usd: run.spent_usd, cap_usd: run.spend_cap_usd, items: counts }, null, 2));
}

async function cmdRun(a: Args) {
  const runId = a.pos[0];
  if (!runId) throw new Error("run <run_id>");
  const concurrency = Math.min(4, positiveInt(a.flags.concurrency ?? "2", "--concurrency"));
  const maxAttempts = positiveInt(a.flags["max-attempts"] ?? "2", "--max-attempts");

  const seed = await import("@/services/start-card/seed/store");
  const { startGuardProxy } = await import("@/services/start-card/seed/guard-proxy");
  const { localRenderSites } = await import("@/services/start-card/seed/local-render");
  const { claudeCli } = await import("@/services/start-card/seed/local-model");
  const { seedStages, runSeedCard } = await import("@/services/start-card/seed/run-card");
  const { runSeedLoop } = await import("@/services/start-card/seed/runner");
  const { admitSite } = await import("@/services/start-card/admission");
  const store = await import("@/services/start-card/store");
  const pipeline = await import("@/services/start-card/pipeline");
  const { SCORER_VERSION } = await import("@/services/start-card/stages");

  const run = await seed.getRun(runId);
  if (!run) throw new Error(`no run ${runId}`);
  if (run.status !== "open") throw new Error(`run ${runId} is ${run.status}`);

  const proxy = await startGuardProxy();
  const cli = claudeCli();
  const stages = seedStages({ complete: cli.complete, enrichment: cli.enrichment, render: localRenderSites({ proxy }) });
  const holder = `${hostname()}:${process.pid}`;
  let stop = false;
  process.on("SIGINT", () => {
    if (stop) process.exit(130);
    stop = true;
    console.log("\n[seed-scan] stopping after the current sites (Ctrl-C again to quit now)");
  });

  try {
    const summary = await runSeedLoop(
      runId,
      stages,
      {
        admit: async (domain) => {
          const r = await admitSite(`https://${domain}/`);
          return r.ok ? { ok: true, domain: seed.canonicalDomain(r.site.domain) } : { ok: false, reason: "code" in r ? r.code : "refused" };
        },
        reserve: seed.reserve,
        settle: seed.settle,
        claim: store.claimSeedCard,
        getCard: store.getCardById,
        runCard: (card, s) =>
          runSeedCard(card, s, {
            runStage: pipeline.runAndWriteStage,
            applyProfile: pipeline.applyProfileToRow,
            saveScore: (id, score, parts) => store.updateCard(id, { score, scorer_version: SCORER_VERSION, evidence: { parts } } as never),
          }),
        finish: pipeline.finishCard,
        fail: pipeline.failCard,
        setItem: seed.setItem,
        log: (l) => console.log(l),
        pending: seed.pendingItems,
        takeLease: (id) => seed.takeLease(id, holder, LEASE_TTL_MS),
        memoryFreePct,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        shouldStop: () => stop,
      },
      { concurrency, maxAttempts },
    );
    const after = await seed.getRun(runId);
    console.log(JSON.stringify({ ...summary, spent_usd: after?.spent_usd, cap_usd: after?.spend_cap_usd, blocked_requests: proxy.blocked() }));
  } finally {
    await seed.releaseLease(runId, holder).catch(() => {});
    await proxy.close();
  }
}

async function cmdParity(a: Args) {
  if (!process.env.ANTHROPIC_API_KEY || !process.env.ANCHOR_API_KEY) throw new Error("parity needs ANTHROPIC_API_KEY and ANCHOR_API_KEY in the env file");
  const n = positiveInt(a.flags.n ?? "20", "--n");
  const items = readManifest(readFileSync(a.flags.manifest, "utf8")).slice(0, n);
  const { startGuardProxy } = await import("@/services/start-card/seed/guard-proxy");
  const { localRenderSites } = await import("@/services/start-card/seed/local-render");
  const { claudeCli } = await import("@/services/start-card/seed/local-model");
  const { runProfile } = await import("@/services/start-card/checks/profile");
  const { runEnrichment } = await import("@/services/onboarding/enrichment/run");
  const { renderSitesOnPhone } = await import("@/services/start-card/checks/render");
  const { rivalDesignPoints } = await import("@/services/start-card/checks/points");
  const { contextFor } = await import("@/services/start-card/pipeline");
  const { canonicalDomain } = await import("@/services/start-card/seed/store");

  const proxy = await startGuardProxy();
  const cli = claudeCli();
  const localRender = localRenderSites({ proxy });
  const rows: Array<{ domain: string; renderDelta: number | null; termMatch: boolean | null; local: string; cloud: string }> = [];
  try {
    for (const it of items) {
      const domain = canonicalDomain(it.domain);
      const ctx = contextFor({ id: "parity", domain }, {});
      const [lr, cr, lp, cp] = await Promise.all([
        localRender([ctx.url]).then((r) => rivalDesignPoints(r?.[0] ?? null)),
        renderSitesOnPhone([ctx.url]).then((r) => rivalDesignPoints(r?.[0] ?? null)),
        runProfile(ctx, { complete: cli.complete, enrich: (i) => runEnrichment(i, { complete: cli.enrichment }) }).then((o) => o.evidence.search_term, () => null),
        runProfile(ctx).then((o) => o.evidence.search_term, () => null),
      ]);
      const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
      const row = {
        domain,
        renderDelta: lr !== null && cr !== null ? lr - cr : null,
        termMatch: lp && cp ? norm(lp) === norm(cp) : null,
        local: `${lr ?? "-"} / ${lp ?? "-"}`,
        cloud: `${cr ?? "-"} / ${cp ?? "-"}`,
      };
      rows.push(row);
      console.log(`${domain}\tlocal ${row.local}\tcloud ${row.cloud}`);
    }
  } finally {
    await proxy.close();
  }
  const v = parityVerdict(rows);
  console.log(JSON.stringify(v));
  if (!v.pass) process.exitCode = 2;
}

async function cmdNoticesQueue(a: Args) {
  const runId = a.pos[0];
  if (!runId) throw new Error("notices-queue <run_id>");
  const ns = await import("@/services/start-card/seed/notice-store");
  const { enqueueNotices, discoverContact } = await import("@/services/start-card/seed/notices");
  const r = await enqueueNotices(
    runId,
    {
      doneItems: ns.doneItems,
      hasNotice: ns.hasNotice,
      discover: (d) => discoverContact(d, ns.fetchSiteText),
      insertNotice: ns.insertNotice,
      markChecked: ns.markChecked,
      log: (l) => console.log(l),
    },
    { limit: positiveInt(a.flags.limit ?? "1000", "--limit") },
  );
  console.log(JSON.stringify(r));
}

function noticeSender(a: Args): { from: { email: string; name: string }; apiKey: string } {
  const email = process.env.SEED_NOTICE_FROM_EMAIL?.trim().toLowerCase();
  const key = process.env.SEED_NOTICE_SENDGRID_API_KEY?.trim();
  const system = { email: "support@zaviagent.com", name: "Zavi" };
  if (email && key) {
    if (email === system.email) throw new Error("SEED_NOTICE_FROM_EMAIL must not be the sign-in sender");
    if (key === process.env.SYSTEM_SENDGRID_API_KEY) throw new Error("SEED_NOTICE_SENDGRID_API_KEY must not be the sign-in key");
    return { from: { email, name: process.env.SEED_NOTICE_FROM_NAME?.trim() || "Zavi" }, apiKey: key };
  }
  if (a.flags["allow-system-sender"] === "1" && process.env.SYSTEM_SENDGRID_API_KEY) {
    return { from: system, apiKey: process.env.SYSTEM_SENDGRID_API_KEY };
  }
  throw new Error(
    "set SEED_NOTICE_FROM_EMAIL and SEED_NOTICE_SENDGRID_API_KEY (a notice-only sender and SendGrid subuser), or pass --allow-system-sender",
  );
}

async function cmdNoticesTest(a: Args) {
  const to = (a.flags.to ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("--to <email> is required");
  const runId = a.pos[0];
  if (!runId) throw new Error("usage: notices-test <run_id> --to <email> [--send]");
  const ns = await import("@/services/start-card/seed/notice-store");
  const { noticeArgs } = await import("@/services/start-card/seed/notices");
  const { sendSeedNoticeEmail } = await import("@/email/sendAuthEmail");
  const { getCardById } = await import("@/services/start-card/store");
  const { webBaseUrl } = await import("@/services/web-base");
  const [item] = await ns.doneItems(runId, "", 1);
  if (!item) throw new Error(`no done card in run ${runId} yet`);
  const card = await getCardById(item.card_id);
  if (!card || card.status !== "done" || !card.score) throw new Error(`card for ${item.domain} is not showable`);
  const webBase = webBaseUrl().replace(/\/$/, "");
  const apiBase = (process.env.BACKEND_PUBLIC_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/(www\.)?zaviagent\.com$/.test(webBase)) throw new Error(`refusing to email links to ${webBase}`);
  if (!/^https:\/\/api\.zaviagent\.com$/.test(apiBase)) throw new Error(`refusing to email an unsubscribe link to ${apiBase || "(unset)"}`);
  const args = noticeArgs(card as never, { email: to, noticeKey: `test-${randomUUID()}`, source: item.source, webBase, apiBase });
  if (a.flags.send !== "1") {
    console.log(`[seed-notice] would send the ${item.domain} notice to ${to} (dry run; add --send)`);
    return;
  }
  const { messageId } = await sendSeedNoticeEmail({ ...args, ...noticeSender(a) } as never);
  console.log(`[seed-notice] test sent: ${item.domain} -> ${to} (message ${messageId}); nothing recorded`);
}

async function cmdNoticesSend(a: Args) {
  const ns = await import("@/services/start-card/seed/notice-store");
  const { sendNotices } = await import("@/services/start-card/seed/notices");
  const { sendSeedNoticeEmail } = await import("@/email/sendAuthEmail");
  const { getCardById } = await import("@/services/start-card/store");
  const { webBaseUrl } = await import("@/services/web-base");
  const send = a.flags.send === "1";
  const perDay = positiveInt(a.flags["per-day"] ?? "100", "--per-day");
  const webBase = webBaseUrl().replace(/\/$/, "");
  const apiBase = (process.env.BACKEND_PUBLIC_URL ?? "").replace(/\/+$/, "");
  const sender = send ? noticeSender(a) : { from: { email: "dry-run@example.invalid", name: "Zavi" }, apiKey: "" };
  if (send) {
    if (!/^https:\/\/(www\.)?zaviagent\.com$/.test(webBase)) throw new Error(`refusing to email links to ${webBase}`);
    if (!/^https:\/\/api\.zaviagent\.com$/.test(apiBase)) throw new Error(`refusing to email an unsubscribe link to ${apiBase || "(BACKEND_PUBLIC_URL unset)"}`);
  }
  const r = await sendNotices(
    {
      pending: ns.pendingNotices,
      sentToday: () => ns.claimedToday(),
      claim: (domain) => ns.claimNotice(domain, perDay),
      getCard: getCardById as never,
      send: (args) => sendSeedNoticeEmail({ ...args, ...sender } as never),
      accepted: ns.noticeAccepted,
      markFailed: ns.markNoticeFailed,
      release: ns.releaseNotice,
      webBase,
      apiBase,
      log: (l) => console.log(l),
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    },
    { limit: positiveInt(a.flags.limit ?? "25", "--limit"), perDay, dryRun: !send, gapMs: 1500 },
  );
  console.log(JSON.stringify(r));
}

async function cmdNoticesStuck() {
  const ns = await import("@/services/start-card/seed/notice-store");
  const rows = await ns.stuckNotices();
  for (const r of rows) console.log(`${r.domain}\t${r.state}\tclaimed ${r.claimed_at ?? "-"}\tkey ${r.idempotency_key}\t${r.error ?? ""}`);
  console.log(`${rows.length} notice(s) need a person. Search SendGrid activity for the key (custom arg seed_notice_key):`);
  console.log("  found -> notices-record <domain> <message_id>   (records the send and lists the card)");
  console.log("  not found -> leave it; it is never sent automatically");
}

async function cmdNoticesRecord(a: Args) {
  const [domain, messageId] = a.pos;
  if (!domain || !messageId) throw new Error("notices-record <domain> <provider_message_id>");
  const ns = await import("@/services/start-card/seed/notice-store");
  const { canonicalDomain } = await import("@/services/start-card/seed/store");
  console.log(await ns.recordConfirmedSend(canonicalDomain(domain), messageId));
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  loadEnv(a.flags.env, a.cmd === "parity");
  assertRef(a.flags["expect-ref"] ?? PROD_REF);
  if (a.cmd === "create") return cmdCreate(a);
  if (a.cmd === "run") return cmdRun(a);
  if (a.cmd === "status") return cmdStatus(a);
  if (a.cmd === "parity") return cmdParity(a);
  if (a.cmd.startsWith("notices-")) {
    process.env.WEB_BASE_URL ||= "https://www.zaviagent.com";
    process.env.BACKEND_PUBLIC_URL ||= "https://api.zaviagent.com";
  }
  if (a.cmd === "notices-queue") return cmdNoticesQueue(a);
  if (a.cmd === "notices-send") return cmdNoticesSend(a);
  if (a.cmd === "notices-test") return cmdNoticesTest(a);
  if (a.cmd === "notices-stuck") return cmdNoticesStuck();
  if (a.cmd === "notices-record") return cmdNoticesRecord(a);
  throw new Error("usage: seed-scan.ts create|run|status|parity|notices-queue|notices-send|notices-test|notices-stuck|notices-record ... --env <file>");
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`[seed-scan] ${(e as Error).message}`);
    process.exit(1);
  });
}
