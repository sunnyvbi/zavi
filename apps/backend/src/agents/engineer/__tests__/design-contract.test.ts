import { describe, it, expect } from "vitest";
import {
  selectApprovedPreview,
  buildDesignContract,
  detectNativeControlSubstitution,
  CONTRACT_TOTAL_MAX_CHARS,
  CONTRACT_VERSION,
  getCanonicalPreviewState,
  resolveFailedPreviewTurnGate,
  selectLatestPreviewRow,
} from "../design-contract";
import type { HtmlPreview } from "../output-schema";

const mock: HtmlPreview = {
  kind: "html_preview",
  title: "Book a trial with Reethika",
  summary: "A booking modal with a custom date/time picker.",
  html: '<div class="modal"><div class="date-grid">…</div><button>Continue</button></div>',
  design_spec: {
    components: ["custom date-grid picker", "child select", "primary CTA"],
    native_controls: [],
    palette: ["#111827", "#6366f1"],
    spacing: "8px scale",
    cta_states: "disabled until child + slot chosen",
  },
};

const previewRow = (env: Record<string, unknown>) => ({
  meta: { envelope: env, envelope_schema: "pr_proposal" },
});

describe("selectApprovedPreview", () => {
  it("selects a pending html_preview on the last assistant row", () => {
    const got = selectApprovedPreview(previewRow({ ...mock, pending_html_preview: true }));
    expect(got?.title).toBe("Book a trial with Reethika");
    expect(got?.design_spec?.native_controls).toEqual([]);
  });

  it("selects even though envelope_schema is mis-stamped 'pr_proposal'", () => {
    const row = {
      meta: { envelope: { ...mock, pending_html_preview: true }, envelope_schema: "pr_proposal" },
    };
    expect(selectApprovedPreview(row)).not.toBeNull();
  });

  it("EXPIRES the contract when the last assistant turn is a pr_proposal", () => {
    const row = previewRow({ kind: "pr_proposal", repo: "acme/app", branches: [], files: [] });
    expect(selectApprovedPreview(row)).toBeNull();
  });

  it("EXPIRES the contract when the last assistant turn is prose (no envelope)", () => {
    expect(selectApprovedPreview({ meta: {} })).toBeNull();
    expect(selectApprovedPreview({})).toBeNull();
    expect(selectApprovedPreview(null)).toBeNull();
    expect(selectApprovedPreview(undefined)).toBeNull();
  });

  it("EXPIRES the contract once the preview is no longer pending", () => {
    expect(selectApprovedPreview(previewRow({ ...mock, pending_html_preview: false }))).toBeNull();
    expect(selectApprovedPreview(previewRow({ ...mock }))).toBeNull();
  });

  it("returns null on a malformed envelope rather than throwing", () => {
    expect(selectApprovedPreview(previewRow({ kind: "html_preview", pending_html_preview: true }))).toBeNull();
    expect(selectApprovedPreview({ meta: { envelope: "nonsense" } })).toBeNull();
  });

  it("selects a pending v2 metadata envelope without requiring inline HTML", () => {
    const got = selectApprovedPreview(
      previewRow({
        version: 2,
        kind: "html_preview",
        state: "html_preview_ready",
        title: "Unicode नमस्ते",
        summary: "Quotes: “safe”\nand newlines",
        preview_id: "550e8400-e29b-41d4-a716-446655440000",
        pending_html_preview: true,
      }),
    );
    expect(got).toMatchObject({
      version: 2,
      preview_id: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("marks persisted failed-preview resume state as authoritative", () => {
    expect(
      getCanonicalPreviewState(
        previewRow({
          version: 2,
          kind: "html_preview",
          state: "html_preview_failed",
          failure_reason: "truncated_response",
        }),
      ),
    ).toBe("failed");
  });
});

describe("resolveFailedPreviewTurnGate", () => {
  it("allows a normal question after a failed preview", () => {
    expect(
      resolveFailedPreviewTurnGate({
        canonical_state: "failed",
        intent: "info",
        user_text: "Why did the preview fail?",
      }),
    ).toEqual({ block_build: false, retry_preview: false });
    expect(
      resolveFailedPreviewTurnGate({
        canonical_state: "failed",
        intent: "ship",
        user_text: "don't build it yet",
      }),
    ).toEqual({ block_build: false, retry_preview: false });
  });

  it("keeps the failed state canonical across intervening prose", () => {
    const prose = { meta: { envelope: { kind: "prose_fallback" } } };
    const failed = previewRow({
      version: 2,
      kind: "html_preview",
      state: "html_preview_failed",
      failure_reason: "artifact_storage_failed",
    });
    const latestPreview = selectLatestPreviewRow([prose, failed]);
    expect(getCanonicalPreviewState(latestPreview)).toBe("failed");
    expect(
      resolveFailedPreviewTurnGate({
        canonical_state: getCanonicalPreviewState(latestPreview),
        intent: "ship",
        user_text: "implement it now",
      }),
    ).toEqual({ block_build: true, retry_preview: false });
  });

  it("blocks build and approval actions after a failed preview", () => {
    expect(
      resolveFailedPreviewTurnGate({
        canonical_state: "failed",
        intent: "ship",
        user_text: "build it",
      }),
    ).toEqual({ block_build: true, retry_preview: false });
    expect(
      resolveFailedPreviewTurnGate({
        canonical_state: "not_displayed",
        intent: "ambiguous",
        user_text: "looks good",
      }),
    ).toEqual({ block_build: true, retry_preview: false });
  });

  it("allows an explicit retry to create a fresh preview", () => {
    expect(
      resolveFailedPreviewTurnGate({
        canonical_state: "failed",
        intent: "ambiguous",
        user_text: "retry the preview",
      }),
    ).toEqual({ block_build: false, retry_preview: true });
  });

  it("clears the lock after a successful retry so approval can proceed", () => {
    const retried = resolveFailedPreviewTurnGate({
      canonical_state: "ready",
      intent: "ambiguous",
      user_text: "looks good",
    });
    expect(retried).toEqual({ block_build: false, retry_preview: false });
  });
});

describe("buildDesignContract", () => {
  it("carries the spec, the rationale and the mock", () => {
    const c = buildDesignContract({
      ...mock,
      rationale: [{ change: "custom picker", why: "native one is ugly on mobile" }],
    });
    expect(c.text).toContain("Book a trial with Reethika");
    expect(c.text).toContain("custom date-grid picker");
    expect(c.text).toContain("native one is ugly on mobile");
    expect(c.text).toContain("<div class=\"modal\">");
    expect(c.truncated).toBe(false);
    expect(c.version).toBe(CONTRACT_VERSION);
    expect(c.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("states NONE explicitly when the mock blessed no native controls", () => {
    const c = buildDesignContract(mock);
    expect(c.text).toContain("Native browser controls used on purpose: NONE");
  });

  it("truncates a 200KB mock to the prompt budget and keeps the spec whole", () => {
    const huge = { ...mock, html: "<div>x</div>".repeat(20_000) };
    expect(huge.html.length).toBeGreaterThan(200_000);
    const c = buildDesignContract(huge);
    expect(c.truncated).toBe(true);
    expect(c.text.length).toBeLessThanOrEqual(CONTRACT_TOTAL_MAX_CHARS + 200);
    expect(c.text).toContain("custom date-grid picker");
    expect(c.text).toContain("mock truncated");
  });

  it("degrades to html-only when the model emitted no design_spec", () => {
    const { design_spec: _omit, ...noSpec } = mock;
    const c = buildDesignContract(noSpec as HtmlPreview);
    expect(c.text).toContain("<div class=\"modal\">");
    expect(c.text).not.toContain("APPROVED DESIGN SPEC");
    expect(c.truncated).toBe(false);
  });

  it("hashes the canonical assembled body — same input, same hash", () => {
    expect(buildDesignContract(mock).hash).toBe(buildDesignContract(mock).hash);
    expect(buildDesignContract({ ...mock, title: "Other" }).hash).not.toBe(
      buildDesignContract(mock).hash,
    );
  });
});

describe("detectNativeControlSubstitution", () => {
  it("BLOCKS the reported regression: custom picker mock, diff adds datetime-local", () => {
    const added = ['  <input type="datetime-local" className="w-full" />'];
    const v = detectNativeControlSubstitution(added, mock.design_spec);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.substituted).toContain("datetime-local");
  });

  it("PASSES when the mock blessed that native control on purpose", () => {
    const spec = { ...mock.design_spec!, native_controls: ["datetime-local"] };
    const added = ['  <input type="datetime-local" />'];
    expect(detectNativeControlSubstitution(added, spec).ok).toBe(true);
  });

  it("BLOCKS a bare <select> the mock did not bless", () => {
    const v = detectNativeControlSubstitution(["  <select><option>K</option></select>"], mock.design_spec);
    expect(v.ok).toBe(false);
  });

  it("PASSES an honest design-system adaptation (mock's button -> repo's <Button>)", () => {
    const added = ["  <Button variant=\"primary\">Continue to payment</Button>"];
    expect(detectNativeControlSubstitution(added, mock.design_spec).ok).toBe(true);
  });

  it("PASSES a diff with no native controls at all", () => {
    expect(detectNativeControlSubstitution(["  <div className='date-grid' />"], mock.design_spec).ok).toBe(true);
  });

  it("with no design_spec, still blocks an unblessed native control", () => {
    const v = detectNativeControlSubstitution(['<input type="date" />'], undefined);
    expect(v.ok).toBe(false);
  });

  it("a mock that blessed only 'date' does NOT bless 'datetime-local'", () => {
    const spec = { native_controls: ["date"] };
    const v = detectNativeControlSubstitution(['<input type="datetime-local" />'], spec);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.substituted).toContain("datetime-local");

    expect(detectNativeControlSubstitution(['<input type="date" />'], spec).ok).toBe(true);
  });

  it("blesses from the model's prose ('a native datetime-local input')", () => {
    const spec = { native_controls: ["a native datetime-local input"] };
    expect(detectNativeControlSubstitution(['<input type="datetime-local" />'], spec).ok).toBe(true);
  });

  it("catches the JSX brace form: type={'datetime-local'}", () => {
    const v = detectNativeControlSubstitution(
      ["  <input type={'datetime-local'} className='w-full' />"],
      mock.design_spec,
    );
    expect(v.ok).toBe(false);
  });

  it("catches a native input hidden behind a wrapper component (<Input type=...>)", () => {
    const v = detectNativeControlSubstitution(
      ['  <Input type="date" label="When" />'],
      mock.design_spec,
    );
    expect(v.ok).toBe(false);
  });
});
