
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/services/supabase", () => ({
  serviceClient: () => ({
    storage: {
      from: () => ({
        upload: async () => ({ data: null, error: null }),
      }),
    },
  }),
}));

import {
  captureEngineerPreview,
  previewCaptureLogMeta,
  _setPreviewSnapshotter,
  type PreviewSnapshotter,
} from "@/services/sandbox/engineer-preview-capture";
import {
  rememberPreviewCdp,
  _resetLiveViewStore,
} from "@/services/sandbox/engineer-site-preview";
import { assertBrowserLeastPrivilege } from "@/services/sandbox/browser-mcp/least-privilege";
import { ALL_BROWSER_TOOL_NAMES } from "@/services/sandbox/browser-mcp/types";
import { loadGlobalAgentDefinition } from "@/services/agents/registry";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TENANT = "ten-A";
const CDP_URL = "wss://anchor.example/cdp/sess-1";

const PLANTED_PII = "capture-leak.customer@example.com";
const RAW_DOM = `<!DOCTYPE html><html lang="en"><body>
  <header id="app-header" class="topbar" data-testid="global-header">
    <span class="greeting" data-testid="user-greeting">Welcome, ${PLANTED_PII}</span>
  </header>
  <button type="submit" class="save" data-testid="save-btn">Save</button>
</body></html>`;

function fakeSnapshotter(over?: Partial<{
  screenshotPng: Buffer | null;
  url: string | null;
  rawDomHtml: string | null;
  pickedRaw: unknown;
  throws: boolean;
}>): PreviewSnapshotter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async snapshot({ cdpUrl }) {
      calls.push(cdpUrl);
      if (over?.throws) throw new Error("cdp connect failed");
      return {
        screenshotPng:
          over?.screenshotPng !== undefined
            ? over.screenshotPng
            : Buffer.from("PNGDATA"),
        screenshotMime: "image/png",
        url: over?.url !== undefined ? over.url : "https://shop.example.com/cart",
        rawDomHtml: over?.rawDomHtml !== undefined ? over.rawDomHtml : RAW_DOM,
        pickedRaw: over?.pickedRaw,
      };
    },
  };
}

