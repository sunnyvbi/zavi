import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildProductGoalGraph, buildSiteGoalGraph, type SiteGraphOpts } from "@/services/agents/product-pipeline";
import {
  conductorTick,
  type ConductorNode,
  type ConductorRow,
  type ConductorTickDeps,
  type SiteDeployDeps,
} from "@/services/agents/conductor";
import {
  AUTOPILOT_BUILD_STACK,
  STAGE_AGENT,
  DEPLOY_GATE_SLUG,
  type BuildProductInput,
} from "@/services/agents/autopilot-pipeline-contract";

const BASE_STAGES = ["provision", "spec", "scaffold", "build"] as const;

const BASE_INPUT: BuildProductInput = {
  tenant_id: "test-tenant-123",
  company_name: "Acme Corp",
  idea: "A SaaS platform for managing fleet vehicles with real-time tracking",
};

const SAVED = process.env.BUILD_DEPLOY_STAGE_ENABLED;
const SAVED_PREVIEW = process.env.BUILD_FAST_PREVIEW_ENABLED;
const SAVED_REPO_ANALYSIS = process.env.BUILD_REPO_ANALYSIS_STAGE_ENABLED;
afterEach(() => {
  if (SAVED === undefined) delete process.env.BUILD_DEPLOY_STAGE_ENABLED;
  else process.env.BUILD_DEPLOY_STAGE_ENABLED = SAVED;
  if (SAVED_PREVIEW === undefined) delete process.env.BUILD_FAST_PREVIEW_ENABLED;
  else process.env.BUILD_FAST_PREVIEW_ENABLED = SAVED_PREVIEW;
  if (SAVED_REPO_ANALYSIS === undefined)
    delete process.env.BUILD_REPO_ANALYSIS_STAGE_ENABLED;
  else process.env.BUILD_REPO_ANALYSIS_STAGE_ENABLED = SAVED_REPO_ANALYSIS;
});

const EXISTING_TARGET = {
  repo_url: "https://github.com/acme-co/acme-app",
  github_full_name: "acme-co/acme-app",
  default_branch: "main",
  github_target_mode: "user_repo" as const,
};

describe("buildProductGoalGraph (kill-switch ='0' — 4-node graph fall-back)", () => {
  function withFlagOff<T>(fn: () => T): T {
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "0";
    return fn();
  }

  it("returns exactly 4 nodes in base-stage order", () => {
    withFlagOff(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      expect(graph).toHaveLength(BASE_STAGES.length);
      expect(graph.some((n) => n.payload["stage"] === "qa")).toBe(false);
      graph.forEach((node, i) => {
        expect(node.payload["stage"]).toBe(BASE_STAGES[i]);
      });
    });
  });

  it("emits NO deploy node when the kill-switch is set ='0'", () => {
    withFlagOff(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      expect(graph.some((n) => n.payload["stage"] === "deploy")).toBe(false);
    });
  });

  it("maps each node's target_agent_slug to STAGE_AGENT[stage]", () => {
    withFlagOff(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      BASE_STAGES.forEach((stage, i) => {
        expect(graph[i].target_agent_slug).toBe(STAGE_AGENT[stage]);
      });
    });
  });

  it("provision node has dry_run === true", () => {
    withFlagOff(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      const provision = graph.find((n) => n.payload["stage"] === "provision");
      expect(provision).toBeDefined();
      expect(provision!.payload["dry_run"]).toBe(true);
    });
  });

  it("all nodes have status 'pending'", () => {
    withFlagOff(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      graph.forEach((node) => {
        expect(node.status).toBe("pending");
      });
    });
  });

  it("all node ids are unique", () => {
    withFlagOff(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      const ids = graph.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  it("all base estimate_usd values are numbers > 0", () => {
    withFlagOff(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      graph.forEach((node) => {
        expect(typeof node.estimate_usd).toBe("number");
        expect(node.estimate_usd).toBeGreaterThan(0);
      });
    });
  });

  it("spec payload carries the idea from input", () => {
    withFlagOff(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      const spec = graph.find((n) => n.payload["stage"] === "spec");
      expect(spec!.payload["idea"]).toBe(BASE_INPUT.idea);
    });
  });

  it("scaffold payload carries AUTOPILOT_BUILD_STACK", () => {
    withFlagOff(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      const scaffold = graph.find((n) => n.payload["stage"] === "scaffold");
      expect(scaffold!.payload["stack"]).toBe(AUTOPILOT_BUILD_STACK);
    });
  });

  it("all nodes have child_run_id null initially", () => {
    withFlagOff(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      graph.forEach((node) => {
        expect(node.child_run_id).toBeNull();
      });
    });
  });

  it("handles company names with spaces and special chars in ids", () => {
    withFlagOff(() => {
      const input: BuildProductInput = {
        ...BASE_INPUT,
        company_name: "My Co. #1!",
      };
      const graph = buildProductGoalGraph(input);
      graph.forEach((node) => {
        expect(node.id).toMatch(/^[a-z0-9-]+-[a-z]+$/);
      });
      const ids = graph.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});

describe("buildProductGoalGraph (FIX A — tracked deploy gate, flag ON)", () => {
  function withFlagOn<T>(fn: () => T): T {
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "1";
    return fn();
  }

  it("emits 5 nodes ending in a deploy node", () => {
    withFlagOn(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      expect(graph).toHaveLength(5);
      const stages = graph.map((n) => n.payload["stage"]);
      expect(stages).toEqual([...BASE_STAGES, "deploy"]);
      expect(stages.indexOf("deploy")).toBe(stages.indexOf("build") + 1);
    });
  });

  it("deploy node has estimate_usd 0, payload {stage:'deploy'}, and the no-dispatch sentinel slug", () => {
    withFlagOn(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      const deploy = graph.find((n) => n.payload["stage"] === "deploy");
      expect(deploy).toBeDefined();
      expect(deploy!.estimate_usd).toBe(0);
      expect(deploy!.payload).toEqual({ stage: "deploy", memory_mode: "off" });
      expect(deploy!.target_agent_slug).toBe(DEPLOY_GATE_SLUG);
      expect(deploy!.target_agent_slug).toBe("");
      expect(deploy!.status).toBe("pending");
      expect(deploy!.child_run_id).toBeNull();
    });
  });

  it("the 4 base nodes are byte-identical between flag ON and kill-switch ='0' (only deploy is appended)", () => {
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "1";
    const on = buildProductGoalGraph(BASE_INPUT);
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "0";
    const off = buildProductGoalGraph(BASE_INPUT);
    expect(on.slice(0, 4)).toEqual(off);
  });

  it("deploy node id is unique + slug-safe", () => {
    withFlagOn(() => {
      const graph = buildProductGoalGraph(BASE_INPUT);
      const ids = graph.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
      const deploy = graph.find((n) => n.payload["stage"] === "deploy")!;
      expect(deploy.id).toMatch(/-deploy$/);
    });
  });
});

