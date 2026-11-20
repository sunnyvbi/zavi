
import { inngest } from "../client";
import { runDoctorChecks } from "@/services/doctor/run";
import { logDoctorChecks } from "@/services/doctor/log-to-praxis-logs";
import { alert } from "@/services/logging/alert";

export const praxisDoctorCronFn = inngest.createFunction(
  { id: "praxis-doctor-cron", retries: 1 },
  { cron: "0 * * * *" },
  async ({ logger }) => {
    const checks = await runDoctorChecks();
    await logDoctorChecks(checks, "praxis-doctor.cron");

    const fails = checks.filter((c) => c.status === "fail").length;
    const warns = checks.filter((c) => c.status === "warn").length;
    if (fails > 0) {
      logger.error(
        `praxis-doctor-cron: ${fails} fail, ${warns} warn — see praxis_logs WHERE source='praxis-doctor.cron' LIMIT 4`,
      );
      const failed = checks.filter((c) => c.status === "fail");
      const names = failed.map((c) => c.name).sort().join(",");
      await alert({
        source: "praxis-doctor.cron",
        code: "doctor.check_failed",
        msg: `doctor: ${fails} check(s) failing (${names})`,
        email: {
          dedupeKey: `doctor-failed:${names}:${new Date().toISOString().slice(0, 10)}`,
          subjectDetail: `doctor failing: ${names}`,
          detail: failed
            .map((c) => `- ${c.name}: ${c.detail}${c.fix ? `\n  fix:\n  ${c.fix.replace(/\n/g, "\n  ")}` : ""}`)
            .join("\n"),
        },
      });
    } else if (warns > 0) {
      logger.warn(`praxis-doctor-cron: ${warns} warn`);
    } else {
      logger.info("praxis-doctor-cron: all green");
    }

    return {
      checks: checks.map((c) => ({ name: c.name, status: c.status })),
      fails,
      warns,
    };
  },
);
