
import { describe, it, expect, vi } from "vitest";
import {
  probeBranchPreview,
  evaluateProbeResponse,
  type PreviewProbeIo,
  type LivePreview,
} from "@/services/pipeline/preview-probe";
import {
  buildSanitizedPreviewEnv,
  sanitizeSecretEnvBashLines,
  buildPreviewBootScript,
  isSecretShapedEnvKey,
  PREVIEW_SECRET_DUMMY,
  previewSecretDummy,
} from "@/services/sandbox/preview";

describe("evaluateProbeResponse", () => {
  it("200, no markers → pass", () => {
    const r = evaluateProbeResponse({ status: 200, body: "<html>hi</html>" });
    expect(r.verdict).toBe("pass");
    expect(r.http_status).toBe(200);
  });
  it("200 + all markers present → pass", () => {
    const r = evaluateProbeResponse({
      status: 200,
      body: "<html><button>Dark mode</button></html>",
      expected_markers: ["Dark mode"],
    });
    expect(r.verdict).toBe("pass");
  });
  it("200 but a required marker MISSING → fail (blocks)", () => {
    const r = evaluateProbeResponse({
      status: 200,
      body: "<html>nothing here</html>",
      expected_markers: ["Dark mode"],
    });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toBe("marker_missing");
    expect(r.evidence_md).toContain("Dark mode");
  });
  it("5xx → fail (blocks)", () => {
    const r = evaluateProbeResponse({ status: 503, body: "" });
    expect(r.verdict).toBe("fail");
    expect(r.reason).toBe("server_5xx");
    expect(r.http_status).toBe(503);
  });
  it("3xx counts as alive → pass", () => {
    expect(evaluateProbeResponse({ status: 307, body: "" }).verdict).toBe("pass");
  });
  it("4xx (unexpected, not 5xx) → skipped (non-blocking)", () => {
    const r = evaluateProbeResponse({ status: 404, body: "" });
    expect(r.verdict).toBe("skipped");
    expect(r.reason).toBe("unexpected_status");
  });
});

const INPUT = { tenant_id: "t1", repo: "praxis-build/acme", branch: "engineer/run-1" };
const LIVE_URL = "https://3000-abc123def456.e2b.app";

