
const STAFF_ONLY_ORIGINS = new Set(["fde_dispatch", "staff_console"]);

export function redactStaffOnlyPayload<T extends { input_payload_raw?: unknown }>(run: T): T {
  const payload = run.input_payload_raw;
  if (payload === null || payload === undefined) return run;
  if (typeof payload !== "object") return run;

  const origin = (payload as Record<string, unknown>).origin;
  if (typeof origin !== "string" || !STAFF_ONLY_ORIGINS.has(origin)) return run;

  return {
    ...run,
    input_payload_raw: {
      origin,
      redacted: true,
      note: "This run was started by Zavi staff on your behalf. The operator instruction is not shown; the run's output is unaffected.",
    },
  };
}
