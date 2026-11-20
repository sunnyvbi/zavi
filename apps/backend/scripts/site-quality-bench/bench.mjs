#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BENCH_DIR, findBrief, loadBriefs, loadRecordEntries } from "./lib/io.mjs";
import { captureSite, deriveRunMetrics, missingLiveEnv, readRunFromDb } from "./lib/collect.mjs";
import { assertValidRecord } from "./lib/schema.mjs";
import { isPng, stripPngMetadata } from "./lib/png.mjs";
import { serveStatic } from "./lib/serve.mjs";
import { unblind, writeBlindPack } from "./lib/blind.mjs";
import { buildReport } from "./lib/report.mjs";

export const USAGE = `site-quality-bench

  collect --run <conductor_run_id> --brief <id> (--url <url> | --serve <dir>) [--out <dir>] [--live]
          [--provenance mocked|hand_written_demo] [--playwright <module path>]
  import-manual --system lovable|other --brief <id> --desktop <png> --mobile <png> [--url <url>] [--out <dir>]
          [--first-preview-s <n>] [--complete-s <n>] [--cost-usd <n>]
  blind-pack --records <dir> --out <dir> --key <file outside out> [--seed <s>] [--systems zavi,lovable] [--allow-mocked]
  unblind --key <file> --ratings <file>[,<file>...] [--out <file>]
  report --records <dir>[,<dir>...] [--joined <file>] [--systems zavi,lovable] [--json]
  validate --records <dir>[,<dir>...]
`;

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new UsageError(`unexpected argument ${a}`);
    const name = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      i++;
    }
  }
  return { cmd, flags };
}

export class UsageError extends Error {}

function need(flags, name) {
  const v = flags[name];
  if (v === undefined || v === true) throw new UsageError(`--${name} is required`);
  return v;
}

