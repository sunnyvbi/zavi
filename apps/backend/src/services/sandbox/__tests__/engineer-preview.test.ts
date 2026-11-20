
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/settings", () => ({ getBoolSetting: vi.fn() }));
import { getBoolSetting } from "@/services/settings";

import {
  engineerPreviewEnabled,
  engineerPreviewGloballyEnabled,
  isUxChangingDiff,
  signPreviewToken,
  verifyPreviewToken,
  rewriteHtmlForProxy,
  previewDirFor,
  buildPreviewCopyScript,
  ENGINEER_PREVIEW_INSTALL_TIMEOUT_S,
} from "../engineer-preview";
import { worktreePathFor } from "../run-worktree";

const mockedGetBool = vi.mocked(getBoolSetting);
const ALLOWED_TENANT = "73db45ff-457e-4541-bc8f-bdb625390204";
const OTHER_TENANT = "11111111-2222-3333-4444-555555555555";

describe("engineer-preview app-setting gate", () => {
  beforeEach(() => {
    mockedGetBool.mockReset();
  });

  it("setting false → disabled for every tenant (default OFF, fail-closed)", async () => {
    mockedGetBool.mockResolvedValue(false);
    expect(await engineerPreviewEnabled(ALLOWED_TENANT)).toBe(false);
    expect(await engineerPreviewEnabled(OTHER_TENANT)).toBe(false);
  });

  it("no tenant_id → disabled WITHOUT a settings read", async () => {
    mockedGetBool.mockResolvedValue(true);
    expect(await engineerPreviewEnabled(null)).toBe(false);
    expect(await engineerPreviewEnabled(undefined)).toBe(false);
    expect(mockedGetBool).not.toHaveBeenCalled();
  });

  it("per-tenant override true → enabled ONLY for that tenant", async () => {
    mockedGetBool.mockImplementation(async (_key, tenant) => tenant === ALLOWED_TENANT);
    expect(await engineerPreviewEnabled(ALLOWED_TENANT)).toBe(true);
    expect(await engineerPreviewEnabled(OTHER_TENANT)).toBe(false);
    expect(mockedGetBool).toHaveBeenCalledWith("engineer_live_preview_enabled", ALLOWED_TENANT);
  });

  it("settings read throws → fail-closed (disabled)", async () => {
    mockedGetBool.mockRejectedValue(new Error("settings store blip"));
    expect(await engineerPreviewEnabled(ALLOWED_TENANT)).toBe(false);
  });

  it("engineerPreviewGloballyEnabled reads the GLOBAL row (no tenant arg)", async () => {
    mockedGetBool.mockImplementation(async (_key, tenant) => tenant === undefined);
    expect(await engineerPreviewGloballyEnabled()).toBe(true);
    expect(mockedGetBool).toHaveBeenCalledWith("engineer_live_preview_enabled");
    expect((mockedGetBool.mock.calls[0] as unknown[]).length).toBe(1);
  });

  it("global read throws → fail-closed (disabled)", async () => {
    mockedGetBool.mockRejectedValue(new Error("settings store blip"));
    expect(await engineerPreviewGloballyEnabled()).toBe(false);
  });
});

describe("isUxChangingDiff", () => {
  it("true for render-surface extensions", () => {
    expect(isUxChangingDiff([{ path: "src/components/Button.tsx" }])).toBe(true);
    expect(isUxChangingDiff([{ path: "styles/app.css" }])).toBe(true);
    expect(isUxChangingDiff([{ path: "index.html" }])).toBe(true);
  });
  it("true for anything under apps/web", () => {
    expect(isUxChangingDiff([{ path: "apps/web/src/lib/util.ts" }])).toBe(true);
  });
  it("false for backend-only .ts changes", () => {
    expect(
      isUxChangingDiff([
        { path: "apps/backend/src/services/foo.ts" },
        { path: "scripts/migrate.ts" },
      ]),
    ).toBe(false);
  });
  it("false for empty / malformed", () => {
    expect(isUxChangingDiff([])).toBe(false);
    expect(isUxChangingDiff([{ path: 123 as unknown as string }])).toBe(false);
  });
});

describe("preview token sign/verify", () => {
  beforeEach(() => {
    process.env.ENGINEER_PREVIEW_SIGNING_SECRET = "test-secret-abc";
  });

  it("roundtrips claims", () => {
    const t = signPreviewToken({ runId: "run-1", tenantId: "ten-A" });
    const c = verifyPreviewToken(t);
    expect(c).not.toBeNull();
    expect(c?.runId).toBe("run-1");
    expect(c?.tenantId).toBe("ten-A");
  });

  it("rejects a tampered signature", () => {
    const t = signPreviewToken({ runId: "run-1", tenantId: "ten-A" });
    const [body] = t.split(".");
    expect(verifyPreviewToken(`${body}.deadbeef`)).toBeNull();
  });

  it("rejects a tampered payload (sig no longer matches)", () => {
    const t = signPreviewToken({ runId: "run-1", tenantId: "ten-A" });
    const [, sig] = t.split(".");
    const forged = Buffer.from(
      JSON.stringify({ runId: "run-1", tenantId: "ten-EVIL", exp: Date.now() + 60000 }),
    )
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(verifyPreviewToken(`${forged}.${sig}`)).toBeNull();
  });

  it("rejects an expired token", () => {
    const past = Date.now() - 100 * 60 * 1000;
    const t = signPreviewToken({ runId: "run-1", tenantId: "ten-A" }, past);
    expect(verifyPreviewToken(t)).toBeNull();
  });

  it("rejects null/garbage", () => {
    expect(verifyPreviewToken(null)).toBeNull();
    expect(verifyPreviewToken("not-a-token")).toBeNull();
  });
});

