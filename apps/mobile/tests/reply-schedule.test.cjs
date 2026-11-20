const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/features/agents/schedule.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
vm.runInNewContext(compiled, { module: mod, exports: mod.exports, Intl, Date });
const s = mod.exports;

test("describes the common shapes in plain English, zone included", () => {
  assert.equal(s.describeCron("0 9 * * *", "India (IST)"), "Every day at 9:00 AM in India (IST).");
  assert.equal(s.describeCron("30 7 * * 1-5", "UTC"), "On weekdays at 7:30 AM in UTC.");
  assert.equal(s.describeCron("*/15 * * * *"), "Every 15 minutes.");
  assert.equal(s.describeCron("nope"), null);
});

test("the time field changes the time and keeps the shape; hourly/custom have no time", () => {
  assert.equal(s.withTimeOfDay("0 9 * * *", "18:45"), "45 18 * * *");
  assert.equal(s.withTimeOfDay("0 9 * * 1-5", "07:05"), "5 7 * * 1-5");
  assert.equal(s.withTimeOfDay("0 9 * * 1", "10:00"), "0 10 * * 1");
  assert.equal(s.withTimeOfDay("15 * * * *", "10:00"), null);
  assert.equal(s.withTimeOfDay("0 9 * * *", "25:00"), null);
  assert.equal(s.withTimeOfDay("0 9 * * *", "9am"), null);
});

test("next runs honour the schedule's own timezone", () => {
  const from = new Date("2026-01-15T00:00:00Z");
  const [utc] = s.nextRuns("0 9 * * *", null, 1, from);
  assert.equal(utc.toISOString(), "2026-01-15T09:00:00.000Z");
  const [kolkata] = s.nextRuns("0 9 * * *", "Asia/Kolkata", 1, from);
  assert.equal(kolkata.toISOString(), "2026-01-15T03:30:00.000Z");
});

test("the chip line says when it runs next, or that it is paused", () => {
  const now = new Date("2026-01-15T05:00:00Z");
  const sched = { cron_expression: "0 9 * * *", enabled: true, last_fired_at: null, timezone: "UTC" };
  assert.equal(s.scheduleLine(sched, now), "Every day at 9:00 AM in UTC. · next run in 4h");
  assert.equal(s.scheduleLine({ ...sched, enabled: false }, now), "Every day at 9:00 AM in UTC. · paused");
  assert.equal(s.scheduleLine(null, now), "No schedule yet");
});

test("an hourly cron limited to some days is not described as every hour all week", () => {
  assert.equal(s.describeCron("30 * * * *"), "At :30 past every hour (in UTC).");
  assert.equal(s.describeCron("30 * * * 1-5"), "Runs on a custom schedule (in UTC).");
});
