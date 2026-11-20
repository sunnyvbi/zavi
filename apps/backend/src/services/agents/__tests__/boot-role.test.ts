import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { shouldRunBootReap, isProbeContainer, workerId, isCanonicalWorkerId, bootPlan, inngestSyncAllowed } from "../boot-role";

describe("shouldRunBootReap (canonical-container gate)", () => {
  it("runs ONLY on the canonical container", () => {
    expect(shouldRunBootReap({ PRAXIS_CONTAINER_ROLE: "canonical" })).toBe(true);
  });

  it("does NOT run on the C3 health-probe container", () => {
    expect(shouldRunBootReap({ PRAXIS_CONTAINER_ROLE: "probe" })).toBe(false);
  });

  it("fails CLOSED on unset/unknown role (local dev, future container types)", () => {
    expect(shouldRunBootReap({})).toBe(false);
    expect(shouldRunBootReap({ PRAXIS_CONTAINER_ROLE: "" })).toBe(false);
    expect(shouldRunBootReap({ PRAXIS_CONTAINER_ROLE: "worker" })).toBe(false);
  });
});

describe("isProbeContainer (probe-only side-effect skip — gates selfSync)", () => {
  it("is TRUE only for the ephemeral C3 probe container", () => {
    expect(isProbeContainer({ PRAXIS_CONTAINER_ROLE: "probe" })).toBe(true);
  });

  it("is FALSE for the canonical container (it SHOULD self-sync on a restart)", () => {
    expect(isProbeContainer({ PRAXIS_CONTAINER_ROLE: "canonical" })).toBe(false);
  });

  it("is FALSE on unset/unknown role (local-dev self-sync is gated downstream by the signing key, not here)", () => {
    expect(isProbeContainer({})).toBe(false);
    expect(isProbeContainer({ PRAXIS_CONTAINER_ROLE: "" })).toBe(false);
    expect(isProbeContainer({ PRAXIS_CONTAINER_ROLE: "worker" })).toBe(false);
  });
});

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..", "..");
function read(p: string): string {
  return readFileSync(join(REPO_ROOT, p), "utf8");
}

describe("deploy contract — container role env (regression guards)", () => {
  it("deploy.yml C3 health-probe container is started with role=probe", () => {
    const dy = read(".github/workflows/deploy.yml");
    expect(dy).toContain("PRAXIS_CONTAINER_ROLE=probe");
  });

  it("the canonical compose still sets role=canonical (else boot-reap silently stops)", () => {
    const compose = read("apps/backend/docker/main/docker-compose.yml");
    expect(compose).toContain("PRAXIS_CONTAINER_ROLE=canonical");
  });
});

describe("workerId (stamped on agent_runs.worker_id at claim)", () => {
  it("the prod container is 'canonical'", () => {
    expect(workerId({ PRAXIS_CONTAINER_ROLE: "canonical" })).toBe("canonical");
  });

  it("the C3 probe is 'probe'", () => {
    expect(workerId({ PRAXIS_CONTAINER_ROLE: "probe" })).toBe("probe");
  });

  it("anything else is dev:<host> — a laptop against prod data is NOT canonical", () => {
    expect(workerId({ HOSTNAME: "mbp.local" })).toBe("dev:mbp.local");
    expect(workerId({ PRAXIS_CONTAINER_ROLE: "", HOST: "box" })).toBe("dev:box");
    expect(workerId({})).toBe("dev:unknown");
  });

  it("sanitises characters that would alter a PostgREST or= filter", () => {
    expect(workerId({ HOSTNAME: "a,b)c(d" })).toBe("dev:a-b-c-d");
  });

  it("caps the host length", () => {
    expect(workerId({ HOSTNAME: "h".repeat(90) }).length).toBe(44);
  });
});

describe("workerId on split hosts (PLAN-backend-worker-split.md)", () => {
  it("each split prod host owns its runs under its own id", () => {
    expect(workerId({ PRAXIS_CONTAINER_ROLE: "canonical", PRAXIS_ROLE: "api" })).toBe("canonical:api");
    expect(workerId({ PRAXIS_CONTAINER_ROLE: "canonical", PRAXIS_ROLE: "worker" })).toBe("canonical:worker");
  });

  it("the single host keeps `canonical`", () => {
    expect(workerId({ PRAXIS_CONTAINER_ROLE: "canonical", PRAXIS_ROLE: "" })).toBe("canonical");
  });

  it("never throws on a bad role (logEvent calls it on every write)", () => {
    expect(workerId({ PRAXIS_CONTAINER_ROLE: "canonical", PRAXIS_ROLE: "nope" })).toBe("canonical");
  });

  it("the split role does not change probe or dev ids", () => {
    expect(workerId({ PRAXIS_CONTAINER_ROLE: "probe", PRAXIS_ROLE: "worker" })).toBe("probe");
    expect(workerId({ PRAXIS_ROLE: "api", HOSTNAME: "mbp" })).toBe("dev:mbp");
  });
});