describe("buildProductGoalGraph (default ON — unset env ⇒ deploy node present)", () => {
  it("emits 5 nodes ending in deploy when BUILD_DEPLOY_STAGE_ENABLED is unset", () => {
    delete process.env.BUILD_DEPLOY_STAGE_ENABLED;
    const graph = buildProductGoalGraph(BASE_INPUT);
    expect(graph).toHaveLength(5);
    const stages = graph.map((n) => n.payload["stage"]);
    expect(stages).toEqual([...BASE_STAGES, "deploy"]);
    expect(stages.indexOf("deploy")).toBe(stages.indexOf("build") + 1);
  });

  it("treats any non-'0' value (e.g. '1', 'true') as ON ⇒ 5 nodes", () => {
    for (const v of ["1", "true", "on"]) {
      process.env.BUILD_DEPLOY_STAGE_ENABLED = v;
      const graph = buildProductGoalGraph(BASE_INPUT);
      expect(graph).toHaveLength(5);
      expect(graph[graph.length - 1].payload["stage"]).toBe("deploy");
    }
  });

  it("kill-switch ='0' ⇒ exactly 4 nodes (no deploy)", () => {
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "0";
    const graph = buildProductGoalGraph(BASE_INPUT);
    expect(graph).toHaveLength(4);
    expect(graph.some((n) => n.payload["stage"] === "deploy")).toBe(false);
  });
});

describe("buildProductGoalGraph never emits a preview node", () => {
  it("ignores a leftover BUILD_FAST_PREVIEW_ENABLED=1", () => {
    process.env.BUILD_FAST_PREVIEW_ENABLED = "1";
    process.env.BUILD_DEPLOY_STAGE_ENABLED = "1";
    const graph = buildProductGoalGraph(BASE_INPUT);
    expect(graph.map((n) => n.payload["stage"])).toEqual(["provision", "spec", "scaffold", "build", "deploy"]);
  });
});

