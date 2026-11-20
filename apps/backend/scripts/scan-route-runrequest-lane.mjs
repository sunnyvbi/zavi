#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(BACKEND_DIR);

const ROOTS = ["src", "workers"];
const EVENT = 'name: "agent.run.requested"';
const WINDOW = 12;

function listFiles() {
  const out = execFileSync(
    "git",
    ["ls-files", "*.ts", ...ROOTS.map((r) => `${r}/**/*.ts`)],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return out
    .split("\n")
    .filter(Boolean)
    .filter((f) => ROOTS.some((r) => f.startsWith(`${r}/`)))
    .filter((f) => !/\.test\.ts$|__tests__|__fixtures__/.test(f));
}

const violations = [];
for (const file of listFiles()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (!text.includes(EVENT)) continue;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(EVENT)) continue;
    const window = lines.slice(i, i + WINDOW).join("\n");
    if (!/\blane\b/.test(window)) {
      violations.push(`${file}:${i + 1}  agent.run.requested send has no 'lane' key within ${WINDOW} lines`);
    }
  }
}

if (violations.length) {
  console.error("GAP 11 lane-stamp guard FAILED — un-laned agent.run.requested send(s):\n");
  for (const v of violations) console.error("  " + v);
  console.error(
    "\nFix: build the event via buildRunRequestedEvent / buildRunRequestedEventForRunId\n" +
      "(services/agents/run-lane.ts), or add `lane: computeRunLane(trigger, batch_id)` to the data.",
  );
  process.exit(1);
}
console.log("GAP 11 lane-stamp guard OK — every agent.run.requested send carries a lane.");
