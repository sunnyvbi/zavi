
import { describe, it, expect, vi } from "vitest";
import {
  classifyVerdict,
  loadContext,
  probeUrl,
  type LoadContextDeps,
  type ProbeOutcome,
} from "../engineer-postdeploy-verify";

describe("classifyVerdict (pure verdict mapping)", () => {
  const IDEA = "Build me a SaaS app for tracking tutoring sessions with parents and tutors";

  it("2xx with normal app body → 'success' (no snippet, no demotion)", () => {
    const r = classifyVerdict({
      latest: { status_code: 200, body: "<html><body>Welcome to TutorTrack</body></html>", fetch_error: null },
      attempts: 1,
      conductor_idea: IDEA,
    });
    expect(r.verdict).toBe("success");
    expect(r.snippet).toBe("");
  });

  it("5xx → 'postdeploy_5xx' (the auth-500 class fix this whole feature exists for)", () => {
    const r = classifyVerdict({
      latest: { status_code: 500, body: "Internal Server Error: NEXT_PUBLIC_SUPABASE_URL is required", fetch_error: null },
      attempts: 1,
      conductor_idea: IDEA,
    });
    expect(r.verdict).toBe("postdeploy_5xx");
    expect(r.snippet).toContain("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("502/503/504 also map to 'postdeploy_5xx' (whole 5xx family)", () => {
    for (const status of [500, 502, 503, 504]) {
      const r = classifyVerdict({
        latest: { status_code: status, body: "x", fetch_error: null },
        attempts: 1,
        conductor_idea: IDEA,
      });
      expect(r.verdict).toBe("postdeploy_5xx");
    }
  });

  it("2xx body with __next_error__ digest marker → 'postdeploy_next_error' (the human-7 case)", () => {
    const body = '<html><body><div id="__next">__next_error__digest=144842213 server error</div></body></html>';
    const r = classifyVerdict({
      latest: { status_code: 200, body, fetch_error: null },
      attempts: 1,
      conductor_idea: IDEA,
    });
    expect(r.verdict).toBe("postdeploy_next_error");
    expect(r.snippet).toContain("__next_error__");
  });

  it("__next_error__ check WINS over seed-page check (more-specific verdict)", () => {
    const body = "Your company app is live. __next_error__digest=42";
    const r = classifyVerdict({
      latest: { status_code: 200, body, fetch_error: null },
      attempts: 1,
      conductor_idea: IDEA,
    });
    expect(r.verdict).toBe("postdeploy_next_error");
  });

  it("seed page + non-trivial idea → 'postdeploy_seed_no_codegen' (codegen didn't ship)", () => {
    const body = "Your company app is live. Database not configured yet.";
    const r = classifyVerdict({
      latest: { status_code: 200, body, fetch_error: null },
      attempts: 1,
      conductor_idea: IDEA,
    });
    expect(r.verdict).toBe("postdeploy_seed_no_codegen");
    expect(r.snippet).toContain("Your company app is live");
  });

  it.each([
    ['visitor-safe base page', '<main data-zavi-seed="placeholder"><h1>Coming soon</h1><p>This site is being built. Check back shortly.</p></main>'],
    ["visitor-safe category page", "<main><h1>Tasks</h1><p>Coming soon. This site is being built.</p></main>"],
    ["key-off todo starter", "<main><h1>Tasks</h1><p>A starter to-do app. Extend it.</p></main>"],
    ["seed title only", "<html><head><title>Your Company</title></head><body>hi</body></html>"],
  ])("%s + non-trivial idea → 'postdeploy_seed_no_codegen' via the shared seed markers", (_label, body) => {
    const r = classifyVerdict({
      latest: { status_code: 200, body: `<html><body>${body}</body></html>`, fetch_error: null },
      attempts: 1,
      conductor_idea: IDEA,
    });
    expect(r.verdict).toBe("postdeploy_seed_no_codegen");
  });

  it("seed page + EMPTY idea → 'success' (smoke-test build, no expected codegen)", () => {
    const body = "Your company app is live.";
    const r = classifyVerdict({
      latest: { status_code: 200, body, fetch_error: null },
      attempts: 1,
      conductor_idea: "",
    });
    expect(r.verdict).toBe("success");
  });

  it("seed page + short (<30ch) idea → 'success' (legitimate near-empty build)", () => {
    const body = "Database not configured yet.";
    const r = classifyVerdict({
      latest: { status_code: 200, body, fetch_error: null },
      attempts: 1,
      conductor_idea: "todo app",
    });
    expect(r.verdict).toBe("success");
  });

  it("seed page + NULL idea → 'success' (no expectation to compare against)", () => {
    const body = "Your company app is live";
    const r = classifyVerdict({
      latest: { status_code: 200, body, fetch_error: null },
      attempts: 1,
      conductor_idea: null,
    });
    expect(r.verdict).toBe("success");
  });

  it("no status_code + fetch_error set → 'deploy_timeout' (every probe failed at the network layer)", () => {
    const r = classifyVerdict({
      latest: { status_code: null, body: "", fetch_error: "fetch aborted" },
      attempts: 3,
      conductor_idea: IDEA,
    });
    expect(r.verdict).toBe("deploy_timeout");
    expect(r.snippet).toContain("fetch aborted");
  });

  it("4xx → 'deploy_timeout' (served but ambiguous; don't demote, but surface to operator)", () => {
    const r = classifyVerdict({
      latest: { status_code: 404, body: "Not Found", fetch_error: null },
      attempts: 1,
      conductor_idea: IDEA,
    });
    expect(r.verdict).toBe("deploy_timeout");
    expect(r.snippet).toContain("unexpected_status:404");
  });

  it("snippet is capped at 200 chars (UI doesn't get flooded)", () => {
    const body = "X".repeat(5000);
    const r = classifyVerdict({
      latest: { status_code: 500, body, fetch_error: null },
      attempts: 1,
      conductor_idea: IDEA,
    });
    expect(r.snippet.length).toBe(200);
  });
});

describe("probeUrl (fetch+timeout adapter)", () => {
  it("returns ProbeOutcome with status_code on a successful fetch", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.resolve("hello world"),
    });
    const r = await probeUrl("https://x.test", fetchFn);
    expect(r.status_code).toBe(200);
    expect(r.body).toBe("hello world");
    expect(r.fetch_error).toBeNull();
  });

  it("returns ProbeOutcome with 5xx status on a 5xx response (does NOT throw)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      status: 502,
      text: () => Promise.resolve("bad gateway"),
    });
    const r = await probeUrl("https://x.test", fetchFn);
    expect(r.status_code).toBe(502);
    expect(r.fetch_error).toBeNull();
  });

  it("returns ProbeOutcome with fetch_error on a network failure (never throws)", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED 0.0.0.0:443"));
    const r = await probeUrl("https://x.test", fetchFn);
    expect(r.status_code).toBeNull();
    expect(r.body).toBe("");
    expect(r.fetch_error).toContain("ECONNREFUSED");
  });

  it("aborts when the per-attempt timeout expires (surfaces as fetch_error, never throws)", async () => {
    const fetchFn = vi.fn((_url, init?: { signal?: AbortSignal }) => {
      return new Promise<{ status: number; text: () => Promise<string> }>((resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }
      });
    });
    const r = await probeUrl("https://x.test", fetchFn, 10 );
    expect(r.status_code).toBeNull();
    expect(r.fetch_error).toBeTruthy();
  });

  it("survives body-read failures (status came back, body broke) without throwing", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      status: 200,
      text: () => Promise.reject(new Error("read failed")),
    });
    const r = await probeUrl("https://x.test", fetchFn);
    expect(r.status_code).toBe(200);
    expect(r.body).toContain("body_read_failed");
    expect(r.fetch_error).toBeNull();
  });
});

