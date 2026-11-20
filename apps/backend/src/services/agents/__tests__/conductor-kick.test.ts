import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  requestConductorTick,
  requestTickForFinishedChild,
  targetedRunId,
  CONDUCTOR_TICK_REQUESTED,
} from "../conductor-kick";
import { BUILD_CONDUCTOR_RUN_ID_KEY } from "@/services/billing/tiers";
import {
  conductorTickFn,
  conductorTickRequestedFn,
} from "../../../../workers/functions/conductor-tick";

const RUN = "509235e5-bb1b-448c-9a2b-4acdb9ccb0b2";
const REPO = resolve(__dirname, "../../../../../..");
const MIGRATIONS = join(REPO, "supabase/migrations");

const dispatchedPayload = (conductor_run_id: string, extra: Record<string, unknown> = {}) => ({
  ...extra,
  [BUILD_CONDUCTOR_RUN_ID_KEY]: conductor_run_id,
});

describe("requestConductorTick", () => {
  it("sends the tick event carrying the run id", async () => {
    const send = vi.fn().mockResolvedValue({ ids: ["evt"] });
    const ok = await requestConductorTick({ send }, RUN);
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledWith({
      name: CONDUCTOR_TICK_REQUESTED,
      data: { conductor_run_id: RUN },
    });
  });

  it("never throws when Inngest is unreachable, so the build response still succeeds", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn().mockRejectedValue(new Error("401 Event key not found"));
    await expect(requestConductorTick({ send }, RUN)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(RUN));
    warn.mockRestore();
  });
});

describe("conductor-tick triggers", () => {
  it("the request event and the 2-minute cron are each served by a tick function", () => {
    const triggersOf = (fn: unknown) =>
      (fn as { opts: { triggers?: Array<{ cron?: string; event?: string }> } }).opts.triggers;
    expect(triggersOf(conductorTickFn)).toEqual([{ cron: "*/2 * * * *" }]);
    expect(triggersOf(conductorTickRequestedFn)).toEqual([{ event: CONDUCTOR_TICK_REQUESTED }]);
  });
});

const TENANT = "a7ec7367-acc8-4abc-995b-7da60a572de3";

