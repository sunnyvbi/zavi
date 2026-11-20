import { describe, it, expect, vi } from "vitest";
import { createRequire } from "node:module";
import { runSiteGate, gateSecrets, JOURNEY_CHANGED, JOURNEY_DROPPED, OWNER_CASCADE_REASON, SiteGateInfrastructureError } from "../site-gate";
import type { SiteSandbox } from "../contract";
import type { SiteVisionRequest } from "../site-vision-review";
import type { GateRunnerExec, GateRunnerExecInput } from "../gate-runner/sandbox-runner";
import { GATE_CONFIG_PATH, GATE_RUNNER_PATH } from "../gate-runner/sandbox-runner";
import { GATE_RUNNER_SOURCE } from "../gate-runner/runner-source.generated";
import { fakeLaunch, type FakeSite } from "../gate-runner/__tests__/fake-browser";
const LINK = "https://ref.supabase.co/auth/v1/verify?token=magic-token-abcdef123&type=magiclink&redirect_to=https://s.zaviagent.com/admin";
const PREVIEW = "https://s.zaviagent.com/__zavi_preview/d000000001-abcdef12/?t=1234.previewsig0123456789";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const MANIFEST = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }] } });
const PASS_ALL = (owner = true) =>
  JSON.stringify({
    ok: true,
    journeys: [
      { name: "zavi:home", ok: true },
      { name: "zavi:routes", ok: true },
      { name: "zavi:mobile", ok: true },
      { name: "zavi:error-text", ok: true },
      { name: "home", ok: true },
    ],
    owner: owner ? { name: "owner-admin", ok: true } : null,
  });
const TAMPERED_SMOKE_STDOUT = '{"ok":true,"journeys":[{"name":"home","ok":true}],"owner":{"ok":true}}\n';

function siteSandbox(manifest: string | Error = MANIFEST) {
  const run = vi.fn(async (cmd: string, _opts?: Parameters<SiteSandbox["run"]>[1]) => {
    if (cmd.startsWith("git --no-replace-objects show ")) {
      if (manifest instanceof Error) return { exitCode: 128, stdout: "", stderr: "fatal: path not in commit" };
      return { exitCode: 0, stdout: manifest, stderr: "" };
    }
    if (cmd.includes("smoke")) return { exitCode: 0, stdout: TAMPERED_SMOKE_STDOUT, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const readFile = vi.fn(async () => (manifest instanceof Error ? "" : manifest));
  const sb: SiteSandbox = { run, readFile, listFiles: vi.fn() };
  return { sb, run, readFile };
}

function cannedRunner(result: { exitCode: number; stdout: string; stderr?: string } | Error) {
  return vi.fn(async (_i: GateRunnerExecInput) => {
    if (result instanceof Error) throw result;
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? "" };
  });
}

function realRunner(site: FakeSite): GateRunnerExec {
  const req = createRequire(__filename);
  const mod = req("../gate-runner/runner.cjs") as { runGate: (o: unknown) => Promise<{ ok: boolean }> };
  return async (input) => {
    expect(input.files[GATE_RUNNER_PATH]).toBe(GATE_RUNNER_SOURCE);
    const config = JSON.parse(input.files[GATE_CONFIG_PATH]);
    const out = await mod.runGate({
      baseUrl: input.env.GATE_BASE_URL,
      ownerLink: input.env.GATE_OWNER_LINK ?? null,
      customerLink: input.env.GATE_CUSTOMER_LINK ?? null,
      config,
      launch: fakeLaunch(site).launch,
    });
    return { exitCode: out.ok ? 0 : 1, stdout: JSON.stringify(out) + "\n", stderr: "" };
  };
}

const base = { preview_url: PREVIEW, allow_writes: false, sha: SHA, tenant_id: "t1", site_id: "s1" };

describe("runSiteGate: the platform owns the runner", () => {
  it("a tampered smoke.mjs that always prints success FAILS the gate when the page is broken", async () => {
    const { sb, run } = siteSandbox();
    const broken: FakeSite = { origin: "https://s.zaviagent.com", routes: { "/": { status: 404, text: "Not found" } } };
    const r = await runSiteGate({ ...base, sandbox: sb, owner_link: null }, { runner: realRunner(broken) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/journey "zavi:home" failed: HTTP 404/);
    expect(run.mock.calls.map((c) => c[0])).toEqual([`git --no-replace-objects show ${SHA}:zavi-site.json`]);
  });

  it("a workspace that did not answer while reading zavi-site.json is a platform failure (retry), never a repair", async () => {
    for (const answer of [
      { exitCode: 1, stdout: "", stderr: "connection lost", transportError: true },
      { exitCode: 124, stdout: "", stderr: "", timedOut: true },
    ]) {
      const run = vi.fn(async (_cmd: string, _opts?: Parameters<SiteSandbox["run"]>[1]) => answer);
      const sb: SiteSandbox = { run, readFile: vi.fn(async () => ""), listFiles: vi.fn(async () => []) };
      const runner = cannedRunner({ exitCode: 0, stdout: "{}" });
      await expect(runSiteGate({ ...base, sandbox: sb, owner_link: null }, { runner })).rejects.toBeInstanceOf(SiteGateInfrastructureError);
      expect(runner).not.toHaveBeenCalled();
    }
  });

  it("a transient error reading zavi-site.json is a platform failure, a missing file stays the site's", async () => {
    const run = vi.fn(async (_cmd: string, _opts?: Parameters<SiteSandbox["run"]>[1]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
      throw new Error("e2b: fetch failed");
    });
    const sb: SiteSandbox = { run, readFile: vi.fn(async () => ""), listFiles: vi.fn(async () => []) };
    await expect(runSiteGate({ ...base, sandbox: sb, owner_link: null }, { runner: cannedRunner({ exitCode: 0, stdout: "{}" }) })).rejects.toBeInstanceOf(SiteGateInfrastructureError);
    const missing = await runSiteGate({ ...base, sandbox: siteSandbox(new Error("gone")).sb, owner_link: null }, { runner: cannedRunner({ exitCode: 0, stdout: "{}" }) });
    expect(missing.ok).toBe(false);
  });

  it("the same healthy site passes through the real runner", async () => {
    const { sb } = siteSandbox();
    const ok: FakeSite = { origin: "https://s.zaviagent.com", routes: { "/": { status: 200, text: "Hello" } } };
    expect(await runSiteGate({ ...base, sandbox: sb, owner_link: null }, { runner: realRunner(ok) })).toMatchObject({ ok: true, owner_journey: "not_required" });
  });

  it("the owner link and preview go ONLY to the runner process env, never the site sandbox or a file", async () => {
    const { sb, run } = siteSandbox();
    const runner = cannedRunner({ exitCode: 0, stdout: PASS_ALL() });
    const r = await runSiteGate({ ...base, sandbox: sb, owner_link: LINK }, { runner });
    expect(r).toMatchObject({ ok: true, owner_journey: "passed" });
    for (const [cmd, opts] of run.mock.calls) {
      expect(cmd).not.toContain("magic-token");
      expect(opts?.env).toBeUndefined();
      expect(JSON.stringify(opts ?? {})).not.toContain("magic-token");
    }
    const input = runner.mock.calls[0][0];
    expect(input.env).toEqual({ GATE_BASE_URL: PREVIEW, GATE_OWNER_LINK: LINK });
    expect(input.command).toBe(`node ${GATE_RUNNER_PATH} ${GATE_CONFIG_PATH}`);
    expect(input.command).not.toContain("http");
    for (const content of Object.values(input.files)) {
      expect(content).not.toContain("magic-token");
      expect(content).not.toContain("previewsig");
    }
    expect(input.redact).toContain(LINK);
    expect(input.redact).toContain("magic-token-abcdef123");
    expect(input).toMatchObject({ tenant_id: "t1", site_id: "s1" });
  });

  it("an invalid manifest fails before any runner starts", async () => {
    const { sb } = siteSandbox('{"smoke":{"journeys":[{"name":"Bad Name","path":"/"}]}}');
    const runner = cannedRunner({ exitCode: 0, stdout: PASS_ALL(false) });
    const r = await runSiteGate({ ...base, sandbox: sb, owner_link: null }, { runner });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/^zavi-site\.json: journey name/) });
    expect(runner).not.toHaveBeenCalled();
  });

  it("a manifest missing at the commit fails", async () => {
    const { sb } = siteSandbox(new Error("missing"));
    const r = await runSiteGate({ ...base, sandbox: sb, owner_link: LINK }, { runner: cannedRunner({ exitCode: 0, stdout: PASS_ALL() }) });
    expect(r).toMatchObject({ ok: false, owner_journey: "failed", reason: expect.stringMatching(/not found at commit/) });
  });

  it("without a sha the manifest is read from the working tree", async () => {
    const { sb, readFile, run } = siteSandbox();
    const r = await runSiteGate({ sandbox: sb, preview_url: PREVIEW, owner_link: null, allow_writes: false }, { runner: cannedRunner({ exitCode: 0, stdout: PASS_ALL(false) }) });
    expect(r.ok).toBe(true);
    expect(readFile).toHaveBeenCalledWith("/home/user/repo/zavi-site.json");
    expect(run).not.toHaveBeenCalled();
  });

  it("the pooled starter is detected from the manifest and its write journey becomes required", async () => {
    const pooled = JSON.stringify({
      collections: { notes: { rules: { create: ["anyone"], get: ["admin"], list: ["admin"] }, schema: { type: "object", properties: { text: { type: "string", maxLength: 100 } } } } },
      smoke: { journeys: [{ name: "home", path: "/" }] },
    });
    const { sb } = siteSandbox(pooled);
    const runner = cannedRunner({ exitCode: 0, stdout: PASS_ALL(false) });
    const r = await runSiteGate({ ...base, allow_writes: true, sandbox: sb, owner_link: null }, { runner });
    expect(JSON.parse(runner.mock.calls[0][0].files[GATE_CONFIG_PATH])).toMatchObject({ starter: "pooled", write: { collection: "notes" } });
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/missing or skipped the platform journey\(s\): zavi:read-denied, zavi:write-create, zavi:write-denied$/) });
  });

  it("backend_mode pooled (platform state) forces the pooled journeys even when the manifest drops collections", async () => {
    const { sb } = siteSandbox();
    const runner = cannedRunner({ exitCode: 0, stdout: PASS_ALL(false) });
    await runSiteGate({ ...base, backend_mode: "pooled", sandbox: sb, owner_link: null }, { runner });
    expect(JSON.parse(runner.mock.calls[0][0].files[GATE_CONFIG_PATH])).toMatchObject({ starter: "pooled" });
  });

  it("a SKIPPED required journey does not pass the gate", async () => {
    const out = JSON.parse(PASS_ALL(false));
    out.journeys[2] = { name: "zavi:mobile", ok: true, skipped: true, reason: "?" };
    const r = await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null }, { runner: cannedRunner({ exitCode: 0, stdout: JSON.stringify(out) }) });
    expect(r).toMatchObject({ ok: false, reason: "the smoke result is missing or skipped the platform journey(s): zavi:mobile" });
  });
});

