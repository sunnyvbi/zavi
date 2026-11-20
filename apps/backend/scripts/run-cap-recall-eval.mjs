import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS = path.resolve(__dirname, "../dist/src/services/eval/cap-recall/index.js");

let harness;
try {
  harness = await import(HARNESS);
} catch (e) {
  console.error(
    `\n[cap-recall] could not load the compiled harness at:\n  ${HARNESS}\n` +
      `Run \`npm run build\` in apps/backend first (the typed harness must be compiled to dist).\n` +
      `Underlying error: ${e?.message || e}\n`,
  );
  process.exit(2);
}

const { scoreSignalRecall, CAP_RECALL_FIXTURES } = harness;
const verbose = process.argv.slice(2).includes("--verbose");

console.log("\nCap signal-recall gate — engineer profile (must be 1.00 on every fixture)\n");
console.log(
  ["fixture".padEnd(20), "signals".padStart(8), "survived".padStart(9), "recall".padStart(8), "  about"].join(""),
);
console.log("-".repeat(96));

let failed = 0;
for (const fx of CAP_RECALL_FIXTURES) {
  const r = scoreSignalRecall({
    raw: fx.raw,
    capBytes: fx.capBytes,
    capProfile: fx.capProfile,
    nonZeroExit: fx.nonZeroExit,
  });
  const pass = r.recall === 1;
  if (!pass) failed++;
  console.log(
    [
      fx.name.padEnd(20),
      String(r.fullSignals.length).padStart(8),
      String(r.survived.length).padStart(9),
      `${pass ? " " : "✗"}${r.recall.toFixed(2)}`.padStart(8),
      `  ${fx.about}`,
    ].join(""),
  );
  if (verbose && r.dropped.length) {
    console.log(`    dropped: ${r.dropped.join(" | ")}`);
  }
}

console.log("-".repeat(96));
if (failed === 0) {
  console.log(`\nGATE: PASS — all ${CAP_RECALL_FIXTURES.length} fixtures at recall 1.00. Safe to ship default-on (rollback = set SANDBOX_EXEC_OUTPUT_CAPS=0 + restart).\n`);
  process.exit(0);
} else {
  console.error(
    `\nGATE: FAIL — ${failed}/${CAP_RECALL_FIXTURES.length} fixtures dropped a signal. ` +
      `extractDiagnostics needs another marker; do NOT flip SANDBOX_EXEC_OUTPUT_CAPS. Re-run with --verbose to see dropped signals.\n`,
  );
  process.exit(1);
}