describe("buildProductGoalGraph (repo_analysis stage — DEFAULT OFF, no-op)", () => {
  it("flag UNSET ⇒ NO repo_analysis node (graph shape unchanged from today)", () => {
    delete process.env.BUILD_REPO_ANALYSIS_STAGE_ENABLED;
    const graph = buildProductGoalGraph(BASE_INPUT, { provisioned: EXISTING_TARGET });
    expect(graph.some((n) => n.payload["stage"] === "repo_analysis")).toBe(false);
    expect(graph[0].payload["stage"]).toBe("provision");
  });

  it("flag UNSET + target present ⇒ identical graph to no-flag baseline", () => {
    delete process.env.BUILD_REPO_ANALYSIS_STAGE_ENABLED;
    const withTarget = buildProductGoalGraph(BASE_INPUT, { provisioned: EXISTING_TARGET });
    const baselineStages = withTarget.map((n) => n.payload["stage"]);
    expect(baselineStages[0]).toBe("provision");
    expect(baselineStages).not.toContain("repo_analysis");
  });

  it("flag ='0' (any non-'1') ⇒ treated as OFF, no repo_analysis node", () => {
    for (const v of ["0", "false", "off", ""]) {
      process.env.BUILD_REPO_ANALYSIS_STAGE_ENABLED = v;
      const graph = buildProductGoalGraph(BASE_INPUT, { provisioned: EXISTING_TARGET });
      expect(graph.some((n) => n.payload["stage"] === "repo_analysis")).toBe(false);
    }
  });

  it("flag ='1' but NO target ⇒ still no repo_analysis node (greenfield is unaffected)", () => {
    process.env.BUILD_REPO_ANALYSIS_STAGE_ENABLED = "1";
    const graph = buildProductGoalGraph(BASE_INPUT);
    expect(graph.some((n) => n.payload["stage"] === "repo_analysis")).toBe(false);
    expect(graph[0].payload["stage"]).toBe("provision");
  });
});

describe("buildProductGoalGraph (repo_analysis stage — flag ON + existing target)", () => {
  function withRepoAnalysisOn<T>(fn: () => T): T {
    process.env.BUILD_REPO_ANALYSIS_STAGE_ENABLED = "1";
    return fn();
  }

  it("prepends a repo_analysis node FIRST when flag ON + target present", () => {
    withRepoAnalysisOn(() => {
      const graph = buildProductGoalGraph(BASE_INPUT, { provisioned: EXISTING_TARGET });
      expect(graph[0].payload["stage"]).toBe("repo_analysis");
      const stages = graph.map((n) => n.payload["stage"]);
      expect(stages.indexOf("repo_analysis")).toBe(0);
      expect(stages.indexOf("repo_analysis")).toBeLessThan(stages.indexOf("provision"));
    });
  });

  it("repo_analysis node dispatches engineer, starts pending, carries idea+target+brief", () => {
    withRepoAnalysisOn(() => {
      const graph = buildProductGoalGraph(BASE_INPUT, { provisioned: EXISTING_TARGET });
      const node = graph.find((n) => n.payload["stage"] === "repo_analysis")!;
      expect(node.target_agent_slug).toBe(STAGE_AGENT.repo_analysis);
      expect(node.target_agent_slug).toBe("engineer");
      expect(node.status).toBe("pending");
      expect(node.child_run_id).toBeNull();
      expect(node.payload["idea"]).toBe(BASE_INPUT.idea);
      expect(node.payload["existing_repo"]).toBe(true);
      expect(node.payload["target"]).toEqual(EXISTING_TARGET);
      expect(typeof node.payload["analysis_brief"]).toBe("string");
      expect(node.payload["analysis_brief"]).toContain("EXISTING repository");
    });
  });

  it("repo_analysis node id is unique + slug-safe", () => {
    withRepoAnalysisOn(() => {
      const graph = buildProductGoalGraph(BASE_INPUT, { provisioned: EXISTING_TARGET });
      const ids = graph.map((n) => n.id);
      expect(new Set(ids).size).toBe(ids.length);
      const node = graph.find((n) => n.payload["stage"] === "repo_analysis")!;
      expect(node.id).toMatch(/-repo_analysis$/);
    });
  });
});