describe("runSiteGate output parsing", () => {
  const go = (stdout: string, exitCode = 0, owner_link: string | null = null) =>
    runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link }, { runner: cannedRunner({ exitCode, stdout }) });

  it("passes only with every platform journey present", async () => {
    expect((await go(PASS_ALL(false))).ok).toBe(true);
    const r = await go('{"ok":true,"journeys":[{"name":"zavi:home","ok":true}],"owner":null}');
    expect(r).toMatchObject({ ok: false, reason: "the smoke result is missing or skipped the platform journey(s): zavi:routes, zavi:mobile, zavi:error-text" });
  });

  it("an ok:true with a failed journey is a failure", async () => {
    const out = JSON.parse(PASS_ALL(false));
    out.journeys[1] = { name: "zavi:routes", ok: false, reason: "HTTP 404 for /pricing" };
    expect(await go(JSON.stringify(out))).toMatchObject({ ok: false, reason: 'journey "zavi:routes" failed: HTTP 404 for /pricing' });
  });

  it("a non-zero exit is a failure even with ok:true", async () => {
    expect((await go(PASS_ALL(false), 1)).ok).toBe(false);
  });

  it("takes the last JSON line", async () => {
    expect((await go(`chromium warning\n{"ok":false}\n${PASS_ALL(false)}\n`)).ok).toBe(true);
  });

  it("exit 0 without a parseable result is a failure", async () => {
    await expect(go("garbage")).rejects.toThrow("exited 0 without a result");
  });

  it("a runner error string becomes the reason", async () => {
    expect(await go('{"ok":false,"journeys":[],"owner":null,"error":"Cannot find module playwright"}', 1)).toMatchObject({
      ok: false,
      reason: "Cannot find module playwright",
    });
  });

  it("a supplied link with NO owner result fails the gate, redacted", async () => {
    const r = await go(PASS_ALL(false).replace('"ok":true,"journeys"', `"note":"${LINK}","ok":true,"journeys"`), 0, LINK);
    expect(r).toMatchObject({ ok: false, owner_journey: "failed" });
    expect(r.reason).toMatch(/owner sign-in journey did not run/);
    expect(JSON.stringify(r)).not.toContain("magic-token-abcdef123");
  });

  it("a failing owner result is failed and never echoes the link", async () => {
    const out = JSON.stringify({ ok: false, journeys: [], owner: { name: "owner-admin", ok: false, reason: `timeout on ${LINK}` } });
    const r = await go(out, 1, LINK);
    expect(r).toMatchObject({ ok: false, owner_journey: "failed" });
    expect(r.reason).toMatch(/^the owner sign-in failed: timeout on/);
    expect(JSON.stringify(r)).not.toContain("magic-token-abcdef123");
    expect(JSON.stringify(r)).not.toContain("previewsig0123456789");
  });

  it("reports the ROOT step (owner sign-in), not the first owner journey that merely inherited it", async () => {
    const out = JSON.parse(PASS_ALL(false));
    out.ok = false;
    out.journeys.push(
      { name: "admin-sees-message", ok: false, ms: 0, reason: "the owner could not sign in" },
      { name: "book", ok: false, ms: 0, reason: "the owner could not sign in" },
    );
    out.owner = { name: "owner-admin", ok: false, ms: 15811, reason: "/admin did not show [data-zavi=admin-shell] to the signed-in owner" };
    const r = await go(JSON.stringify(out), 1, LINK);
    expect(r).toMatchObject({
      ok: false,
      owner_journey: "failed",
      reason: "the owner sign-in failed: /admin did not show [data-zavi=admin-shell] to the signed-in owner",
    });
  });

  it("an independent journey failure still leads, with the owner failure named too", async () => {
    const out = JSON.parse(PASS_ALL(false));
    out.ok = false;
    out.journeys.push(
      { name: "contact-create", ok: false, ms: 10, reason: "[data-zavi=contact-sent] never appeared" },
      { name: "admin-sees-message", ok: false, ms: 0, reason: "the owner could not sign in" },
    );
    out.owner = { name: "owner-admin", ok: false, reason: "the owner sign-in did not reach /admin" };
    const r = await go(JSON.stringify(out), 1, LINK);
    expect(r.reason).toBe(
      'journey "contact-create" failed: [data-zavi=contact-sent] never appeared\nAlso, the owner sign-in failed: the owner sign-in did not reach /admin',
    );
  });

  it("the cascade reason is the runner's own constant", () => {
    const runner = createRequire(__filename)("../gate-runner/runner.cjs") as { OWNER_CASCADE: string };
    expect(runner.OWNER_CASCADE).toBe(OWNER_CASCADE_REASON);
  });

  it("an owner sign-in platform failure throws infrastructure (retry, no paid repair)", async () => {
    const out = JSON.stringify({ ok: false, journeys: [], owner: null, infrastructure_error: true, error: "owner sign-in: the sign-in service refused the owner link (unavailable) (the owner sign-in did not reach /admin)", created: [{ collection: "submissions", id: "x1" }] });
    const e = await go(out, 1, LINK).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SiteGateInfrastructureError);
    expect((e as SiteGateInfrastructureError).message).toMatch(/refused the owner link/);
    expect((e as SiteGateInfrastructureError).created).toEqual([{ collection: "submissions", id: "x1" }]);
  });

  it("a runner that throws is a failure with the link scrubbed", async () => {
    const error = await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: LINK }, { runner: cannedRunner(new Error(`e2b create failed ${LINK}`)) }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/could not run/);
    expect((error as Error).message).not.toContain("magic-token-abcdef123");
  });

  it("a platform runner crash is not a site-code repair verdict", async () => {
    await expect(go(JSON.stringify({ ok: false, journeys: [], owner: null, infrastructure_error: true, error: "Chromium cannot launch" }), 1))
      .rejects.toThrow("Chromium cannot launch");
  });

  it("an absent runner result is an infrastructure failure", async () => {
    await expect(go("", 1)).rejects.toThrow("without a result");
  });

  it("gateSecrets pulls the query tokens out of a URL", () => {
    expect(gateSecrets([PREVIEW])).toContain("1234.previewsig0123456789");
  });
});

