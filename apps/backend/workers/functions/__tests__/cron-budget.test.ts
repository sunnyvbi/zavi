
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FN_DIR = join(__dirname, "..");

const MAX_FIRES_PER_HOUR = 390;

const ALLOWED_EVERY_MINUTE = new Set(["work-queue-drainer.ts"]);

const NO_DB_IO = new Set(["voice-sidecar-health-ping.ts"]);

type CronHit = { file: string; expr: string; firesPerHour: number };

function firesPerHour(expr: string): number {
  const parts = expr.trim().replace(/^(?:CRON_)?TZ=\S+\s+/, "").split(/\s+/);
  if (parts.length !== 5) throw new Error(`unsupported cron shape: "${expr}"`);
  const [min, hour] = parts;

  const perHour = (() => {
    if (min === "*") return 60;
    if (/^\*\/\d+$/.test(min)) return 60 / Number(min.slice(2));
    if (/^[\d,]+$/.test(min)) return min.split(",").length;
    throw new Error(`unsupported cron minute field: "${expr}"`);
  })();

  if (hour === "*") return perHour;
  if (/^\*\/\d+$/.test(hour)) return (perHour * (24 / Number(hour.slice(2)))) / 24;
  if (/^[\d,]+$/.test(hour)) return (perHour * hour.split(",").length) / 24;
  throw new Error(`unsupported cron hour field: "${expr}"`);
}

function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

function isCommentedOut(src: string, matchIndex: number): boolean {
  const lineStart = src.lastIndexOf("\n", matchIndex) + 1;
  return src.slice(lineStart, matchIndex).includes("//");
}

function workerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...workerFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function collectCrons(): CronHit[] {
  const hits: CronHit[] = [];
  for (const path of workerFiles(FN_DIR)) {
    const src = stripBlockComments(readFileSync(path, "utf8"));
    for (const m of src.matchAll(/cron:\s*["'`]([^"'`]+)["'`]/g)) {
      if (isCommentedOut(src, m.index ?? 0)) continue;
      hits.push({
        file: path.slice(FN_DIR.length + 1),
        expr: m[1],
        firesPerHour: firesPerHour(m[1]),
      });
    }
  }
  return hits;
}

function collectNonLiteralCrons(): string[] {
  const out: string[] = [];
  for (const path of workerFiles(FN_DIR)) {
    const src = stripBlockComments(readFileSync(path, "utf8"));
    for (const m of src.matchAll(/[{,]\s*cron:\s*(?!["'`])(\S[^,\n}]*)/g)) {
      if (isCommentedOut(src, m.index ?? 0)) continue;
      out.push(`${path.slice(FN_DIR.length + 1)}: cron: ${m[1].trim()}`);
    }
  }
  return out;
}

describe("cron budget (standing background load guard)", () => {
  it("parses every cron expression in the fleet", () => {
    expect(() => collectCrons()).not.toThrow();
    expect(collectCrons().length).toBeGreaterThan(50);
  });

  it("does not count commented-out registrations", () => {
    const shadow = collectCrons().filter((c) => c.file.includes("shadow-canary-cron"));
    expect(shadow).toEqual([]);
  });

  it(`keeps the fleet-wide floor at or under ${MAX_FIRES_PER_HOUR} fires/hour`, () => {
    const crons = collectCrons().filter((c) => !NO_DB_IO.has(c.file));
    const total = crons.reduce((n, c) => n + c.firesPerHour, 0);

    const worst = [...crons]
      .sort((a, b) => b.firesPerHour - a.firesPerHour)
      .slice(0, 8)
      .map((c) => `    ${c.firesPerHour.toFixed(1)}/h  ${c.file}  "${c.expr}"`)
      .join("\n");

    expect(
      total,
      `Fleet cron floor is ${total.toFixed(0)} fires/hour, over the ${MAX_FIRES_PER_HOUR}/h budget.\n` +
        `This is a WASTE ceiling for a 1GB Micro, not a proven IO model — see the header.\n` +
        `Heaviest workers:\n${worst}\n` +
        `Before slowing anything: check the TTL/cutoff/SLA that worker enforces, and\n` +
        `never set its cadence coarser than that value. Otherwise raise the ceiling\n` +
        `(and say why) or upgrade compute.`,
    ).toBeLessThanOrEqual(MAX_FIRES_PER_HOUR);
  });

  it("fails closed on a cron schedule the guard cannot read", () => {
    const computed = collectNonLiteralCrons();
    expect(
      computed,
      `A cron schedule is not a string literal, so the budget guard cannot count it —\n` +
        `it would add fires/hour that CI reports as zero. Inline the literal\n` +
        `(\`{ cron: "*/5 * * * *" }\`) so the floor stays measurable:\n  ${computed.join("\n  ")}`,
    ).toEqual([]);
  });

  it("keeps NO_DB_IO honest: an exempt worker has no Supabase access", () => {
    const leaks = [...NO_DB_IO].filter((f) =>
      /serviceClient|tenantClient|supabase|\.from\(\s*["'`]/.test(readFileSync(join(FN_DIR, f), "utf8")),
    );
    expect(leaks, `These NO_DB_IO workers now touch the DB; take them off the list:\n  ${leaks.join("\n  ")}`).toEqual([]);
  });

  it("allows no new sub-minute crons without an explicit exemption", () => {
    const offenders = collectCrons()
      .filter((c) => c.firesPerHour >= 60 && !ALLOWED_EVERY_MINUTE.has(c.file))
      .map((c) => `${c.file} ("${c.expr}", ${c.firesPerHour}/h = ${c.firesPerHour * 24}/day)`);

    expect(
      offenders,
      `Every-minute crons cost 1,440 DB ticks/day each on a 1GB Micro.\n` +
        `Add the file to ALLOWED_EVERY_MINUTE only if its cadence is genuinely\n` +
        `user-visible latency (not a sweep, reaper, poller, or backstop):\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
