
import "dotenv/config";
import { runDoctorChecks, type Check } from "@/services/doctor/run";
import { logDoctorChecks } from "@/services/doctor/log-to-praxis-logs";

const args = process.argv.slice(2);
const JSON_MODE = args.includes("--json");
const FIX_MODE = args.includes("--fix");
const NO_LOG = args.includes("--no-log");

function emit(checks: Check[]): void {
  if (JSON_MODE) {
    console.log(
      JSON.stringify({ checks, ts: new Date().toISOString() }, null, 2),
    );
    return;
  }
  const icon: Record<Check["status"], string> = {
    ok: "[ok]  ",
    warn: "[warn]",
    fail: "[FAIL]",
    skip: "[skip]",
  };
  for (const c of checks) {
    console.log(`${icon[c.status]} ${c.name.padEnd(10)} ${c.detail}`);
    if (FIX_MODE && c.fix && (c.status === "fail" || c.status === "warn")) {
      console.log(`         remediation:`);
      for (const line of c.fix.split("\n")) console.log(`           ${line}`);
    }
  }
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  console.log("");
  if (fails > 0)
    console.log(
      `${fails} FAIL, ${warns} warn — see remediation above (rerun with --fix to print commands)`,
    );
  else if (warns > 0) console.log(`0 fail, ${warns} warn`);
  else console.log("all green");
}

async function main(): Promise<void> {
  const checks = await runDoctorChecks();
  emit(checks);
  if (!NO_LOG) {
    await logDoctorChecks(checks, "praxis-doctor.cli");
  }
  process.exit(checks.some((c) => c.status === "fail") ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