describe("the gate tag", () => {
  it("every run writes under its own fresh, well-formed tag", async () => {
    const runner = cannedRunner({ exitCode: 0, stdout: PASS_ALL(false) });
    await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null }, { runner });
    await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null }, { runner });
    const tags = runner.mock.calls.map((c) => JSON.parse((c[0].files as Record<string, string>)[GATE_CONFIG_PATH]).tag as string);
    for (const t of tags) expect(t).toMatch(/^zavi-smoke-[0-9a-f]{16}$/);
    expect(tags[0]).not.toBe(tags[1]);
  });
});

describe("runSiteGate: the booking check", () => {
  const BOOKING = JSON.stringify({
    smoke: {
      journeys: [
        { name: "home", path: "/" },
        {
          name: "book",
          path: "/book",
          writes: true,
          steps: [{ fill: "[data-zavi=book-name]", value: "Test {smoke}" }, { click: "[data-zavi=book-submit]" }],
        },
      ],
    },
  });
  const BRIEF = "A salon where clients book appointments online";
  const result = (bookOk: boolean | "skipped") =>
    JSON.stringify({
      ok: bookOk === true || bookOk === "skipped",
      journeys: [
        { name: "zavi:home", ok: true },
        { name: "zavi:routes", ok: true },
        { name: "zavi:mobile", ok: true },
        { name: "zavi:error-text", ok: true },
        { name: "home", ok: true },
        bookOk === "skipped"
          ? { name: "book", ok: true, skipped: true, reason: "writes not allowed" }
          : { name: "book", ok: bookOk, ...(bookOk ? {} : { reason: "the booking form never sent the booking when submitted" }) },
      ],
      owner: null,
    });

  function configOf(runner: ReturnType<typeof cannedRunner>) {
    return JSON.parse(runner.mock.calls[0][0].files[GATE_CONFIG_PATH]) as { journeys: Array<{ name: string; dry_run?: boolean }> };
  }

  it("read-only gate: the booking journey is marked a dry run and must pass", async () => {
    const { sb } = siteSandbox(BOOKING);
    const runner = cannedRunner({ exitCode: 0, stdout: result(true) });
    const r = await runSiteGate({ ...base, allow_writes: false, sandbox: sb, owner_link: null, booking_required: true, brief: BRIEF }, { runner });
    expect(r.ok).toBe(true);
    expect(configOf(runner).journeys.find((j) => j.name === "book")?.dry_run).toBe(true);
  });

  it("read-only gate: a SKIPPED booking journey no longer passes (it used to prove only that the journey existed)", async () => {
    const { sb } = siteSandbox(BOOKING);
    const r = await runSiteGate(
      { ...base, allow_writes: false, sandbox: sb, owner_link: null, booking_required: true, brief: BRIEF },
      { runner: cannedRunner({ exitCode: 0, stdout: result("skipped") }) },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/test booking on the site did not go through/);
  });

  it("read-only gate: a failed dry run blocks with the booking reason", async () => {
    const { sb } = siteSandbox(BOOKING);
    const r = await runSiteGate(
      { ...base, allow_writes: false, sandbox: sb, owner_link: null, booking_required: true, brief: BRIEF },
      { runner: cannedRunner({ exitCode: 1, stdout: result(false) }) },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/test booking on the site did not go through/);
    expect(r.reason).toMatch(/never sent the booking/);
  });

  it("a booking journey that never clicks submit is refused before the runner (it would prove nothing)", async () => {
    const noSubmit = JSON.stringify({
      smoke: { journeys: [{ name: "book", path: "/book", writes: true, steps: [{ fill: "[data-zavi=book-name]", value: "Test {smoke}" }] }] },
    });
    const { sb } = siteSandbox(noSubmit);
    const runner = cannedRunner({ exitCode: 0, stdout: result(true) });
    const r = await runSiteGate({ ...base, allow_writes: true, sandbox: sb, owner_link: null, booking_required: true, brief: BRIEF }, { runner });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/never submits the form/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("the booking journey is flagged so a writing gate checks the server accepted it", async () => {
    const { sb } = siteSandbox(BOOKING);
    const runner = cannedRunner({ exitCode: 0, stdout: result(true) });
    await runSiteGate({ ...base, allow_writes: true, sandbox: sb, owner_link: null, booking_required: true, brief: BRIEF }, { runner });
    const book = (JSON.parse(runner.mock.calls[0][0].files[GATE_CONFIG_PATH]) as { journeys: Array<{ name: string; booking?: boolean }> }).journeys.find((j) => j.name === "book");
    expect(book?.booking).toBe(true);
  });

  describe("a customer books, never the owner (development QA 2026-10-02, 8-6)", () => {
    const ORIGIN = "https://s.zaviagent.com";
    const CUSTOMER_LINK = `${ORIGIN}/api/auth/callback?type=magiclink&token_hash=customer-token-123456`;
    const OWNER_LINK = `${ORIGIN}/api/auth/callback?type=magiclink&token_hash=owner-token-1234567`;
    const OWNER_BOOKING = JSON.stringify({
      smoke: {
        journeys: [
          { name: "home", path: "/" },
          {
            name: "book",
            path: "/book",
            as: "owner",
            writes: true,
            steps: [{ fill: "[data-zavi=book-name]", value: "Test {smoke}" }, { click: "[data-zavi=book-submit]" }],
          },
        ],
      },
    });
    const site = (customerStatus: number): FakeSite => ({
      origin: ORIGIN,
      routes: {
        "/": { status: 200, text: "Home", selectors: ["[data-zavi=home]"] },
        "/book": {
          status: 200,
          text: "Book",
          selectors: ["[data-zavi=book-name]", "[data-zavi=book-submit]"],
          submits: { "[data-zavi=book-submit]": { method: "POST", url: `${ORIGIN}/api/data/bookings` } },
        },
        "/admin": { status: 200, text: "Admin", selectors: ["[data-zavi=admin-shell]"] },
      },
      api: (r) =>
        r.method === "POST" && r.path === "/api/data/bookings"
          ? { status: r.as === "owner" ? 201 : customerStatus, body: {} }
          : { status: 404 },
      ownerLink: OWNER_LINK,
      owner: { reachesAdmin: true, token: "owner-session-token-123" },
      customerLink: CUSTOMER_LINK,
      customer: { token: "customer-session-token-123", signedIn: true },
    });
    const input = (sb: SiteSandbox, customer_link: string | null) => ({
      ...base,
      preview_url: `${ORIGIN}/__zavi_preview/d000000001-abcdef12/?t=1234.previewsig0123456789`,
      allow_writes: true,
      sandbox: sb,
      owner_link: OWNER_LINK,
      customer_link,
      booking_required: true,
      brief: BRIEF,
    });

    it("a writing gate with an owner but no customer sign-in never runs the booking as the owner: a retryable platform fault", async () => {
      const { sb } = siteSandbox(OWNER_BOOKING);
      const runner = vi.fn(realRunner(site(403)));
      await expect(runSiteGate({ ...input(sb, null), customer_expected: true }, { runner })).rejects.toBeInstanceOf(SiteGateInfrastructureError);
      await expect(runSiteGate({ ...input(sb, null), owner_link: null, customer_expected: true }, { runner })).rejects.toBeInstanceOf(SiteGateInfrastructureError);
      expect(runner).not.toHaveBeenCalled();
    });

    it("the customer link reaches the runner even when the owner sign-in is off", async () => {
      const { sb } = siteSandbox(OWNER_BOOKING);
      const runner = vi.fn(realRunner(site(201)));
      await runSiteGate({ ...input(sb, CUSTOMER_LINK), owner_link: null, customer_expected: true }, { runner });
      expect(runner.mock.calls[0][0].env.GATE_CUSTOMER_LINK).toBe(CUSTOMER_LINK);
    });

    it("with no owner either, the booking is skipped and fails the gate as missing (never an owner pass)", async () => {
      const { sb } = siteSandbox(OWNER_BOOKING);
      const r = await runSiteGate({ ...input(sb, null), owner_link: null }, { runner: realRunner(site(403)) });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/test booking on the site did not go through/);
    });

    it("the booking runs as a signed-up customer, so a write only the owner may make fails the gate", async () => {
      const { sb } = siteSandbox(OWNER_BOOKING);
      const r = await runSiteGate(input(sb, CUSTOMER_LINK), { runner: realRunner(site(403)) });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/test booking on the site did not go through/);
      expect(r.reason).toMatch(/signed-up customer was refused/);
      expect(`${r.reason}\n${r.evidence}`).not.toContain("customer-token-123456");
      expect(`${r.reason}\n${r.evidence}`).not.toContain("customer-session-token-123");
    });

    it("a booking a customer may make passes, and the customer sign-in is a required step", async () => {
      const { sb } = siteSandbox(OWNER_BOOKING);
      const runner = vi.fn(realRunner(site(201)));
      const r = await runSiteGate(input(sb, CUSTOMER_LINK), { runner });
      expect(r.ok).toBe(true);
      const call = runner.mock.calls[0][0];
      expect(call.env.GATE_CUSTOMER_LINK).toBe(CUSTOMER_LINK);
      expect(call.redact).toContain(CUSTOMER_LINK);
      const book = (JSON.parse(call.files[GATE_CONFIG_PATH]) as { journeys: Array<{ name: string; as?: string }> }).journeys.find((j) => j.name === "book");
      expect(book?.as).toBe("customer");
    });

    it("a read-only gate (no sign-in on a live database) dry-runs a customer booking as a visitor, never skips it", async () => {
      const customerBooking = OWNER_BOOKING.replace('"as":"owner"', '"as":"customer"');
      const { sb } = siteSandbox(customerBooking);
      const runner = cannedRunner({ exitCode: 0, stdout: result(true) });
      await runSiteGate({ ...base, allow_writes: false, sandbox: sb, owner_link: null, booking_required: true, brief: BRIEF }, { runner });
      const book = (JSON.parse(runner.mock.calls[0][0].files[GATE_CONFIG_PATH]) as { journeys: Array<{ name: string; as?: string; dry_run?: boolean }> }).journeys.find((j) => j.name === "book");
      expect(book).toMatchObject({ as: "visitor", dry_run: true });
    });

    it("a customer sign-in that does not hold a session fails the gate (a skipped booking never passes)", async () => {
      const { sb } = siteSandbox(OWNER_BOOKING);
      const broken = { ...site(201), customer: { token: "customer-session-token-123", signedIn: false } };
      const r = await runSiteGate(input(sb, CUSTOMER_LINK), { runner: realRunner(broken) });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/no session after the sign-in link/);
    });
  });

  it("writing gate (pooled test site): the real booking journey runs, no dry run", async () => {
    const { sb } = siteSandbox(BOOKING);
    const runner = cannedRunner({ exitCode: 0, stdout: result(true) });
    await runSiteGate({ ...base, allow_writes: true, sandbox: sb, owner_link: null, booking_required: true, brief: BRIEF }, { runner });
    expect(configOf(runner).journeys.find((j) => j.name === "book")?.dry_run).toBeUndefined();
  });
});