describe("rewriteHtmlForProxy", () => {
  const prefix = "/api/workspace/engineer-preview/run-1";
  it("injects a <base href> under the prefix", () => {
    const out = rewriteHtmlForProxy("<head><title>x</title></head>", prefix);
    expect(out).toContain(`<base href="${prefix}/">`);
  });
  it("rewrites root-absolute src/href under the prefix", () => {
    const out = rewriteHtmlForProxy(
      `<script src="/_next/static/a.js"></script><a href="/about">x</a>`,
      prefix,
    );
    expect(out).toContain(`src="${prefix}/_next/static/a.js"`);
    expect(out).toContain(`href="${prefix}/about"`);
  });
  it("leaves protocol-relative + absolute URLs alone", () => {
    const out = rewriteHtmlForProxy(
      `<img src="//cdn.example.com/a.png"><a href="https://x.com">y</a>`,
      prefix,
    );
    expect(out).toContain(`src="//cdn.example.com/a.png"`);
    expect(out).toContain(`href="https://x.com"`);
  });
});

describe("worktree-not-swept-while-live invariant", () => {
  it("the preview copy dir lives OUTSIDE the worktree wt-* glob the reaper sweeps", () => {
    const run = "abc-123";
    const wt = worktreePathFor(run);
    const prev = previewDirFor(run);
    expect(wt.startsWith("/home/user/wt-")).toBe(true);
    expect(prev.startsWith("/home/user/preview-")).toBe(true);
    expect(prev.startsWith("/home/user/wt-")).toBe(false);
  });

  it("copy script excludes node_modules/.git + prefers the shared node_modules symlink", () => {
    const s = buildPreviewCopyScript({
      worktree_dir: "/home/user/wt-x",
      preview_dir: "/home/user/preview-x",
    });
    expect(s).toContain("--exclude=node_modules");
    expect(s).toContain("--exclude=.git");
    expect(s).toContain("ln -s '/home/user/repo'/node_modules");
  });
});

describe("buildPreviewCopyScript — one-time ROOT install (deps once, Tier B fix)", () => {
  it("installs at the shared ROOT (npm ci preferred) when root lacks node_modules", () => {
    const s = buildPreviewCopyScript({
      worktree_dir: "/home/user/wt-x",
      preview_dir: "/home/user/preview-x",
    });
    expect(s).toMatch(/cd '\/home\/user\/repo' && timeout \d+ npm ci --prefer-offline --no-audit --no-fund/);
    expect(s).toContain("if [ -f '/home/user/repo'/package-lock.json ]; then");
    expect(s).toMatch(/cd '\/home\/user\/repo' && timeout \d+ npm install --prefer-offline --no-audit --no-fund/);
    expect(s).not.toContain("apps/web/node_modules");
    expect(s).not.toMatch(/cd '\/home\/user\/repo\/apps\/web'/);
  });

  it("guards the install so an already-installed root is NOT re-installed", () => {
    const s = buildPreviewCopyScript({
      worktree_dir: "/home/user/wt-x",
      preview_dir: "/home/user/preview-x",
    });
    expect(s).toContain(
      "if [ ! -e '/home/user/repo'/node_modules ] && [ -f '/home/user/repo'/package.json ]; then",
    );
  });

  it("uses a generous configurable install timeout (~600s), not the old 120/240s cap", () => {
    const s = buildPreviewCopyScript({
      worktree_dir: "/home/user/wt-x",
      preview_dir: "/home/user/preview-x",
    });
    expect(ENGINEER_PREVIEW_INSTALL_TIMEOUT_S).toBe(600);
    expect(s).toContain(`timeout ${ENGINEER_PREVIEW_INSTALL_TIMEOUT_S} npm ci`);
    expect(s).not.toContain("timeout 120 npm");
    expect(s).not.toContain("timeout 240 npm");
  });

  it("honors an explicit install_timeout_s override", () => {
    const s = buildPreviewCopyScript({
      worktree_dir: "/home/user/wt-x",
      preview_dir: "/home/user/preview-x",
      install_timeout_s: 900,
    });
    expect(s).toContain("timeout 900 npm ci");
  });

  it("still symlinks the shared root node_modules into the preview copy after install", () => {
    const s = buildPreviewCopyScript({
      worktree_dir: "/home/user/wt-x",
      preview_dir: "/home/user/preview-x",
    });
    expect(s).toContain("ln -s '/home/user/repo'/node_modules '/home/user/preview-x'/node_modules");
  });

  it("emits __PREVCOPY__NOMODULES:<whitelisted npm code> when deps are absent (diagnosable)", () => {
    const s = buildPreviewCopyScript({
      worktree_dir: "/home/user/wt-x",
      preview_dir: "/home/user/preview-x",
    });
    expect(s).toContain('NPMLOG="$(mktemp)"');
    expect(s).toMatch(/npm ci --prefer-offline --no-audit --no-fund \) >"\$NPMLOG" 2>&1/);
    expect(s).toContain("echo __PREVCOPY__OK");
    expect(s).toContain("grep -oE 'npm ERR! code [A-Z0-9_]+'");
    expect(s).toContain('echo "__PREVCOPY__NOMODULES:$CODE"');
    expect(s).not.toMatch(/echo "__PREVCOPY__NOMODULES:\$\(cat/);
  });
});