function list(v) {
  return String(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function optNumber(flags, name) {
  if (flags[name] === undefined) return null;
  const n = Number(flags[name]);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number`);
  return n;
}

function writeRecord(outDir, record) {
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${record.run_id}.record.json`);
  assertValidRecord(record, { filePath: file });
  writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  return file;
}

function relShots(outDir, shots) {
  return { desktop: shots.desktop ? relative(outDir, shots.desktop) : null, mobile: shots.mobile ? relative(outDir, shots.mobile) : null };
}

async function cmdCollect(flags, io) {
  const live = flags.live === true;
  if (live) {
    const missing = missingLiveEnv(io.env);
    if (missing.length) {
      throw new UsageError(
        `collect --live needs ${missing.join(" and ")} in the environment (run from apps/backend with node --env-file=<env file>). Nothing was read. Live reads touch a shared database and need Mohit's or Ravi's approval.`,
      );
    }
  }
  const runId = need(flags, "run");
  const brief = findBrief(io.briefs, need(flags, "brief"));
  if (!flags.url && !flags.serve) throw new UsageError("collect needs --url <url> or --serve <static dir>");
  const provenance = live ? "actual_ai_build" : flags.provenance || "mocked";
  if (!live && !["mocked", "hand_written_demo"].includes(provenance)) {
    throw new UsageError("a dry collect can only record provenance mocked or hand_written_demo; actual_ai_build requires --live");
  }
  const outDir = resolve(flags.out || join(BENCH_DIR, "results", "collected"));
  let metrics = { timings: { to_first_preview_s: null, to_usable_complete_s: null }, cost: { usd: null, source: "dry-run: not read" }, repairs: null, failures: [] };
  if (live) {
    const db = await io.createDb();
    const { run, attempts } = await readRunFromDb(db, runId);
    metrics = deriveRunMetrics(run, attempts);
  }
  let server = null;
  let url = flags.url;
  if (flags.serve) {
    server = await serveStatic(resolve(flags.serve));
    url = server.url;
  }
  try {
    const cap = await captureSite({ url, outDir: join(outDir, "shots"), baseName: runId, brief, playwrightModule: flags.playwright || io.playwrightModule });
    const record = {
      run_id: runId,
      brief_id: brief.id,
      system: "zavi",
      provenance,
      captured_at: io.now().toISOString(),
      urls: { site: flags.serve ? null : url },
      screenshots: relShots(outDir, cap.screenshots),
      timings: metrics.timings,
      cost: metrics.cost,
      repairs: metrics.repairs,
      failures: metrics.failures,
      journeys: cap.journeys,
      requirement_coverage: cap.requirement_coverage,
      scores: null,
    };
    const file = writeRecord(outDir, record);
    io.out(`wrote ${file} (provenance ${provenance}${live ? "" : ", dry run: timings, cost and repairs not read"})\n`);
    return { file, record };
  } finally {
    if (server) await server.close();
  }
}

function cmdImportManual(flags, io) {
  const system = need(flags, "system");
  if (!["lovable", "other"].includes(system)) throw new UsageError("import-manual is for competitor outputs: --system lovable|other");
  const brief = findBrief(io.briefs, need(flags, "brief"));
  const stamp = io.now();
  const runId = `manual-${system}-${brief.id}-${stamp.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const outDir = resolve(flags.out || join(BENCH_DIR, "results", "manual"));
  const shotDir = join(outDir, "shots");
  mkdirSync(shotDir, { recursive: true });
  const shots = {};
  for (const vp of ["desktop", "mobile"]) {
    const src = resolve(need(flags, vp));
    const buf = readFileSync(src);
    if (!isPng(buf)) throw new UsageError(`--${vp} ${basename(src)} is not a PNG`);
    const dest = join(shotDir, `${runId}-${vp}.png`);
    writeFileSync(dest, stripPngMetadata(buf));
    shots[vp] = dest;
  }
  const record = {
    run_id: runId,
    brief_id: brief.id,
    system,
    provenance: "manual_import",
    captured_at: stamp.toISOString(),
    urls: { site: typeof flags.url === "string" ? flags.url : null },
    screenshots: relShots(outDir, shots),
    timings: { to_first_preview_s: optNumber(flags, "first-preview-s"), to_usable_complete_s: optNumber(flags, "complete-s") },
    cost: { usd: optNumber(flags, "cost-usd"), source: flags["cost-usd"] !== undefined ? "manual: entered by importer" : "manual: not recorded" },
    repairs: null,
    failures: [],
    journeys: [],
    requirement_coverage: [],
    scores: null,
  };
  const file = writeRecord(outDir, record);
  io.out(`wrote ${file} (provenance manual_import)\n`);
  return { file, record };
}

function loadOrFail(paths, io) {
  const { entries, errors } = loadRecordEntries(paths, { briefIds: io.briefs.map((b) => b.id) });
  if (errors.length) throw new UsageError(`invalid records:\n  ${errors.join("\n  ")}`);
  return entries;
}

function cmdBlindPack(flags, io) {
  const entries = loadOrFail(list(need(flags, "records")), io);
  const outDir = resolve(need(flags, "out"));
  const keyPath = resolve(need(flags, "key"));
  const res = writeBlindPack({
    entries,
    briefs: io.briefs,
    outDir,
    keyPath,
    seed: typeof flags.seed === "string" ? flags.seed : null,
    systems: flags.systems ? list(flags.systems) : ["zavi", "lovable"],
    allowNonEvidence: flags["allow-mocked"] === true,
    now: io.now(),
  });
  io.out(`wrote rater pack ${outDir} (${res.items.length} briefs) and key ${keyPath}\n`);
  for (const s of res.skipped) io.out(`skipped ${s.brief_id}: ${s.reason}\n`);
  if (res.key.contains_non_evidence) io.out("note: pack contains mocked or demo outputs; ratings are practice only\n");
  return res;
}

function cmdUnblind(flags, io) {
  const key = JSON.parse(readFileSync(resolve(need(flags, "key")), "utf8"));
  const docs = list(need(flags, "ratings")).map((f) => JSON.parse(readFileSync(resolve(f), "utf8")));
  const { rows, errors } = unblind(key, docs);
  if (errors.length) throw new UsageError(`ratings rejected:\n  ${errors.join("\n  ")}`);
  const out = resolve(flags.out || join(BENCH_DIR, "results", "joined-ratings.json"));
  mkdirSync(resolve(out, ".."), { recursive: true });
  writeFileSync(out, JSON.stringify({ kind: "site-quality-bench/joined-ratings", pack_id: key.pack_id, rows }, null, 2) + "\n");
  io.out(`wrote ${out} (${rows.length} rated sides)\n`);
  return { out, rows };
}

function cmdReport(flags, io) {
  const entries = loadOrFail(list(need(flags, "records")), io);
  const joinedRows = flags.joined ? list(flags.joined).flatMap((f) => JSON.parse(readFileSync(resolve(f), "utf8")).rows) : [];
  const rep = buildReport({ records: entries.map((e) => e.record), joinedRows, systems: flags.systems ? list(flags.systems) : ["zavi", "lovable"] });
  io.out(flags.json === true ? JSON.stringify(rep.data, null, 2) + "\n" : rep.text);
  return rep;
}

function cmdValidate(flags, io) {
  const entries = loadOrFail(list(need(flags, "records")), io);
  io.out(`${entries.length} records valid\n`);
  return entries;
}

export async function run(argv, overrides = {}) {
  const io = {
    env: process.env,
    out: (s) => process.stdout.write(s),
    now: () => new Date(),
    briefs: loadBriefs(),
    playwrightModule: null,
    createDb: async () => {
      const { createScriptClient } = await import("../_supabase-script-client.mjs");
      return createScriptClient();
    },
    ...overrides,
  };
  const { cmd, flags } = parseArgs(argv);
  switch (cmd) {
    case "collect":
      return cmdCollect(flags, io);
    case "import-manual":
      return cmdImportManual(flags, io);
    case "blind-pack":
      return cmdBlindPack(flags, io);
    case "unblind":
      return cmdUnblind(flags, io);
    case "report":
      return cmdReport(flags, io);
    case "validate":
      return cmdValidate(flags, io);
    default:
      throw new UsageError(cmd ? `unknown command ${cmd}` : "no command given");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`site-quality-bench: ${e.message}\n`);
    if (e instanceof UsageError) process.stderr.write(`\n${USAGE}`);
    process.exit(e instanceof UsageError ? 2 : 1);
  });
}