describe("runSiteGate: a fix pass cannot get past the check by weakening it", () => {
  const OPEN_TIMES = { name: "open-times", path: "/book", expect: "[data-zavi=slot]" };
  const failedManifest = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }, OPEN_TIMES] } });
  const noTimes: FakeSite = {
    origin: "https://s.zaviagent.com",
    routes: { "/": { status: 200, text: "Paws & Suds" }, "/book": { status: 200, text: "No open times right now", selectors: [] } },
  };

  it("reports every declared journey and the one that failed, so the next check can hold the fix to them", async () => {
    const r = await runSiteGate({ ...base, sandbox: siteSandbox(failedManifest).sb, owner_link: null }, { runner: realRunner(noTimes) });
    expect(r.ok).toBe(false);
    expect(r.journeys).toEqual(["home", "open-times"]);
    expect(r.failed_journeys).toEqual(["open-times"]);
  });

  it("a fix that deletes the failing journey passes without kept journeys and fails with them, before any runner starts", async () => {
    const weakened = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }] } });
    const loose = await runSiteGate({ ...base, sandbox: siteSandbox(weakened).sb, owner_link: null }, { runner: realRunner(noTimes) });
    expect(loose.ok).toBe(true);

    const runner = vi.fn(realRunner(noTimes));
    const r = await runSiteGate(
      { ...base, sandbox: siteSandbox(weakened).sb, owner_link: null, kept_journeys: { names: ["home", "open-times"], must_pass: ["open-times"] } },
      { runner },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(`${JOURNEY_DROPPED}: open-times`);
    expect(runner).not.toHaveBeenCalled();
  });

  it("a fix that turns the failing journey into an owner journey (skipped without an owner) still has to pass it", async () => {
    const ownerOnly = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }, { ...OPEN_TIMES, as: "owner" }] } });
    const loose = await runSiteGate({ ...base, sandbox: siteSandbox(ownerOnly).sb, owner_link: null }, { runner: realRunner(noTimes) });
    expect(loose.ok).toBe(true);

    const r = await runSiteGate(
      { ...base, sandbox: siteSandbox(ownerOnly).sb, owner_link: null, kept_journeys: { names: ["home", "open-times"], must_pass: ["open-times"] } },
      { runner: realRunner(noTimes) },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("open-times");
  });

  async function failedCheck() {
    return runSiteGate({ ...base, sandbox: siteSandbox(failedManifest).sb, owner_link: null }, { runner: realRunner(noTimes) });
  }
  const keptFrom = (r: Awaited<ReturnType<typeof failedCheck>>) => ({
    names: r.journeys ?? [],
    must_pass: r.failed_journeys ?? [],
    fingerprints: r.fingerprints ?? {},
  });

  it("a fix that keeps the name but expects the 'No open times' text instead of a slot fails the gate", async () => {
    const kept = keptFrom(await failedCheck());
    expect(Object.keys(kept.fingerprints)).toEqual(["open-times"]);
    const loosened = JSON.stringify({
      smoke: { journeys: [{ name: "home", path: "/" }, { name: "open-times", path: "/book", expectText: "No open times right now" }] },
    });
    const loose = await runSiteGate({ ...base, sandbox: siteSandbox(loosened).sb, owner_link: null }, { runner: realRunner(noTimes) });
    expect(loose.ok).toBe(true);
    const runner = vi.fn(realRunner(noTimes));
    const r = await runSiteGate({ ...base, sandbox: siteSandbox(loosened).sb, owner_link: null, kept_journeys: kept }, { runner });
    expect(r).toMatchObject({ ok: false, reason: `${JOURNEY_CHANGED}: open-times` });
    expect(runner).not.toHaveBeenCalled();
  });

  it("a fix that points the failing journey at the home page fails the gate", async () => {
    const kept = keptFrom(await failedCheck());
    const moved = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }, { ...OPEN_TIMES, path: "/" }] } });
    const r = await runSiteGate({ ...base, sandbox: siteSandbox(moved).sb, owner_link: null, kept_journeys: kept }, { runner: realRunner(noTimes) });
    expect(r).toMatchObject({ ok: false, reason: `${JOURNEY_CHANGED}: open-times` });
  });

  it("on a read-only gate, a fix that marks the failing journey as writes (so it would never run) fails the gate", async () => {
    const kept = keptFrom(await failedCheck());
    const skipped = JSON.stringify({
      smoke: { journeys: [{ name: "home", path: "/" }, { ...OPEN_TIMES, writes: true, steps: [{ fill: "[data-zavi=name]", value: "{smoke}" }] }] },
    });
    const loose = await runSiteGate({ ...base, sandbox: siteSandbox(skipped).sb, owner_link: null, kept_journeys: { ...kept, fingerprints: {} } }, { runner: realRunner(noTimes) });
    expect(loose.ok).toBe(true);
    const r = await runSiteGate({ ...base, sandbox: siteSandbox(skipped).sb, owner_link: null, kept_journeys: kept }, { runner: realRunner(noTimes) });
    expect(r).toMatchObject({ ok: false, reason: `${JOURNEY_CHANGED}: open-times` });
  });

  it("an unchanged journey that now passes is accepted, and a journey that passed before may still change", async () => {
    const kept = keptFrom(await failedCheck());
    const withTimes: FakeSite = { ...noTimes, routes: { ...noTimes.routes, "/": { status: 200, text: "Paws & Suds, book today" }, "/book": { status: 200, text: "10:00", selectors: ["[data-zavi=slot]"] } } };
    const homeEdited = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/", expectText: "book today" }, OPEN_TIMES] } });
    const r = await runSiteGate({ ...base, sandbox: siteSandbox(homeEdited).sb, owner_link: null, kept_journeys: kept }, { runner: realRunner(withTimes) });
    expect(r).toMatchObject({ ok: true });
  });

  it("a real fix that shows open times passes with the kept journeys", async () => {
    const withTimes: FakeSite = { ...noTimes, routes: { ...noTimes.routes, "/book": { status: 200, text: "10:00", selectors: ["[data-zavi=slot]"] } } };
    const r = await runSiteGate(
      { ...base, sandbox: siteSandbox(failedManifest).sb, owner_link: null, kept_journeys: { names: ["home", "open-times"], must_pass: ["open-times"] } },
      { runner: realRunner(withTimes) },
    );
    expect(r).toMatchObject({ ok: true });
  });
});

