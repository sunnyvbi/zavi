
import { EVAL_REGISTRY, findEval } from "@/services/evals/registry";

const args = process.argv.slice(2);
const JSON_MODE = args.includes("--json");
const runIdx = args.indexOf("--run");
const RUN_SLUG = runIdx >= 0 ? args[runIdx + 1] : null;

async function listMode(): Promise<void> {
  if (JSON_MODE) {
    console.log(
      JSON.stringify(
        EVAL_REGISTRY.map((e) => ({
          slug: e.slug,
          description: e.description,
          cost: e.cost,
          blocking_gate: e.blocking_gate,
        })),
        null,
        2,
      ),
    );
    return;
  }
  console.log(`Praxis evals — ${EVAL_REGISTRY.length} registered\n`);
  for (const e of EVAL_REGISTRY) {
    const gate = e.blocking_gate ? "[blocking]" : "[report]  ";
    console.log(`  ${gate} ${e.slug.padEnd(36)} ${e.cost.padEnd(18)} — ${e.description}`);
  }
  console.log(`\nRun one: npm run evals:run -- --run <slug>`);
}

async function runMode(slug: string): Promise<number> {
  const entry = findEval(slug);
  if (!entry) {
    console.error(`unknown eval slug: ${slug}`);
    console.error(`available:`);
    for (const e of EVAL_REGISTRY) console.error(`  - ${e.slug}`);
    return 2;
  }
  const report = await entry.runner();
  if (JSON_MODE) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const acc = (report.accuracy * 100).toFixed(1);
    console.log(
      `\n${report.slug}  ts=${report.ts}\n` +
        `  total=${report.total}  passed=${report.passed}  failed=${report.failed}  accuracy=${acc}%  blocking_gate=${report.blocking_gate}\n` +
        (report.notes ? `  notes: ${report.notes}\n` : ""),
    );
    if (report.failures.length > 0) {
      console.log("FAILURES:");
      for (const f of report.failures) {
        console.log(`  ${f.case_id}: ${f.reason}`);
      }
    }
  }
  const failedAndBlocking = report.failed > 0 && report.blocking_gate;
  return failedAndBlocking ? 1 : 0;
}

async function main(): Promise<void> {
  if (RUN_SLUG) {
    const code = await runMode(RUN_SLUG);
    process.exit(code);
  }
  await listMode();
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