function ctxDeps(over: Partial<LoadContextDeps> = {}): LoadContextDeps {
  return {
    loadAgentRun: vi.fn().mockResolvedValue({
      id: "run_1",
      tenant_id: "tenant_a",
      payload: {},
    }),
    loadHostingForTenant: vi.fn().mockResolvedValue({
      external_ref: { url: "https://app.onrender.com", render_service_id: "srv_1" },
      status: "ready",
    }),
    loadConductorIdea: vi.fn().mockResolvedValue("Build a tutoring marketplace"),
    ...over,
  };
}

describe("loadContext (re-derives tenant_id + live_url + idea — Codex C8)", () => {
  it("happy path: returns tenant_id, live_url, conductor_idea", async () => {
    const r = await loadContext(ctxDeps(), {
      agent_run_id: "run_1",
      expected_tenant_id: "tenant_a",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.tenant_id).toBe("tenant_a");
      expect(r.live_url).toBe("https://app.onrender.com");
      expect(r.conductor_idea).toBe("Build a tutoring marketplace");
    }
  });

  it("a new-flow SITE run is skipped: the singleton hosting is another app (QA B6)", async () => {
    const deps = ctxDeps({
      loadAgentRun: vi.fn().mockResolvedValue({
        id: "run_1",
        tenant_id: "tenant_a",
        payload: { site_id: "aaaaaaaa-0000-4000-8000-00000000000a", refine_mode: true },
      }),
    });
    const r = await loadContext(deps, { agent_run_id: "run_1", expected_tenant_id: "tenant_a" });
    expect(r).toEqual({ ok: false, reason: "site_run" });
    expect(deps.loadHostingForTenant).not.toHaveBeenCalled();
  });

  it("agent_run_not_found → ok:false (no probe, no stamp)", async () => {
    const r = await loadContext(
      ctxDeps({ loadAgentRun: vi.fn().mockResolvedValue(null) }),
      { agent_run_id: "missing", expected_tenant_id: "tenant_a" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("agent_run_not_found");
  });

  it("TENANT MISMATCH → ok:false (defends against a forged event payload pointing at another tenant's run)", async () => {
    const r = await loadContext(
      ctxDeps({
        loadAgentRun: vi.fn().mockResolvedValue({ id: "run_1", tenant_id: "tenant_OTHER", payload: {} }),
      }),
      { agent_run_id: "run_1", expected_tenant_id: "tenant_a" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("tenant_mismatch");
  });

  it("hosting row exists but external_ref.url is null/missing → ok:true with live_url=null (worker stamps no_live_url)", async () => {
    const r = await loadContext(
      ctxDeps({
        loadHostingForTenant: vi.fn().mockResolvedValue({
          external_ref: { render_service_id: "srv_1" },
          status: "provisioning",
        }),
      }),
      { agent_run_id: "run_1", expected_tenant_id: "tenant_a" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.live_url).toBeNull();
  });

  it("no hosting row at all → ok:true with live_url=null (Path A/B PR against a non-provisioned tenant)", async () => {
    const r = await loadContext(
      ctxDeps({ loadHostingForTenant: vi.fn().mockResolvedValue(null) }),
      { agent_run_id: "run_1", expected_tenant_id: "tenant_a" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.live_url).toBeNull();
  });

  it("missing conductor_idea → ok:true with conductor_idea=null (verdict classifier falls back)", async () => {
    const r = await loadContext(
      ctxDeps({ loadConductorIdea: vi.fn().mockResolvedValue(null) }),
      { agent_run_id: "run_1", expected_tenant_id: "tenant_a" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.conductor_idea).toBeNull();
  });
});

import {
  maybePostAppDbAddedNotice,
  APP_DB_ADDED_NOTICE,
  type AppDbNoticeDeps,
} from "../engineer-postdeploy-verify";

describe("maybePostAppDbAddedNotice", () => {
  const REFINE = { refine_mode: true, chat_thread_id: "th-1" };
  function deps(run: { payload: unknown; parsed: unknown } | null, threadOk = true) {
    return {
      loadRun: vi.fn(async () => run),
      threadExists: vi.fn(async () => threadOk),
      insertMessage: vi.fn(async () => {}),
    } satisfies AppDbNoticeDeps;
  }
  const args = { tenant_id: "t1", run_id: "r1" };

  it("edit that added a database: posts the notice into its thread", async () => {
    const d = deps({ payload: REFINE, parsed: { app_db_added: true } });
    expect(await maybePostAppDbAddedNotice(d, args)).toBe("posted");
    expect(d.loadRun).toHaveBeenCalledWith("r1", "t1");
    expect(d.threadExists).toHaveBeenCalledWith("th-1", "t1");
    expect(d.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ thread_id: "th-1", tenant_id: "t1", agent_run_id: "r1", body: APP_DB_ADDED_NOTICE }),
    );
    expect(APP_DB_ADDED_NOTICE).toBe("I also set up a database for your site.");
  });

  for (const [name, run] of [
    ["no database added", { payload: REFINE, parsed: {} }],
    ["first build (not a refine)", { payload: { stage: "build" }, parsed: { app_db_added: true } }],
    ["in-build repair", { payload: { ...REFINE, repair_mode: true }, parsed: { app_db_added: true } }],
    ["refine with no chat thread", { payload: { refine_mode: true }, parsed: { app_db_added: true } }],
    ["run not found for tenant", null],
  ] as const) {
    it(`skips: ${name}`, async () => {
      const d = deps(run as { payload: unknown; parsed: unknown } | null);
      expect(await maybePostAppDbAddedNotice(d, args)).toBe("skipped");
      expect(d.insertMessage).not.toHaveBeenCalled();
    });
  }

  it("skips when the thread does not belong to this tenant", async () => {
    const d = deps({ payload: REFINE, parsed: { app_db_added: true } }, false);
    expect(await maybePostAppDbAddedNotice(d, args)).toBe("skipped");
    expect(d.insertMessage).not.toHaveBeenCalled();
  });
});