describe("visible error text: the gate result the deploy step caps on", () => {
  const ERR = 'visible error text on /: "Something went wrong on our side. Please try again."';
  const site = (over: Partial<FakeSite["routes"]> = {}): FakeSite => ({
    origin: "https://s.zaviagent.com",
    routes: { "/": { status: 200, text: "Bloom Bakery\nSomething went wrong on our side. Please try again." }, ...over } as FakeSite["routes"],
  });

  it("an error the page rendered without any console error fails the gate through the real runner, marked error-text only", async () => {
    const r = await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null }, { runner: realRunner(site()) });
    expect(r).toMatchObject({ ok: false, reason: ERR, error_text: "only" });
    expect(r.evidence).toContain("zavi:error-text");
  });

  it("error text alongside another failure is marked with_others", async () => {
    const two = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }, { name: "menu", path: "/menu" }] } });
    const r = await runSiteGate(
      { ...base, sandbox: siteSandbox(two).sb, owner_link: null },
      { runner: realRunner(site({ "/menu": { status: 404, text: "down" } })) },
    );
    expect(r).toMatchObject({ ok: false, error_text: "with_others" });
  });

  it("a runner result without the error-text check never passes", async () => {
    const out = JSON.parse(PASS_ALL(false));
    out.journeys = out.journeys.filter((j: { name: string }) => j.name !== "zavi:error-text");
    const r = await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null }, { runner: cannedRunner({ exitCode: 0, stdout: JSON.stringify(out) }) });
    expect(r).toMatchObject({ ok: false, reason: "the smoke result is missing or skipped the platform journey(s): zavi:error-text" });
  });

  it("a healthy site carries no error_text mark", async () => {
    const r = await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null }, { runner: realRunner(site({ "/": { status: 200, text: "Bloom Bakery" } })) });
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty("error_text");
  });
});