function makeIo(over: Partial<PreviewProbeIo> = {}): PreviewProbeIo {
  return {
    previewEnabled: vi.fn().mockResolvedValue(true),
    loadLivePreview: vi
      .fn()
      .mockResolvedValue({ preview_status: "live", preview_url: LIVE_URL } as LivePreview),
    fetchRoot: vi.fn().mockResolvedValue({ ok: true, status: 200, body: "<html>ok</html>" }),
    sleep: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("probeBranchPreview", () => {
  it("live preview + 200 + marker present → pass", async () => {
    const io = makeIo({
      fetchRoot: vi.fn().mockResolvedValue({ ok: true, status: 200, body: "<b>Dark mode</b>" }),
    });
    const r = await probeBranchPreview({ ...INPUT, expected_markers: ["Dark mode"] }, io);
    expect(r.verdict).toBe("pass");
  });

  it("live preview + 200 but marker missing → fail (app failure blocks)", async () => {
    const io = makeIo({
      fetchRoot: vi.fn().mockResolvedValue({ ok: true, status: 200, body: "<b>light</b>" }),
    });
    const r = await probeBranchPreview({ ...INPUT, expected_markers: ["Dark mode"] }, io);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toBe("marker_missing");
  });

  it("live preview returning 5xx → fail (app failure blocks)", async () => {
    const io = makeIo({
      fetchRoot: vi.fn().mockResolvedValue({ ok: true, status: 500, body: "" }),
    });
    const r = await probeBranchPreview(INPUT, io);
    expect(r.verdict).toBe("fail");
    expect(r.reason).toBe("server_5xx");
  });

  it("live-preview flag OFF → skipped (preview_disabled, non-blocking)", async () => {
    const io = makeIo({ previewEnabled: vi.fn().mockResolvedValue(false) });
    const r = await probeBranchPreview(INPUT, io);
    expect(r.verdict).toBe("skipped");
    expect(r.reason).toBe("preview_disabled");
    expect(io.loadLivePreview).not.toHaveBeenCalled();
  });

  it("no live preview (never booted) → skipped (no_live_preview, non-blocking)", async () => {
    const io = makeIo({ loadLivePreview: vi.fn().mockResolvedValue(null) });
    const r = await probeBranchPreview(INPUT, io);
    expect(r.verdict).toBe("skipped");
    expect(r.reason).toBe("no_live_preview");
    expect(io.fetchRoot).not.toHaveBeenCalled();
  });

  it("cold boot: 'starting' the whole poll window → skipped (boot_timeout, non-blocking)", async () => {
    const io = makeIo({
      loadLivePreview: vi
        .fn()
        .mockResolvedValue({ preview_status: "starting", preview_url: null } as LivePreview),
    });
    const r = await probeBranchPreview(INPUT, io);
    expect(r.verdict).toBe("skipped");
    expect(r.reason).toBe("boot_timeout");
    expect((io.loadLivePreview as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(1);
  });

  it("boot finishing mid-poll ('starting' → 'live') → probes the live preview", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ preview_status: "starting", preview_url: null })
      .mockResolvedValue({ preview_status: "live", preview_url: LIVE_URL });
    const io = makeIo({ loadLivePreview: load });
    const r = await probeBranchPreview(INPUT, io);
    expect(r.verdict).toBe("pass");
  });

  it("preview root unreachable (fetch error) → skipped (fetch_error, non-blocking)", async () => {
    const io = makeIo({
      fetchRoot: vi.fn().mockResolvedValue({ ok: false, error: "timeout" }),
    });
    const r = await probeBranchPreview(INPUT, io);
    expect(r.verdict).toBe("skipped");
    expect(r.reason).toBe("fetch_error");
  });

  it("foreign / corrupted origin → skipped (bad_origin), never fetched", async () => {
    const io = makeIo({
      loadLivePreview: vi
        .fn()
        .mockResolvedValue({ preview_status: "live", preview_url: "https://evil.example.com" }),
    });
    const r = await probeBranchPreview(INPUT, io);
    expect(r.verdict).toBe("skipped");
    expect(r.reason).toBe("bad_origin");
    expect(io.fetchRoot).not.toHaveBeenCalled();
  });

  it("bad input (missing branch) → skipped, never touches the flag", async () => {
    const io = makeIo();
    const r = await probeBranchPreview({ tenant_id: "t1", repo: "a/b", branch: "" }, io);
    expect(r.verdict).toBe("skipped");
    expect(io.previewEnabled).not.toHaveBeenCalled();
  });
});

describe("buildSanitizedPreviewEnv (E3 — deny-by-default allowlist)", () => {
  it("dummies every secret-shaped key; passes ONLY allowlisted + public build vars; drops the rest", () => {
    const raw = {
      STRIPE_SECRET_KEY: "sk_live_REALdeadbeef",
      OPERATOR_DB_URL: "postgres://real_user:realpw@db.internal:5432/prod",
      SLACK_BOT_TOKEN: "xoxb-REAL-9999",
      GITHUB_TOKEN: "ghs_REALtokenvalue",
      SOME_API_KEY: "AKIAREAL",
      MY_SECRET: "hunter2",
      DB_PASSWORD: "s3cr3t",
      NODE_OPTIONS: "--max-old-space-size=4096",
      NODE_ENV: "development",
      NEXT_PUBLIC_SITE_URL: "https://acme.example",
      VITE_FEATURE_X: "on",
      SOME_RANDOM_CONFIG: "whatever",
    };
    const out = buildSanitizedPreviewEnv(raw);

    const realSecretValues = [
      raw.STRIPE_SECRET_KEY,
      raw.OPERATOR_DB_URL,
      raw.SLACK_BOT_TOKEN,
      raw.GITHUB_TOKEN,
      raw.SOME_API_KEY,
      raw.MY_SECRET,
      raw.DB_PASSWORD,
    ];
    for (const v of Object.values(out)) {
      expect(realSecretValues).not.toContain(v);
    }

    expect(out.STRIPE_SECRET_KEY).toBe(previewSecretDummy("STRIPE_SECRET_KEY"));
    expect(out.OPERATOR_DB_URL).toBe(previewSecretDummy("OPERATOR_DB_URL"));
    expect(out.SOME_API_KEY).toBe(PREVIEW_SECRET_DUMMY);
    expect(out.MY_SECRET).toBe(PREVIEW_SECRET_DUMMY);
    expect(out.DB_PASSWORD).toBe(PREVIEW_SECRET_DUMMY);

    expect(out.NODE_OPTIONS).toBe(raw.NODE_OPTIONS);
    expect(out.NODE_ENV).toBe(raw.NODE_ENV);
    expect(out.NEXT_PUBLIC_SITE_URL).toBe(raw.NEXT_PUBLIC_SITE_URL);
    expect(out.VITE_FEATURE_X).toBe(raw.VITE_FEATURE_X);

    expect(out.SOME_RANDOM_CONFIG).toBeUndefined();
  });

  it("isSecretShapedEnvKey classifies credentials but not public build vars", () => {
    expect(isSecretShapedEnvKey("STRIPE_SECRET_KEY")).toBe(true);
    expect(isSecretShapedEnvKey("OPERATOR_DB_URL")).toBe(true);
    expect(isSecretShapedEnvKey("ANY_TOKEN")).toBe(true);
    expect(isSecretShapedEnvKey("DB_PASSWORD")).toBe(true);
    expect(isSecretShapedEnvKey("NEXT_PUBLIC_API_KEY")).toBe(false);
    expect(isSecretShapedEnvKey("NODE_ENV")).toBe(false);
  });
});

describe("sanitizeSecretEnvBashLines + boot-script wiring (E3 runtime enforcement)", () => {
  it("emits dummy exports for the known .praxis-env secret keys", () => {
    const lines = sanitizeSecretEnvBashLines();
    for (const key of ["GITHUB_TOKEN", "SLACK_BOT_TOKEN", "STRIPE_SECRET_KEY", "OPERATOR_DB_URL"]) {
      expect(lines).toContain(`export ${key}=`);
    }
    expect(lines).toContain(previewSecretDummy("STRIPE_SECRET_KEY"));
  });

  it("boot script WITH sanitize overrides secrets BEFORE launching the dev-server", () => {
    const script = buildPreviewBootScript({ sanitize_secret_env: true });
    const overrideIdx = script.indexOf("export STRIPE_SECRET_KEY=");
    const launchIdx = script.indexOf("setsid nohup bash -c");
    expect(overrideIdx).toBeGreaterThan(-1);
    expect(launchIdx).toBeGreaterThan(-1);
    expect(overrideIdx).toBeLessThan(launchIdx);
    expect(script).toContain("export OPERATOR_DB_URL=");
  });

  it("boot script WITHOUT sanitize is byte-identical to omitting the flag (product-builder path)", () => {
    const withFalse = buildPreviewBootScript({ sanitize_secret_env: false });
    const without = buildPreviewBootScript({});
    expect(withFalse).toBe(without);
    expect(without).not.toContain("export STRIPE_SECRET_KEY=");
  });
});