describe("isCanonicalWorkerId", () => {
  it("matches every deployed prod id and nothing else", () => {
    expect(isCanonicalWorkerId("canonical")).toBe(true);
    expect(isCanonicalWorkerId("canonical:api")).toBe(true);
    expect(isCanonicalWorkerId("canonical:worker")).toBe(true);
    expect(isCanonicalWorkerId("canonicalx")).toBe(false);
    expect(isCanonicalWorkerId("dev:canonical")).toBe(false);
    expect(isCanonicalWorkerId(null)).toBe(false);
  });
});

describe("bootPlan (what each host runs at boot)", () => {
  const prod = { PRAXIS_CONTAINER_ROLE: "canonical" };

  it("single host: everything, byte-for-byte today", () => {
    expect(bootPlan(prod)).toEqual({
      servesInngest: true,
      bootReap: true,
      bootReapOwnRunsOnly: false,
      inngestSelfSync: true,
      inngestWatchdog: true,
      discordGateway: true,
      platformWorkerSecrets: true,
    });
  });

  it("api host: requests only, no Inngest, no background singletons", () => {
    expect(bootPlan({ ...prod, PRAXIS_ROLE: "api" })).toEqual({
      servesInngest: false,
      bootReap: false,
      bootReapOwnRunsOnly: false,
      inngestSelfSync: false,
      inngestWatchdog: true,
      discordGateway: false,
      platformWorkerSecrets: true,
    });
  });

  it("worker host: Inngest + background singletons, reaps only its own runs", () => {
    expect(bootPlan({ ...prod, PRAXIS_ROLE: "worker" })).toEqual({
      servesInngest: true,
      bootReap: true,
      bootReapOwnRunsOnly: true,
      inngestSelfSync: true,
      inngestWatchdog: false,
      discordGateway: true,
      platformWorkerSecrets: false,
    });
  });

  it("the C3 probe runs no side effects in any role", () => {
    for (const r of ["", "api", "worker"]) {
      const p = bootPlan({ PRAXIS_CONTAINER_ROLE: "probe", PRAXIS_ROLE: r });
      expect(p.bootReap || p.inngestSelfSync || p.inngestWatchdog || p.discordGateway || p.platformWorkerSecrets).toBe(false);
    }
  });

  it("the staging box never runs the Inngest watchdog", () => {
    for (const r of ["", "api"]) {
      expect(bootPlan({ ...prod, PRAXIS_ROLE: r, EXECUTION_ENV: "staging" }).inngestWatchdog).toBe(false);
    }
  });

  it("a laptop with the prod signing key never self-syncs Inngest Cloud (2026-11-11 outage)", () => {
    for (const r of ["", "worker"]) {
      const p = bootPlan({ INNGEST_SIGNING_KEY: "signkey-prod", PRAXIS_ROLE: r });
      expect(p.servesInngest).toBe(true);
      expect(p.inngestSelfSync).toBe(false);
      expect(p.inngestWatchdog).toBe(false);
    }
  });

  it("a bad role refuses to boot", () => {
    expect(() => bootPlan({ ...prod, PRAXIS_ROLE: "workers" })).toThrow(/PRAXIS_ROLE/);
  });
});

describe("inngestSyncAllowed (PUT /api/inngest guard)", () => {
  it("allows the canonical container", () => {
    expect(inngestSyncAllowed({ PRAXIS_CONTAINER_ROLE: "canonical", INNGEST_SIGNING_KEY: "k" })).toBe(true);
  });

  it("refuses a laptop or probe that would register with Inngest Cloud", () => {
    expect(inngestSyncAllowed({ INNGEST_SIGNING_KEY: "k" })).toBe(false);
    expect(inngestSyncAllowed({ PRAXIS_CONTAINER_ROLE: "probe", INNGEST_SIGNING_KEY: "k" })).toBe(false);
    expect(inngestSyncAllowed({ INNGEST_SIGNING_KEY: "k", INNGEST_DEV: "0" })).toBe(false);
  });

  it("allows Inngest dev mode, where the PUT only reaches the local dev server", () => {
    expect(inngestSyncAllowed({ INNGEST_SIGNING_KEY: "k", INNGEST_DEV: "http://localhost:8288" })).toBe(true);
    expect(inngestSyncAllowed({})).toBe(true);
  });
});