describe("vision review (warn-only, SITE_GATE_VISION_REVIEW)", () => {
  const healthy: FakeSite = { origin: "https://s.zaviagent.com", routes: { "/": { status: 200, text: "Bloom Bakery", ogTitle: "Bloom Bakery | Fresh bread" } } };
  const logs = () => {
    const seen: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((l: unknown) => {
      seen.push(String(l));
    });
    return { warn, lines: () => seen.filter((l) => l.includes("vision review")) };
  };

  it.each([
    ["unset", {}],
    ["true", { SITE_GATE_VISION_REVIEW: "true" }],
    ["empty", { SITE_GATE_VISION_REVIEW: "" }],
  ])("flag %s: on by default, the screenshots go to the model once", async (_label, env) => {
    const review = vi.fn(async (_input: SiteVisionRequest) => ({ ok: true, issues: [] }));
    const runner = vi.fn(realRunner(healthy));
    const { warn } = logs();
    const r = await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null, site_name: "Bloom" }, { runner, visionReview: review, env });
    warn.mockRestore();
    expect(r.ok).toBe(true);
    expect(review).toHaveBeenCalledTimes(1);
    expect(JSON.parse(runner.mock.calls[0][0].files[GATE_CONFIG_PATH]).screenshots).toBe(true);
  });

  it.each([["0", { SITE_GATE_VISION_REVIEW: "0" }]])("flag %s: no screenshots are asked for and the model is never called", async (_label, env) => {
    const review = vi.fn();
    const runner = vi.fn(realRunner(healthy));
    const { warn, lines } = logs();
    const r = await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null, site_name: "Bloom" }, { runner, visionReview: review, env });
    warn.mockRestore();
    expect(r.ok).toBe(true);
    expect(review).not.toHaveBeenCalled();
    expect(JSON.parse(runner.mock.calls[0][0].files[GATE_CONFIG_PATH])).not.toHaveProperty("screenshots");
    expect(lines()).toEqual([]);
  });

  it("flag 0 in the process env and no env given: the model is never called", async () => {
    vi.stubEnv("SITE_GATE_VISION_REVIEW", "0");
    const review = vi.fn();
    const runner = vi.fn(realRunner(healthy));
    try {
      const r = await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null }, { runner, visionReview: review });
      expect(r.ok).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(review).not.toHaveBeenCalled();
    expect(JSON.parse(runner.mock.calls[0][0].files[GATE_CONFIG_PATH])).not.toHaveProperty("screenshots");
  });

  it("flag on: the screenshots and the site's name go to the model, the verdict is logged, the evidence carries no image", async () => {
    const review = vi.fn(async (_input: SiteVisionRequest) => ({ ok: false, issues: ["Screenshot 1 shows a sign-in prompt next to an error"] }));
    const { warn, lines } = logs();
    const r = await runSiteGate(
      { ...base, sandbox: siteSandbox().sb, owner_link: null, site_name: "Bloom Bakery" },
      { runner: realRunner(healthy), visionReview: review, env: { SITE_GATE_VISION_REVIEW: "1" } },
    );
    warn.mockRestore();
    expect(r.ok).toBe(true);
    expect(review).toHaveBeenCalledTimes(1);
    const arg = review.mock.calls[0][0] as unknown as { expected_name: string; screenshots: Array<{ label: string; path: string; data: string }>; site_id: string };
    expect(arg.expected_name).toBe("Bloom Bakery");
    expect(arg.site_id).toBe("s1");
    expect(arg.screenshots.map((s) => [s.label, s.path])).toEqual([["desktop", "/"], ["mobile", "/"]]);
    expect(lines()).toEqual(['[site-gate] vision review site=s1 ok=false issues=["Screenshot 1 shows a sign-in prompt next to an error"]']);
    expect(r.evidence).not.toContain(arg.screenshots[0].data);
    expect(r.evidence).not.toContain("screenshots");
  });

  it("flag on without a site name: the page's og:title is the expected name", async () => {
    const review = vi.fn(async (_input: SiteVisionRequest) => ({ ok: true, issues: [] as string[] }));
    const { warn } = logs();
    await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null }, { runner: realRunner(healthy), visionReview: review, env: { SITE_GATE_VISION_REVIEW: "1" } });
    warn.mockRestore();
    expect((review.mock.calls[0][0] as unknown as { expected_name: string }).expected_name).toBe("Bloom Bakery | Fresh bread");
  });

  it("flag on with a model error: the gate result is unchanged and the skip is logged", async () => {
    const review = vi.fn(async () => {
      throw new Error("529 overloaded");
    });
    const { warn, lines } = logs();
    const r = await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null }, { runner: realRunner(healthy), visionReview: review, env: { SITE_GATE_VISION_REVIEW: "1" } });
    warn.mockRestore();
    expect(r).toMatchObject({ ok: true, reason: "smoke journeys passed" });
    expect(lines()).toEqual(["[site-gate] vision review skipped: 529 overloaded site=s1"]);
  });

  it("flag on with a model that never answers: the review times out, the call is aborted, the gate still passes", async () => {
    let signal: AbortSignal | null = null;
    const review = vi.fn((i: { signal: AbortSignal }) => {
      signal = i.signal;
      return new Promise<never>(() => undefined);
    });
    const { warn, lines } = logs();
    const r = await runSiteGate(
      { ...base, sandbox: siteSandbox().sb, owner_link: null },
      { runner: realRunner(healthy), visionReview: review as never, visionTimeoutMs: 30, env: { SITE_GATE_VISION_REVIEW: "1" } },
    );
    warn.mockRestore();
    expect(r.ok).toBe(true);
    expect(signal!.aborted).toBe(true);
    expect(lines()).toEqual(["[site-gate] vision review skipped: timed out after 30ms site=s1"]);
  });

  it("flag on: a failing gate still fails exactly as before (the review never changes the verdict)", async () => {
    const review = vi.fn(async (_input: SiteVisionRequest) => ({ ok: true, issues: [] as string[] }));
    const { warn } = logs();
    const broken: FakeSite = { origin: "https://s.zaviagent.com", routes: { "/": { status: 404, text: "down" } } };
    const r = await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null }, { runner: realRunner(broken), visionReview: review, env: { SITE_GATE_VISION_REVIEW: "1" } });
    warn.mockRestore();
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/journey "zavi:home" failed: HTTP 404/) });
  });
});

