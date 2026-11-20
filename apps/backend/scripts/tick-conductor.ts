
import "tsconfig-paths/register";
import { conductorTick } from "@/services/agents/conductor";
import { realConductorTickDeps } from "@/services/agents/conductor-driver";

async function main() {
  const runId = process.argv[2];
  const ticks = Number(process.argv[3] || 1);
  const delaySec = Number(process.argv[4] || 3);
  if (!runId) {
    console.error("usage: tsx scripts/tick-conductor.ts <run_id> [ticks=1] [delaySec=3]");
    process.exit(1);
  }
  for (let i = 0; i < ticks; i++) {
    const r = await conductorTick(runId, realConductorTickDeps);
    console.log(`[tick ${i + 1}/${ticks}] ${JSON.stringify(r)}`);
    if (["completed", "halted", "noop"].includes((r as { action: string }).action)) {
      console.log(`terminal action — stopping.`);
      break;
    }
    if (i < ticks - 1) await new Promise((res) => setTimeout(res, delaySec * 1000));
  }
}

main().catch((e) => {
  console.error(`tick-conductor failed: ${(e as Error).message}`);
  process.exit(1);
});