describe("requestTickForFinishedChild", () => {
  it("never looks a run up without a tenant to scope the lookup to", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const isActive = vi.fn().mockResolvedValue(true);
    await expect(
      requestTickForFinishedChild({ send }, isActive, dispatchedPayload(RUN), ""),
    ).resolves.toBe(false);
    expect(isActive).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("kicks the conductor named by the stamp the conductor itself wrote", async () => {
    const send = vi.fn().mockResolvedValue({ ids: ["evt"] });
    const isActive = vi.fn().mockResolvedValue(true);
    await expect(
      requestTickForFinishedChild({ send }, isActive, dispatchedPayload(RUN, { node_id: "n1" }), TENANT),
    ).resolves.toBe(true);
    expect(isActive).toHaveBeenCalledWith(RUN, TENANT);
    expect(send).toHaveBeenCalledWith({
      name: CONDUCTOR_TICK_REQUESTED,
      data: { conductor_run_id: RUN },
    });
  });

  it("never treats parent_run_id as the conductor, whatever else the payload carries", async () => {
    const send = vi.fn();
    const isActive = vi.fn().mockResolvedValue(true);
    for (const payload of [
      { parent_run_id: RUN },
      { parent_run_id: RUN, thread_id: "t1" },
      { parent_run_id: RUN, batch_id: RUN, child_index: 0 },
    ]) {
      await expect(requestTickForFinishedChild({ send }, isActive, payload, TENANT)).resolves.toBe(false);
    }
    expect(isActive).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("verifies and kicks the SAME id, normalised, so a stamp's case cannot split the two", async () => {
    const send = vi.fn().mockResolvedValue({ ids: ["evt"] });
    const isActive = vi.fn().mockResolvedValue(true);
    await requestTickForFinishedChild({ send }, isActive, dispatchedPayload(RUN.toUpperCase()), TENANT);
    expect(isActive).toHaveBeenCalledWith(RUN, TENANT);
    expect(send.mock.calls[0][0].data.conductor_run_id).toBe(RUN);
  });

  it("does not kick a conductor that already finished, halted or was cancelled", async () => {
    const send = vi.fn();
    await expect(
      requestTickForFinishedChild({ send }, async () => false, dispatchedPayload(RUN), TENANT),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("never looks a run up for an ordinary chat or cron run with no conductor stamp", async () => {
    const send = vi.fn();
    const isActive = vi.fn();
    for (const payload of [
      null,
      undefined,
      {},
      "a string payload",
      42,
      { [BUILD_CONDUCTOR_RUN_ID_KEY]: "" },
      { [BUILD_CONDUCTOR_RUN_ID_KEY]: "not-a-uuid" },
      { [BUILD_CONDUCTOR_RUN_ID_KEY]: "../../etc/passwd" },
      { [BUILD_CONDUCTOR_RUN_ID_KEY]: `${RUN} or 1=1` },
      { [BUILD_CONDUCTOR_RUN_ID_KEY]: RUN.split("-") },
    ]) {
      await expect(requestTickForFinishedChild({ send }, isActive, payload, TENANT)).resolves.toBe(false);
    }
    expect(isActive).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("swallows a lookup failure so a finished agent run still terminalizes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn();
    const isActive = vi.fn().mockRejectedValue(new Error("supabase down"));
    await expect(
      requestTickForFinishedChild({ send }, isActive, dispatchedPayload(RUN), TENANT),
    ).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("swallows an Inngest failure the same way", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const send = vi.fn().mockRejectedValue(new Error("401 Event key not found"));
    await expect(
      requestTickForFinishedChild({ send }, async () => true, dispatchedPayload(RUN), TENANT),
    ).resolves.toBe(false);
    warn.mockRestore();
  });
});

describe("targetedRunId", () => {
  it("reads the run id the event carries", () => {
    expect(targetedRunId({ name: CONDUCTOR_TICK_REQUESTED, data: { conductor_run_id: RUN } })).toBe(
      RUN,
    );
  });

  it("is null for the cron, which carries no run", () => {
    expect(targetedRunId({ name: "inngest/scheduled.timer", data: {} })).toBeNull();
    expect(targetedRunId(undefined)).toBeNull();
    expect(targetedRunId(null)).toBeNull();
  });

  it("refuses anything that is not a uuid, so the id can never shape a query", () => {
    for (const bad of ["", "*", "1 OR 1=1", "../../etc", 42, {}, []]) {
      expect(targetedRunId({ data: { conductor_run_id: bad } })).toBeNull();
    }
  });
});

describe("the one link between a conductor and the runs it dispatched", () => {
  const driver = readFileSync(
    resolve(__dirname, "../conductor-driver.ts"),
    "utf8",
  );
  const runner = readFileSync(resolve(__dirname, "../runner.ts"), "utf8");

  it("is written by the dispatcher onto the child's payload", () => {
    expect(driver).toMatch(
      /payload:\s*\{\s*\.\.\.input\.payload,\s*\[BUILD_CONDUCTOR_RUN_ID_KEY\]:\s*input\.conductor_run_id,/,
    );
  });

  it("is what the runner hands the kick when a child settles", () => {
    expect(runner).toMatch(
      /requestTickForFinishedChild\(inngest,\s*isActiveConductorRun,\s*runRow\.payload,\s*tenant_id\)/,
    );
  });

  it("is the only thing the runner could use: the kick never reads parent_run_id", () => {
    const kick = runner.indexOf("requestTickForFinishedChild(");
    expect(kick).toBeGreaterThan(-1);
    const fnStart = runner.lastIndexOf("\n}", kick);
    expect(runner.slice(fnStart, kick + 200)).not.toMatch(/parent_run_id/);
  });

  it("could never have been parent_run_id — that column is a back-ref to agent_runs", () => {
    const sql = readFileSync(
      join(MIGRATIONS, "20260521020120_agent_run_batch_state.sql"),
      "utf8",
    );
    expect(sql).toMatch(/parent_run_id\s+uuid\s+references\s+agent_runs\(id\)/i);

    const repointed = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) =>
        /parent_run_id[^;]*references\s+conductor_runs/i.test(
          readFileSync(join(MIGRATIONS, f), "utf8"),
        ),
      );
    expect(repointed).toEqual([]);
  });
});