describe("vision review result: threaded out of the gate, never changing its verdict", () => {
  const healthy: FakeSite = { origin: "https://s.zaviagent.com", routes: { "/": { status: 200, text: "Bloom Bakery" } } };
  const ON = { SITE_GATE_VISION_REVIEW: "1" };
  const finding = {
    screenshot: "1 (desktop /)",
    page: "/",
    category: "imagery" as const,
    severity: "high" as const,
    class: "defect" as const,
    confidence: 0.9,
    evidence: "hero photo is stretched",
    suggestion: "use object-fit cover",
  };
  const brief = { business_name: "Bloom Bakery", mood: "warm" };
  const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => undefined);

  it("a passing gate carries the reviewed findings, and the reviewer got the brief", async () => {
    const review = vi.fn(async (_i: SiteVisionRequest) => ({ ok: true, issues: [] as string[], findings: [finding] }));
    const w = quiet();
    const r = await runSiteGate(
      { ...base, sandbox: siteSandbox().sb, owner_link: null, site_name: "Bloom Bakery", vision: { mode: "correct", brief } },
      { runner: realRunner(healthy), visionReview: review, env: ON },
    );
    w.mockRestore();
    expect(r).toMatchObject({ ok: true, reason: "smoke journeys passed", vision: { status: "reviewed", ok: true, findings: [finding] } });
    expect(review.mock.calls[0]![0].brief).toEqual(brief);
  });

  it("a failing gate carries the findings too and still fails exactly as before", async () => {
    const review = vi.fn(async (_i: SiteVisionRequest) => ({ ok: false, issues: ["no name"], findings: [finding] }));
    const w = quiet();
    const two = JSON.stringify({ smoke: { journeys: [{ name: "home", path: "/" }, { name: "menu", path: "/menu" }] } });
    const menuDown: FakeSite = { ...healthy, routes: { ...healthy.routes, "/menu": { status: 404, text: "down" } } as FakeSite["routes"] };
    const r = await runSiteGate({ ...base, sandbox: siteSandbox(two).sb, owner_link: null, vision: { mode: "observe" } }, { runner: realRunner(menuDown), visionReview: review, env: ON });
    w.mockRestore();
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/HTTP 404/), vision: { status: "reviewed", ok: false, findings: [finding] } });
    const bare = await runSiteGate({ ...base, sandbox: siteSandbox(two).sb, owner_link: null }, { runner: realRunner(menuDown) });
    const verdict = (g: typeof r) => [g.ok, g.reason, g.owner_journey, g.failed_journeys, g.fingerprints, g.journeys];
    expect(verdict(r)).toEqual(verdict(bare));
  });

  it("a timed-out review is recorded as not_reviewed/timeout, never as a pass, and the gate result is unchanged", async () => {
    const w = quiet();
    const r = await runSiteGate(
      { ...base, sandbox: siteSandbox().sb, owner_link: null, vision: { mode: "correct" } },
      { runner: realRunner(healthy), visionReview: (() => new Promise<never>(() => undefined)) as never, visionTimeoutMs: 20, env: ON },
    );
    w.mockRestore();
    expect(r.ok).toBe(true);
    expect(r.vision).toEqual({ status: "not_reviewed", reason: "timeout", findings: [] });
    expect(r.vision).not.toHaveProperty("ok");
  });

  it("tenant mode off with the env flag on: no screenshots, no model call, recorded as disabled", async () => {
    const review = vi.fn();
    const runner = vi.fn(realRunner(healthy));
    const r = await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null, vision: { mode: "off" } }, { runner, visionReview: review, env: ON });
    expect(review).not.toHaveBeenCalled();
    expect(JSON.parse(runner.mock.calls[0]![0].files[GATE_CONFIG_PATH])).not.toHaveProperty("screenshots");
    expect(r).toMatchObject({ ok: true, vision: { status: "not_reviewed", reason: "disabled", findings: [] } });
  });

  it("env flag off: the mode cannot turn the review on and the result carries no vision", async () => {
    const review = vi.fn();
    const runner = vi.fn(realRunner(healthy));
    const r = await runSiteGate({ ...base, sandbox: siteSandbox().sb, owner_link: null, vision: { mode: "correct" } }, { runner, visionReview: review, env: { SITE_GATE_VISION_REVIEW: "0" } });
    expect(review).not.toHaveBeenCalled();
    expect(JSON.parse(runner.mock.calls[0]![0].files[GATE_CONFIG_PATH])).not.toHaveProperty("screenshots");
    expect(r).not.toHaveProperty("vision");
  });
});

