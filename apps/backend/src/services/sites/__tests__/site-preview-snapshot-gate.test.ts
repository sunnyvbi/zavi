import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { capturePreviewSnapshots, captureHomeScreenshot } from "../site-gate";
import { GATE_CONFIG_PATH, type GateRunnerExec } from "../gate-runner/sandbox-runner";
import type { GateRunnerConfig } from "../gate-runner/config";
import { fakeLaunch, type FakeSite } from "../gate-runner/__tests__/fake-browser";

const req = createRequire(__filename);
const runner = req("../gate-runner/runner.cjs") as {
  runGate: (o: { baseUrl: string; config: GateRunnerConfig; launch: () => Promise<unknown> }) => Promise<Record<string, unknown> & { ok: boolean }>;
};

const TENANT = "11111111-1111-4111-8111-111111111111";
const SITE = "22222222-2222-4222-8222-222222222222";
const ORIGIN = "https://5173-sbxsnap01.e2b.app";

function fakeExec(site: FakeSite) {
  const configs: GateRunnerConfig[] = [];
  const shots: Array<{ width: number; path: string }> = [];
  const visits: string[] = [];
  const exec: GateRunnerExec = async (input) => {
    const config = JSON.parse(input.files[GATE_CONFIG_PATH]) as GateRunnerConfig;
    configs.push(config);
    const fake = fakeLaunch(site);
    const out = await runner.runGate({ baseUrl: input.env.GATE_BASE_URL, config, launch: fake.launch });
    shots.push(...fake.calls.screenshots);
    visits.push(...fake.calls.goto.map((u: string) => new URL(u).pathname));
    return { exitCode: out.ok ? 0 : 1, stdout: `${JSON.stringify(out)}\n`, stderr: "" };
  };
  return { exec, configs, shots, visits };
}

const input = { preview_url: `${ORIGIN}/`, tenant_id: TENANT, site_id: SITE };

describe("capturePreviewSnapshots: the home page at desktop and mobile width, through the trusted runner", () => {
  it("returns a desktop and a mobile shot of / only, read-only, no links followed", async () => {
    const f = fakeExec({ origin: ORIGIN, routes: { "/": { text: "Sweet Layers cakes", links: ["/menu"] }, "/menu": { text: "Menu" } } });
    const out = await capturePreviewSnapshots(input, { runner: f.exec });
    expect(out).not.toBeNull();
    expect(f.configs[0]).toMatchObject({ scan_only: true, read_only: true, preview_snapshot: true, scan_links: false, routes: ["/"] });
    expect(f.shots.map((s) => [s.width, s.path])).toEqual([
      [1280, "/"],
      [390, "/"],
    ]);
    expect(out!.desktop).not.toBe(out!.mobile);
    expect(f.visits).not.toContain("/menu");
  });

  it("a page with a build error is never a snapshot, and no mobile shot is taken", async () => {
    const f = fakeExec({ origin: ORIGIN, routes: { "/": { text: "Sweet", overlay: true } } });
    expect(await capturePreviewSnapshots(input, { runner: f.exec })).toBeNull();
    expect(f.shots.filter((s) => s.width === 390)).toEqual([]);
  });

  it("a runner that cannot start THROWS so the worker retries", async () => {
    const down: GateRunnerExec = async () => {
      throw new Error("e2b down");
    };
    await expect(capturePreviewSnapshots(input, { runner: down })).rejects.toThrow(/could not run/);
  });

  it("the Artifacts thumbnail still takes exactly one desktop shot", async () => {
    const f = fakeExec({ origin: ORIGIN, routes: { "/": { text: "Sweet Layers cakes" } } });
    expect(await captureHomeScreenshot(input, { runner: f.exec })).not.toBeNull();
    expect(f.shots.map((s) => s.width)).toEqual([1280]);
  });
});

describe("a home page that only breaks at phone width", () => {
  it.each([
    ["a build error overlay", { overlay: true }],
    ["a crash in the page", { pageErrors: ["TypeError: cannot read properties of undefined"] }],
    ["visible error text", { text: "Something went wrong" }],
  ])("%s on mobile never becomes the mobile snapshot, and the good desktop shot is kept", async (_name, mobile) => {
    const f = fakeExec({ origin: ORIGIN, routes: { "/": { text: "Sweet Layers cakes", mobile } } });
    const out = await capturePreviewSnapshots(input, { runner: f.exec });
    expect(out).not.toBeNull();
    expect(out!.desktop).toBeTruthy();
    expect(out!.mobile).toBeNull();
  });
});

describe("capturePreviewSnapshots when only the mobile shot fails", () => {
  it("keeps the desktop shot", async () => {
    const desktop = Buffer.from("desk").toString("base64");
    const exec: GateRunnerExec = async () => ({
      exitCode: 1,
      stdout: `${JSON.stringify({
        ok: false,
        journeys: [
          { name: "zavi:entry", ok: true },
          { name: "zavi:scan", ok: true },
          { name: "zavi:error_text", ok: true },
          { name: "zavi:mobile_snapshot", ok: false, reason: "timeout" },
        ],
        screenshots: [{ label: "desktop", path: "/", data: desktop }],
      })}\n`,
      stderr: "",
    });
    expect(await capturePreviewSnapshots(input, { runner: exec })).toEqual({ desktop, mobile: null });
  });

  it("still refuses when the page itself failed", async () => {
    const exec: GateRunnerExec = async () => ({
      exitCode: 1,
      stdout: `${JSON.stringify({ ok: false, journeys: [{ name: "zavi:scan", ok: false }], screenshots: [{ label: "desktop", path: "/", data: "eA==" }] })}\n`,
      stderr: "",
    });
    expect(await capturePreviewSnapshots(input, { runner: exec })).toBeNull();
  });
});