describe("engineer preview capture — slice 5b", () => {
  beforeEach(() => {
    _resetLiveViewStore();
  });
  afterEach(() => {
    _setPreviewSnapshotter(null);
    _resetLiveViewStore();
    vi.restoreAllMocks();
  });

  it("captures screenshot + URL + SCRUBBED DOM; the planted PII never survives", async () => {
    rememberPreviewCdp(SESSION_ID, TENANT, CDP_URL);
    const snap = fakeSnapshotter();
    _setPreviewSnapshotter(snap);

    const res = await captureEngineerPreview({
      session_id: SESSION_ID,
      tenant_id: TENANT,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(RAW_DOM).toContain(PLANTED_PII);
    expect(res.scrubbedDomHtml).not.toBeNull();
    expect(res.scrubbedDomHtml as string).not.toContain(PLANTED_PII);
    expect(res.scrubbedDomHtml as string).toContain('data-testid="save-btn"');
    expect(res.scrubbedDomHtml as string).toContain('id="app-header"');
    expect(res.screenshotPng).not.toBeNull();
    expect(res.url).toBe("https://shop.example.com/cart");
    expect(snap.calls).toEqual([CDP_URL]);
  });

  it("log meta contains ONLY {ms, bytes, captured} — nothing page-derived", async () => {
    rememberPreviewCdp(SESSION_ID, TENANT, CDP_URL);
    _setPreviewSnapshotter(fakeSnapshotter());

    const res = await captureEngineerPreview({
      session_id: SESSION_ID,
      tenant_id: TENANT,
    });
    const meta = previewCaptureLogMeta(res);

    expect(Object.keys(meta).sort()).toEqual(["bytes", "captured", "ms"]);
    expect(meta.captured).toBe(true);
    expect(typeof meta.bytes).toBe("number");
    expect(typeof meta.ms).toBe("number");
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain(PLANTED_PII);
    expect(serialized).not.toContain("shop.example.com");
    expect(serialized).not.toContain("data-testid");
  });

  it("no open preview session → ok:false, no throw, snapshotter NOT called", async () => {
    const snap = fakeSnapshotter();
    _setPreviewSnapshotter(snap);
    const res = await captureEngineerPreview({
      session_id: SESSION_ID,
      tenant_id: TENANT,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("no_open_preview");
    expect(snap.calls).toEqual([]);
    expect(previewCaptureLogMeta(res)).toEqual({
      ms: res.ms,
      bytes: 0,
      captured: false,
    });
  });

  it("a session_id belonging to another tenant → ok:false, snapshotter NOT called", async () => {
    rememberPreviewCdp(SESSION_ID, "ten-OTHER", CDP_URL);
    const snap = fakeSnapshotter();
    _setPreviewSnapshotter(snap);
    const res = await captureEngineerPreview({
      session_id: SESSION_ID,
      tenant_id: TENANT,
    });
    expect(res.ok).toBe(false);
    expect(snap.calls).toEqual([]);
  });

  it("a CDP/snapshot error → ok:false, no throw", async () => {
    rememberPreviewCdp(SESSION_ID, TENANT, CDP_URL);
    _setPreviewSnapshotter(fakeSnapshotter({ throws: true }));
    const res = await captureEngineerPreview({
      session_id: SESSION_ID,
      tenant_id: TENANT,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe("snapshot_failed");
  });

  it("screenshot null but DOM present → ok:true with scrubbed DOM, null screenshot", async () => {
    rememberPreviewCdp(SESSION_ID, TENANT, CDP_URL);
    _setPreviewSnapshotter(fakeSnapshotter({ screenshotPng: null }));
    const res = await captureEngineerPreview({
      session_id: SESSION_ID,
      tenant_id: TENANT,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.screenshotPng).toBeNull();
    expect(res.scrubbedDomHtml as string).not.toContain(PLANTED_PII);
  });

  it("a picked element carries selector/tag/styles through; a planted PII text field is dropped", async () => {
    rememberPreviewCdp(SESSION_ID, TENANT, CDP_URL);
    const PICKED_PII = "picked-leak.customer@example.com";
    _setPreviewSnapshotter(
      fakeSnapshotter({
        pickedRaw: {
          selector: "#app-header > button.save",
          tag: "BUTTON",
          testid: "save-btn",
          text: PICKED_PII,
          styles: {
            display: "flex",
            fontWeight: "600",
            color: "rgb(0, 0, 0)",
            secretNote: PICKED_PII,
          },
        },
      }),
    );

    const res = await captureEngineerPreview({
      session_id: SESSION_ID,
      tenant_id: TENANT,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pickedElement).not.toBeNull();
    const picked = res.pickedElement!;
    expect(picked.selector).toBe("#app-header > button.save");
    expect(picked.tag).toBe("button");
    expect(picked.testid).toBe("save-btn");
    expect(picked.styles.display).toBe("flex");
    expect(picked.styles.fontWeight).toBe("600");
    expect(picked.styles).not.toHaveProperty("secretNote");
    expect(JSON.stringify(picked)).not.toContain(PICKED_PII);
    expect(JSON.stringify(previewCaptureLogMeta(res))).not.toContain(PICKED_PII);
    expect(JSON.stringify(previewCaptureLogMeta(res))).not.toContain("save-btn");
  });

  it("no picked element (operator never clicked) → pickedElement is null, no throw", async () => {
    rememberPreviewCdp(SESSION_ID, TENANT, CDP_URL);
    _setPreviewSnapshotter(fakeSnapshotter());
    const res = await captureEngineerPreview({
      session_id: SESSION_ID,
      tenant_id: TENANT,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pickedElement).toBeNull();
    expect(res.scrubbedDomHtml as string).toContain('data-testid="save-btn"');
    expect(Object.keys(previewCaptureLogMeta(res)).sort()).toEqual([
      "bytes",
      "captured",
      "ms",
    ]);
  });

  it("a picked value missing a selector → pickedElement null (fail-closed)", async () => {
    rememberPreviewCdp(SESSION_ID, TENANT, CDP_URL);
    _setPreviewSnapshotter(
      fakeSnapshotter({ pickedRaw: { tag: "div", styles: { display: "block" } } }),
    );
    const res = await captureEngineerPreview({
      session_id: SESSION_ID,
      tenant_id: TENANT,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pickedElement).toBeNull();
  });

  it("engineer declares no browser_* tools; assertBrowserLeastPrivilege stays green", () => {
    const engineer = loadGlobalAgentDefinition("engineer");
    expect(engineer).not.toBeNull();
    const tools = engineer?.metadata_praxis.tools ?? [];
    const browserToolSet = new Set<string>(ALL_BROWSER_TOOL_NAMES as readonly string[]);
    const browserToolsOnEngineer = tools.filter((t) => browserToolSet.has(t));
    expect(browserToolsOnEngineer).toEqual([]);
    expect(() => assertBrowserLeastPrivilege(tools)).not.toThrow();
  });
});