describe("runSiteGate: home-page images (site_images)", () => {
  const MARKER = JSON.stringify({ version: 1, images: [{ slug: "hero", src: "/images/hero-1600.webp" }] });
  function sandboxWithMarker(marker: string | null) {
    const run = vi.fn(async (cmd: string) => {
      if (cmd.endsWith(":zavi-site.json")) return { exitCode: 0, stdout: MANIFEST, stderr: "" };
      if (cmd.endsWith(":public/images/zavi-images.json")) {
        return marker === null ? { exitCode: 128, stdout: "", stderr: "fatal: path not in commit" } : { exitCode: 0, stdout: marker, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const sb: SiteSandbox = { run, readFile: vi.fn(async () => MANIFEST), listFiles: vi.fn() };
    return sb;
  }
  const site = (images: Array<{ src: string; naturalWidth: number }>): FakeSite => ({
    origin: "https://s.zaviagent.com",
    routes: { "/": { status: 200, text: "Hello", images } },
  });

  it("a site with generated photos must show one on the home page", async () => {
    const r = await runSiteGate(
      { ...base, sandbox: sandboxWithMarker(MARKER), owner_link: null, images_check: true, first_build: true },
      { runner: realRunner(site([])) },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/shows no photo/);
    const shown = await runSiteGate(
      { ...base, sandbox: sandboxWithMarker(MARKER), owner_link: null, images_check: true, first_build: false },
      { runner: realRunner(site([{ src: "https://s.zaviagent.com/images/hero-1600.webp", naturalWidth: 1600 }])) },
    );
    expect(shown).toMatchObject({ ok: true });
  });

  it("a first build without generated photos (image model down, or no photos asked) passes with none", async () => {
    const r = await runSiteGate(
      { ...base, sandbox: sandboxWithMarker(null), owner_link: null, images_check: true, first_build: true },
      { runner: realRunner(site([])) },
    );
    expect(r).toMatchObject({ ok: true });
  });

  it("a first build fails on a broken image", async () => {
    const r = await runSiteGate(
      { ...base, sandbox: sandboxWithMarker(null), owner_link: null, images_check: true, first_build: true },
      { runner: realRunner(site([{ src: "https://s.zaviagent.com/images/gone.webp", naturalWidth: 0 }])) },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/broken image/);
  });

  it("a first build whose builder never asked for photos goes back for them, unless the founder asked for none", async () => {
    const never = await runSiteGate(
      { ...base, sandbox: sandboxWithMarker(null), owner_link: null, images_check: true, first_build: true, brief: "A bakery site with an order form" },
      { runner: realRunner(site([])) },
    );
    expect(never.ok).toBe(false);
    expect(never.reason).toMatch(/never called add_site_images/);
    const none = await runSiteGate(
      { ...base, sandbox: sandboxWithMarker(null), owner_link: null, images_check: true, first_build: true, brief: "A dentist booking site, no photos please" },
      { runner: realRunner(site([])) },
    );
    expect(none).toMatchObject({ ok: true });
    const scoped = await runSiteGate(
      { ...base, sandbox: sandboxWithMarker(null), owner_link: null, images_check: true, first_build: true, brief: "A clinic site, no photos of patients" },
      { runner: realRunner(site([])) },
    );
    expect(scoped.ok).toBe(false);
    const tried = await runSiteGate(
      { ...base, sandbox: sandboxWithMarker(JSON.stringify({ version: 1, generated: 0, images: [] })), owner_link: null, images_check: true, first_build: true, brief: "A photographer portfolio" },
      { runner: realRunner(site([])) },
    );
    expect(tried).toMatchObject({ ok: true });
  });

  it("vendor down and the builder used the no-image layout: the marker records the attempt and the page passes (no paid repair)", async () => {
    const outage = JSON.stringify({ version: 1, generated: 0, images: [] });
    for (const brief of ["A bakery site with an order form", "A dentist booking site", "A photographer portfolio"]) {
      const r = await runSiteGate(
        { ...base, sandbox: sandboxWithMarker(outage), owner_link: null, images_check: true, first_build: true, brief },
        { runner: realRunner(site([])) },
      );
      expect(r, brief).toMatchObject({ ok: true });
    }
  });

  it("vendor down and the builder left an empty image placeholder: the publish check fails it", async () => {
    const outage = JSON.stringify({ version: 1, generated: 0, images: [] });
    const r = await runSiteGate(
      { ...base, sandbox: sandboxWithMarker(outage), owner_link: null, images_check: true, first_build: true, brief: "A coffee shop" },
      { runner: realRunner({ origin: "https://s.zaviagent.com", routes: { "/": { status: 200, text: "Hello", images: [], placeholders: [{ kind: "icon" }] } } }) },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/empty image placeholder/);
  });

  it("fails a home page that hotlinks an image from another host", async () => {
    const r = await runSiteGate(
      { ...base, sandbox: sandboxWithMarker(null), owner_link: null, images_check: true, first_build: true },
      { runner: realRunner(site([{ src: "https://images.stock.example/a.jpg", naturalWidth: 1200 }])) },
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/hotlinked from images\.stock\.example/);
  });

  it("a later publish of a site with generated photos goes live after the founder swaps or removes the home photo", async () => {
    const later = { ...base, sandbox: sandboxWithMarker(MARKER), owner_link: null, images_check: true, first_build: false };
    expect(await runSiteGate(later, { runner: realRunner(site([])) })).toMatchObject({ ok: true });
    expect(
      await runSiteGate(later, { runner: realRunner(site([{ src: "https://s.zaviagent.com/images/founder-upload.jpg", naturalWidth: 1200 }])) }),
    ).toMatchObject({ ok: true });
    expect(
      await runSiteGate(later, { runner: realRunner(site([{ src: "https://s.zaviagent.com/images/hero%201600.webp", naturalWidth: 1600 }])) }),
    ).toMatchObject({ ok: true });
  });

  it("a later publish of a site with generated photos still fails a broken, hotlinked or placeholder image", async () => {
    const later = { ...base, sandbox: sandboxWithMarker(MARKER), owner_link: null, images_check: true, first_build: false };
    const broken = await runSiteGate(later, { runner: realRunner(site([{ src: "https://s.zaviagent.com/images/hero-1600.webp", naturalWidth: 0 }])) });
    expect(broken.ok).toBe(false);
    expect(broken.reason).toMatch(/broken image/);
    const hotlinked = await runSiteGate(later, { runner: realRunner(site([{ src: "https://images.stock.example/a.jpg", naturalWidth: 1200 }])) });
    expect(hotlinked.ok).toBe(false);
    expect(hotlinked.reason).toMatch(/hotlinked from images\.stock\.example/);
    const placeholder = await runSiteGate(later, {
      runner: realRunner({ origin: "https://s.zaviagent.com", routes: { "/": { status: 200, text: "Hello", images: [], placeholders: [{ kind: "icon" }] } } }),
    });
    expect(placeholder.ok).toBe(false);
    expect(placeholder.reason).toMatch(/placeholder/);
  });

  it("a later publish of a site without generated photos is not checked, and the setting off skips it", async () => {
    const broken = site([{ src: "https://s.zaviagent.com/images/gone.webp", naturalWidth: 0 }]);
    expect(
      await runSiteGate({ ...base, sandbox: sandboxWithMarker(null), owner_link: null, images_check: true, first_build: false }, { runner: realRunner(broken) }),
    ).toMatchObject({ ok: true });
    expect(
      await runSiteGate({ ...base, sandbox: sandboxWithMarker(MARKER), owner_link: null, images_check: false, first_build: true }, { runner: realRunner(broken) }),
    ).toMatchObject({ ok: true });
  });
});