describe("buildProductGoalGraph reference images", () => {
  it("hands the founder's reference images to the spec and codegen stages only", () => {
    const refs = ["https://store.example/signed/a.jpg", "https://store.example/signed/b.jpg"];
    const graph = buildProductGoalGraph({ ...BASE_INPUT, reference_images: refs });
    const byStage = (s: string) => graph.find((n) => n.payload["stage"] === s)?.payload;
    expect(byStage("spec")?.reference_images).toEqual(refs);
    expect(byStage("scaffold")?.reference_images).toEqual(refs);
    expect(byStage("build")?.reference_images).toEqual(refs);
    expect(byStage("provision")).not.toHaveProperty("reference_images");
  });

  it("tells spec and codegen the signed URLs expire in 7 days: download into the repo, never hotlink", () => {
    const refs = ["https://store.example/signed/a.jpg?token=abc"];
    const graph = buildProductGoalGraph({ ...BASE_INPUT, reference_images: refs });
    for (const stage of ["spec", "scaffold", "build"]) {
      const note = String(graph.find((n) => n.payload["stage"] === stage)?.payload.reference_images_instruction ?? "");
      expect(note).toContain("expire 7 days");
      expect(note).toContain("never hotlink");
      expect(note).toContain("public/reference/");
    }
    expect(graph.find((n) => n.payload["stage"] === "provision")?.payload).not.toHaveProperty("reference_images_instruction");
    const agents = join(__dirname, "../../../agents");
    const pm = readFileSync(join(agents, "pm/agent.md"), "utf8");
    const engineer = readFileSync(join(agents, "engineer/agent.md"), "utf8");
    expect(pm).toMatch(/expire 7 days after upload[\s\S]{0,200}public\/reference\/[\s\S]{0,80}never to hotlink/);
    expect(engineer).toMatch(/expire 7 days after upload: never hotlink[\s\S]{0,200}public\/reference\//);
  });

  it("adds no reference_images key when none were attached", () => {
    const graph = buildProductGoalGraph(BASE_INPUT);
    for (const node of graph) {
      expect(node.payload).not.toHaveProperty("reference_images");
      expect(node.payload).not.toHaveProperty("reference_images_instruction");
    }
  });
});

const SITE_ID = "aaaaaaaa-0000-4000-8000-000000000001";

function siteOpts(over: Partial<SiteGraphOpts> & Pick<SiteGraphOpts, "publish_on_request">): SiteGraphOpts {
  return {
    site_id: SITE_ID,
    target: {
      repo_url: "https://github.com/praxis-built/acme-aaa111",
      github_full_name: "praxis-built/acme-aaa111",
      default_branch: "main",
    },
    seed_sha: "5eed5eed",
    reference_images: ["https://img.example/a.png"],
    provision_started_at: "2026-10-02T00:00:00.000Z",
    provision_finished_at: "2026-10-02T00:00:05.000Z",
    site_backend: "pooled",
    ...over,
  };
}

function siteTickHarness(start: ConductorNode[], push: Array<"landed" | "missing">) {
  let graph = start.map((n) => ({ ...n, payload: { ...n.payload } }));
  let status: ConductorRow["status"] = "active";
  const statuses: string[] = [];
  const saves: string[][] = [];
  const pushAnswers = [...push];
  const siteDeploy: SiteDeployDeps = {
    step: vi.fn(async () => ({ kind: "waiting" as const })),
    headSha: vi.fn(async () => "head1"),
    ownsSite: vi.fn(async () => true),
    markDesired: vi.fn(async () => undefined),
    settle: vi.fn(async () => undefined),
    repairMaxAttempts: vi.fn(async () => 1),
  };
  const hostingStatus = vi.fn(async () => "ready" as const);
  const staticPlan = vi.fn();
  const staticRequest = vi.fn();
  const dispatch = vi.fn(async () => ({ ok: true as const, child_run_id: "child-build" }));
  const consumeBudget = vi.fn(async () => "charged" as const);
  const deps: ConductorTickDeps = {
    load: async () => ({
      id: "cond-1",
      tenant_id: BASE_INPUT.tenant_id,
      objective: "Build product: Acme Corp",
      status,
      max_usd: 50,
      spend_usd: 0,
      kind: "build_app",
      goal_graph: graph,
    }),
    childStatus: async () => "success",
    consumeBudget,
    dispatch,
    verifyStagePush: async () => pushAnswers.shift() ?? "landed",
    saveGraph: async (_id, g) => {
      graph = g.map((n) => ({ ...n, payload: { ...n.payload } }));
      saves.push(graph.map((n) => `${String(n.payload.stage)}:${n.status}`));
    },
    setStatus: async (_id, next) => {
      statuses.push(next);
      status = next;
    },
    hostingStatus,
    staticPublish: { plan: staticPlan, request: staticRequest, rollback: vi.fn() },
    siteDeploy,
  };
  return { deps, siteDeploy, hostingStatus, staticPlan, staticRequest, dispatch, consumeBudget, statuses, saves, graph: () => graph };
}

describe("buildSiteGoalGraph (build_publish_on_request)", () => {
  it("setting on: exactly provision (done) and build (pending), nothing that publishes", () => {
    const graph = buildSiteGoalGraph(BASE_INPUT, siteOpts({ publish_on_request: true }));
    expect(graph.map((n) => [n.payload.stage, n.status, n.target_agent_slug])).toEqual([
      ["provision", "done", STAGE_AGENT.provision],
      ["build", "pending", STAGE_AGENT.build],
    ]);
    expect(graph.some((n) => /-deploy$/.test(n.id) || "seed_sha" in n.payload)).toBe(false);
    for (const n of graph) expect(n.payload).toMatchObject({ site_id: SITE_ID, memory_mode: "off", site_backend: "pooled" });
    expect(graph[1].payload).toMatchObject({ fast_single_pass: true, idea: BASE_INPUT.idea, reference_images: ["https://img.example/a.png"] });
    expect(graph.reduce((sum, n) => sum + n.estimate_usd, 0)).toBe(
      buildSiteGoalGraph(BASE_INPUT, siteOpts({ publish_on_request: false })).reduce((sum, n) => sum + n.estimate_usd, 0),
    );
  });

  it("setting off: three nodes with the site deploy gate last, carrying the seed commit", () => {
    const graph = buildSiteGoalGraph(BASE_INPUT, siteOpts({ publish_on_request: false }));
    expect(graph.map((n) => [n.payload.stage, n.status])).toEqual([
      ["provision", "done"],
      ["build", "pending"],
      ["deploy", "pending"],
    ]);
    const deploy = graph[graph.length - 1];
    expect(deploy.id).toMatch(/-deploy$/);
    expect(deploy.target_agent_slug).toBe(DEPLOY_GATE_SLUG);
    expect(deploy.estimate_usd).toBe(0);
    expect(deploy.payload).toEqual({ stage: "deploy", seed_sha: "5eed5eed", site_id: SITE_ID, memory_mode: "off", site_backend: "pooled" });
  });

  it("the provision and build nodes are identical either way: only the deploy node differs", () => {
    const on = buildSiteGoalGraph(BASE_INPUT, siteOpts({ publish_on_request: true }));
    const off = buildSiteGoalGraph(BASE_INPUT, siteOpts({ publish_on_request: false }));
    expect(off.slice(0, 2)).toEqual(on);
    expect(off).toHaveLength(on.length + 1);
  });

  it("setting on: the run ends done when the build's code has landed, and the conductor never publishes, settles or charges for a deploy", async () => {
    const h = siteTickHarness(buildSiteGoalGraph(BASE_INPUT, siteOpts({ publish_on_request: true })), ["missing", "landed"]);

    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "dispatched", node_id: h.graph()[1].id, child_run_id: "child-build" });
    expect(h.statuses).toEqual([]);

    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 1 });
    expect(h.statuses).toEqual([]);
    expect(h.graph()[1].status).toBe("dispatched");

    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "completed", final: "done" });
    expect(h.statuses).toEqual(["done"]);
    expect(h.saves[h.saves.length - 1]).toEqual(["provision:done", "build:done"]);
    expect(h.graph().every((n) => n.status === "done" && !n.error && !n.failure_class)).toBe(true);

    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "noop", reason: "done" });
    expect(h.statuses).toEqual(["done"]);

    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.consumeBudget).toHaveBeenCalledTimes(1);
    expect(h.siteDeploy.step).not.toHaveBeenCalled();
    expect(h.siteDeploy.headSha).not.toHaveBeenCalled();
    expect(h.siteDeploy.markDesired).not.toHaveBeenCalled();
    expect(h.siteDeploy.settle).not.toHaveBeenCalled();
    expect(h.hostingStatus).not.toHaveBeenCalled();
    expect(h.staticPlan).not.toHaveBeenCalled();
    expect(h.staticRequest).not.toHaveBeenCalled();
  });

  it("setting off: the same build goes on to the site deploy gate and the run stays active until it is live", async () => {
    const h = siteTickHarness(buildSiteGoalGraph(BASE_INPUT, siteOpts({ publish_on_request: false })), ["landed"]);
    await conductorTick("cond-1", h.deps);
    expect(await conductorTick("cond-1", h.deps)).toEqual({ action: "waiting", in_flight: 0 });
    expect(h.statuses).toEqual([]);
    expect(h.siteDeploy.step).toHaveBeenCalledTimes(1);
    expect(h.siteDeploy.markDesired).toHaveBeenCalledWith({ tenant_id: BASE_INPUT.tenant_id, site_id: SITE_ID, sha: "head1" });
    expect(h.graph().map((n) => `${String(n.payload.stage)}:${n.status}`)).toEqual(["provision:done", "build:done", "deploy:pending"]);
  });
});
