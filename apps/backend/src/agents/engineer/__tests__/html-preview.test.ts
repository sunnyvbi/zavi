
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  htmlPreviewSchema,
  HTML_PREVIEW_MAX_CHARS,
  parseHtmlPreviewEnvelope,
  hasHtmlPreviewBlock,
  prProposalSchema,
} from "../output-schema";
import {
  isUxDesignShapedTurn,
  isPreviewComplaintTurn,
  previousAssistantWasHtmlPreview,
  shouldSuppressHtmlPreview,
  stripHtmlPreviewBlock,
  hasExplicitPreviewIntent,
  HTML_PREVIEW_STRIP_FALLBACK,
  resolveEngineerHtmlPreview,
  PREVIEW_APPROVE_MARKER,
  PREVIEW_INERT_MARKER,
} from "../html-preview";

const INCIDENT_COMPLAINT =
  "Actually in the preview I am not able to see what you built because apart from this page, no other page /CTA is working";

const priorWithPreview = [
  { role: "user", content: "restyle the sessions list" },
  {
    role: "assistant",
    content: `Splits the flat Sessions list into three tabs.\n\n${PREVIEW_INERT_MARKER}\n\n---\n${PREVIEW_APPROVE_MARKER}`,
  },
];

const priorWithLegacyPreview = [
  {
    role: "assistant",
    content: `Some summary.\n\n---\n${PREVIEW_APPROVE_MARKER}`,
  },
];

const priorNoPreview = [
  { role: "user", content: "what does the sessions endpoint return?" },
  { role: "assistant", content: "It returns a list of sessions. See routes/sessions.ts:41." },
];

const validPreview = {
  kind: "html_preview" as const,
  title: "Refreshed dashboard header",
  summary: "Moves the title left and recolors the CTA.",
  html: "<!doctype html><html><head><style>body{margin:0}</style></head><body><h1>Mock</h1></body></html>",
};

describe("htmlPreviewSchema", () => {
  it("accepts a well-formed html_preview body", () => {
    expect(htmlPreviewSchema.safeParse(validPreview).success).toBe(true);
  });

  it("rejects html over the 200KB cap", () => {
    const tooBig = { ...validPreview, html: "x".repeat(HTML_PREVIEW_MAX_CHARS + 1) };
    expect(htmlPreviewSchema.safeParse(tooBig).success).toBe(false);
    const atCap = { ...validPreview, html: "x".repeat(HTML_PREVIEW_MAX_CHARS) };
    expect(htmlPreviewSchema.safeParse(atCap).success).toBe(true);
  });

  it("rejects a wrong `kind` literal", () => {
    expect(
      htmlPreviewSchema.safeParse({ ...validPreview, kind: "pr_proposal" }).success,
    ).toBe(false);
  });

  it("rejects an oversized title", () => {
    expect(
      htmlPreviewSchema.safeParse({ ...validPreview, title: "t".repeat(121) }).success,
    ).toBe(false);
  });

  it("accepts an optional variant and back-compat when absent (engineer envelopes unchanged)", () => {
    expect(htmlPreviewSchema.safeParse(validPreview).success).toBe(true);
    expect(
      htmlPreviewSchema.safeParse({ ...validPreview, variant: "wireframe" }).success,
    ).toBe(true);
    expect(
      htmlPreviewSchema.safeParse({ ...validPreview, variant: "engineer_preview" }).success,
    ).toBe(true);
  });

  it("rejects an unknown variant value", () => {
    expect(
      htmlPreviewSchema.safeParse({ ...validPreview, variant: "bogus" }).success,
    ).toBe(false);
  });
});

describe("pr_proposal validation stays untouched", () => {
  it("prProposalSchema REJECTS an html_preview-shaped body", () => {
    expect(prProposalSchema.safeParse(validPreview).success).toBe(false);
  });
});

describe("parseHtmlPreviewEnvelope", () => {
  it("extracts + validates a <html_preview> block", () => {
    const raw = `here is a mock\n<html_preview>${JSON.stringify(validPreview)}</html_preview>\nthoughts`;
    expect(parseHtmlPreviewEnvelope(raw)).toEqual(validPreview);
  });

  it("returns null when no block is present", () => {
    expect(parseHtmlPreviewEnvelope("just prose, no block")).toBeNull();
  });

  it("returns null on malformed JSON inside the block", () => {
    expect(parseHtmlPreviewEnvelope("<html_preview>{not json}</html_preview>")).toBeNull();
  });

  it("returns null when the block body fails the schema (e.g. html too big)", () => {
    const bad = { ...validPreview, html: "x".repeat(HTML_PREVIEW_MAX_CHARS + 1) };
    expect(
      parseHtmlPreviewEnvelope(`<html_preview>${JSON.stringify(bad)}</html_preview>`),
    ).toBeNull();
  });

  it("parses the small v2 metadata envelope with quotes, newlines, and Unicode", () => {
    const metadata = {
      version: 2 as const,
      kind: "html_preview" as const,
      state: "html_preview_ready" as const,
      title: 'Tutor says "नमस्ते"',
      summary: "First line\nதமிழ் — café 👋",
      preview_id: "550e8400-e29b-41d4-a716-446655440000",
    };
    expect(
      parseHtmlPreviewEnvelope(
        `<html_preview>${JSON.stringify(metadata)}</html_preview>`,
      ),
    ).toEqual(metadata);
  });

  it("treats a truncated metadata block as an attempted but failed preview", () => {
    const raw =
      '<html_preview>{"version":2,"kind":"html_preview","state":"html_preview_ready"';
    expect(hasHtmlPreviewBlock(raw)).toBe(true);
    expect(parseHtmlPreviewEnvelope(raw)).toBeNull();
  });
});

describe("isUxDesignShapedTurn", () => {
  it("true for design-shaped asks", () => {
    for (const t of [
      "redesign the dashboard header",
      "change the layout of the settings page",
      "make the CTA button blue",
      "move the logo to the left",
      "tweak the spacing on the card",
      "update the headline copy",
    ]) {
      expect(isUxDesignShapedTurn(t)).toBe(true);
    }
  });

  it("false for logic / non-design asks", () => {
    for (const t of [
      "fix the null pointer in the auth service",
      "add a retry to the webhook handler",
      "why is the deploy failing",
      "",
    ]) {
      expect(isUxDesignShapedTurn(t)).toBe(false);
    }
  });

  it("false for a BARE surface noun with no change intent (RC1)", () => {
    for (const t of [
      "what page is the sessions list on?",
      "which button triggers the confirm flow",
      "is this the right screen",
      "where does the card component live",
      INCIDENT_COMPLAINT,
    ]) {
      expect(isUxDesignShapedTurn(t)).toBe(false);
    }
  });

  it("true for comparative / quality intent with no imperative verb", () => {
    for (const t of [
      "bigger button please",
      "the header is too tall",
      "make the CTA more prominent",
      "less padding on the card",
      "the cards feel cramped",
    ]) {
      expect(isUxDesignShapedTurn(t)).toBe(true);
    }
  });
});

describe("isPreviewComplaintTurn", () => {
  it("true for preview-complaint phrasings", () => {
    for (const t of [
      INCIDENT_COMPLAINT,
      "the CTAs aren't doing anything",
      "nothing happens when I click",
      "no other page is reachable",
      "the links are not clickable",
    ]) {
      expect(isPreviewComplaintTurn(t)).toBe(true);
    }
  });

  it("false for polysemous words we deliberately excluded (broken / dead)", () => {
    for (const t of [
      "the layout is broken on mobile, fix the spacing",
      "dead space above the hero, tighten it",
      "the button is broken, redesign it",
    ]) {
      expect(isPreviewComplaintTurn(t)).toBe(false);
    }
  });
});

describe("previousAssistantWasHtmlPreview", () => {
  it("true when the last assistant turn carries either marker", () => {
    expect(previousAssistantWasHtmlPreview(priorWithPreview)).toBe(true);
    expect(previousAssistantWasHtmlPreview(priorWithLegacyPreview)).toBe(true);
  });

  it("false for a normal assistant turn — even one that says the word 'preview'", () => {
    expect(previousAssistantWasHtmlPreview(priorNoPreview)).toBe(false);
    expect(
      previousAssistantWasHtmlPreview([
        { role: "assistant", content: "I opened a preview deployment for that branch." },
      ]),
    ).toBe(false);
  });

  it("false / safe on empty, null, and odd shapes", () => {
    expect(previousAssistantWasHtmlPreview([])).toBe(false);
    expect(previousAssistantWasHtmlPreview(null)).toBe(false);
    expect(previousAssistantWasHtmlPreview(undefined)).toBe(false);
    expect(
      previousAssistantWasHtmlPreview([
        { role: "assistant", content: [{ type: "text", text: PREVIEW_APPROVE_MARKER }] },
      ]),
    ).toBe(true);
  });
});

describe("shouldSuppressHtmlPreview — the shared gate (both seams)", () => {
  it("suppresses the VERBATIM operator complaint that caused the incident", () => {
    expect(
      shouldSuppressHtmlPreview({
        userText: INCIDENT_COMPLAINT,
        priorMessages: priorWithPreview,
      }),
    ).toEqual({ suppress: true, reason: "complaint" });
  });

  it("does NOT suppress a non-complaint CORRECTION after a preview (R1)", () => {
    for (const t of [
      "make the CTA larger",
      "tighter spacing on the cards",
      "use the darker green for the button",
      "restyle the tabs",
    ]) {
      expect(
        shouldSuppressHtmlPreview({ userText: t, priorMessages: priorWithPreview }),
      ).toEqual({ suppress: false });
    }
  });

  it("does NOT suppress a complaint-flavoured DESIGN ASK after a preview", () => {
    for (const t of [
      "I can't see the CTA, make it larger",
      "I can't see the CTA, move it up",
      "the links aren't clickable, use a darker green",
    ]) {
      expect(
        shouldSuppressHtmlPreview({ userText: t, priorMessages: priorWithPreview }),
      ).toEqual({ suppress: false });
    }
  });

  it("suppresses a complaint that only says 'fix it' — a repair verb is not a design ask", () => {
    for (const t of [
      "the CTA isn't working, fix it",
      "no other page works, fix it",
      "the redesign isn't working, nothing happens when I click",
    ]) {
      expect(
        shouldSuppressHtmlPreview({ userText: t, priorMessages: priorWithPreview }),
      ).toEqual({ suppress: true, reason: "complaint" });
    }
  });

  it("does NOT suppress a complaint about the PRODUCT (no preview behind it)", () => {
    expect(
      shouldSuppressHtmlPreview({
        userText: "the theme isn't working on the settings page, fix it",
        priorMessages: priorNoPreview,
      }),
    ).toEqual({ suppress: false });
  });

  it("suppresses a non-design turn as not_design_shaped", () => {
    expect(
      shouldSuppressHtmlPreview({ userText: "why is the deploy failing?" }),
    ).toEqual({ suppress: true, reason: "not_design_shaped" });
  });

  it("allows a plain design ask", () => {
    expect(shouldSuppressHtmlPreview({ userText: "redesign the hero" })).toEqual({
      suppress: false,
    });
  });
});

describe("stripHtmlPreviewBlock (RC4 backstop)", () => {
  it("removes the block so a suppressed turn never renders raw envelope JSON", () => {
    const raw = `Here you go.\n<html_preview>${JSON.stringify(validPreview)}</html_preview>\nLet me know.`;
    const out = stripHtmlPreviewBlock(raw);
    expect(out).not.toContain("<html_preview>");
    expect(out).not.toContain(validPreview.html);
    expect(out).toContain("Here you go.");
  });

  it("is a no-op on text with no block", () => {
    expect(stripHtmlPreviewBlock("just prose")).toBe("just prose");
  });
});

describe("resolveEngineerHtmlPreview", () => {
  const rawWithBlock = `<html_preview>${JSON.stringify(validPreview)}</html_preview>`;

  it("returns the surface on a UX turn WITH a valid block", () => {
    const out = resolveEngineerHtmlPreview({
      rawText: rawWithBlock,
      userText: "restyle the header",
    });
    expect(out?.envelope).toEqual(validPreview);
    expect(out?.outputText).toContain(validPreview.summary);
    expect(out?.outputText.toLowerCase()).toContain("approve");
  });

  it("returns null when the turn is NOT UX-shaped (never hijacks a coding turn)", () => {
    expect(
      resolveEngineerHtmlPreview({
        rawText: rawWithBlock,
        userText: "fix the failing test in auth.test.ts",
      }),
    ).toBeNull();
  });

  it("returns null on a UX turn with NO block", () => {
    expect(
      resolveEngineerHtmlPreview({ rawText: "no block here", userText: "redesign the page" }),
    ).toBeNull();
  });

  it("always states that the mock is static and its CTAs are inert (RC3)", () => {
    const out = resolveEngineerHtmlPreview({
      rawText: rawWithBlock,
      userText: "restyle the header",
    });
    expect(out?.outputText).toContain(PREVIEW_INERT_MARKER);
    expect(out?.outputText).toContain(PREVIEW_APPROVE_MARKER);
  });

  it("behaves as before when priorMessages is omitted", () => {
    expect(
      resolveEngineerHtmlPreview({ rawText: rawWithBlock, userText: "restyle the header" }),
    ).not.toBeNull();
  });

  it("returns null on the incident complaint even WITH a valid block in the raw text", () => {
    expect(
      resolveEngineerHtmlPreview({
        rawText: rawWithBlock,
        userText: INCIDENT_COMPLAINT,
        priorMessages: priorWithPreview,
      }),
    ).toBeNull();
  });
});

describe("isEngineerHtmlPreviewEnabled (flag, default ON since 2026-07-13)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("delegates to getBoolSetting and returns its value", async () => {
    vi.doMock("@/services/settings", () => ({
      getBoolSetting: vi.fn(async () => true),
    }));
    const { isEngineerHtmlPreviewEnabled } = await import("../engineer-html-preview-flag");
    expect(await isEngineerHtmlPreviewEnabled("t-1")).toBe(true);
  });

  it("honours an EXPLICIT per-tenant opt-out (stored false stays false)", async () => {
    vi.doMock("@/services/settings", () => ({
      getBoolSetting: vi.fn(async () => false),
    }));
    const { isEngineerHtmlPreviewEnabled } = await import("../engineer-html-preview-flag");
    expect(await isEngineerHtmlPreviewEnabled("opted-out-tenant")).toBe(false);
  });

  it("degrades to the DEFAULT (true), not to OFF, when the settings read throws", async () => {
    vi.doMock("@/services/settings", () => ({
      getBoolSetting: vi.fn(async () => {
        throw new Error("settings store down");
      }),
    }));
    const { isEngineerHtmlPreviewEnabled } = await import("../engineer-html-preview-flag");
    expect(await isEngineerHtmlPreviewEnabled("t-1")).toBe(true);
  });
});

describe("registry entry", () => {
  it("engineer_html_preview_enabled is a per-tenant boolean defaulting ON", async () => {
    const { APP_SETTINGS } = await import("@/services/settings/registry");
    const def = APP_SETTINGS.engineer_html_preview_enabled;
    expect(def.type).toBe("boolean");
    expect(def.scope).toBe("per-tenant");
    expect(def.defaultValue).toBe(true);
  });
});

describe("post-processor wiring (FAST-mode source assertion)", () => {
  const src = readFileSync(join(__dirname, "../../index.ts"), "utf-8");
  const fn = src.slice(src.indexOf("const ctoEngineerChatPostProcess"));
  const body = fn.slice(0, fn.indexOf("\n};\n"));

  it("checks isEngineerHtmlPreviewEnabled and returns BEFORE runCtoPostRun", () => {
    const flagIdx = body.indexOf("isEngineerHtmlPreviewEnabled");
    const resolveIdx = body.indexOf("resolveEngineerHtmlPreview");
    const runIdx = body.indexOf("runCtoPostRun(");
    expect(flagIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeGreaterThan(flagIdx);
    expect(runIdx).toBeGreaterThan(resolveIdx);
    const surfaceReturn = body.indexOf("html_preview surfaced");
    expect(surfaceReturn).toBeGreaterThan(-1);
    expect(surfaceReturn).toBeLessThan(runIdx);
  });

  it("STRIPS an unsolicited preview block from output_text when suppressed (RC4)", () => {
    expect(body).toContain("stripHtmlPreviewBlock");
    const stripIdx = body.indexOf("stripHtmlPreviewBlock");
    const runIdx = body.indexOf("runCtoPostRun(");
    expect(stripIdx).toBeGreaterThan(-1);
    expect(stripIdx).toBeLessThan(runIdx);
    expect(body).toMatch(/result\.output_text\s*=\s*stripped/);
  });

  it("passes prior_messages through so prior-preview detection actually works", () => {
    expect(body).toContain("prior_messages");
    expect(body).toMatch(/priorMessages/);
  });
});

describe("SEAM 1 — generic-dispatcher gates the HTML PREVIEW MODE injection", () => {
  const src = readFileSync(
    join(__dirname, "../../../services/agents/generic-dispatcher.ts"),
    "utf-8",
  );

  it("calls shouldSuppressHtmlPreview BEFORE injecting the block", () => {
    const gateIdx = src.indexOf("shouldSuppressHtmlPreview({");
    const injectIdx = src.indexOf("## HTML PREVIEW MODE");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(injectIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(injectIdx);
    expect(src).toMatch(/!hpGate\.suppress\s*&&/);
  });

  it("reads the user text AND prior_messages off the payload at the injection site", () => {
    const region = src.slice(
      src.indexOf("SEAM 1 — THE SUPPRESSION GATE"),
      src.indexOf("## HTML PREVIEW MODE"),
    );
    expect(region).toContain("current_user_text_raw");
    expect(region).toContain("prior_messages");
  });

  it("logs the suppression reason (default-ON trigger-semantics change needs prod visibility)", () => {
    expect(src).toMatch(/injection suppressed — reason=/);
  });
});

describe("HTML PREVIEW MODE prompt — design-token grounding contract", () => {
  const dispatcher = readFileSync(
    join(__dirname, "../../../services/agents/generic-dispatcher.ts"),
    "utf-8",
  );
  const agentMd = readFileSync(join(__dirname, "../agent.md"), "utf-8");
  const injected = dispatcher.slice(
    dispatcher.indexOf("## HTML PREVIEW MODE"),
    dispatcher.indexOf("Shareable-prototype extension"),
  );

  it("mandates reading the repo's real design tokens before writing HTML", () => {
    expect(injected).toContain("tailwind.config");
    expect(injected).toMatch(/globals\.css/);
    expect(injected).toMatch(/GROUND THE DESIGN SYSTEM FIRST/i);
  });

  it("forbids inventing a palette — the actual incident was a generic purple mock", () => {
    expect(injected).toMatch(/Do NOT invent a palette/i);
    expect(injected).toMatch(/indigo\/violet\/purple/i);
  });

  it("requires the model to CITE the file + token values it used", () => {
    expect(injected).toMatch(/CITE YOUR GROUNDING/i);
  });

  it("agent.md's Path U carries the same key clauses (no drift)", () => {
    const pathU = agentMd.slice(agentMd.indexOf("**Path U —"));
    const para = pathU.slice(0, pathU.indexOf("\n"));
    expect(para).toContain("tailwind.config");
    expect(para).toMatch(/Do NOT invent a palette/i);
    expect(para).toMatch(/indigo\/violet\/purple/i);
    expect(para).toMatch(/inert/i);
  });
});

describe("BUG 1 — re-show the preview", () => {
  const previewFixture = {
    kind: "html_preview" as const,
    title: "Tutor dashboard",
    summary: "Bookings inbox, grounded in the real design tokens.",
    html: "<!doctype html><html><body><h1>Mock</h1></body></html>",
  };
  const rawWithBlock = `<html_preview>${JSON.stringify(previewFixture)}</html_preview>`;

  it.each([
    "can I see the preview again?",
    "show me the preview again",
    "can I see that mock again",
    "re-show the prototype",
  ])("does NOT suppress an explicit re-show ask: %s", (t) => {
    expect(shouldSuppressHtmlPreview({ userText: t }).suppress).toBe(false);
  });

  it("surfaces the preview instead of dumping raw HTML", () => {
    const out = resolveEngineerHtmlPreview({
      rawText: rawWithBlock,
      userText: "can I see the preview again?",
    });
    expect(out?.envelope).toEqual(previewFixture);
  });

  it("BUG 2 still wins: a complaint about the preview is NOT a re-show ask", () => {
    const d = shouldSuppressHtmlPreview({
      userText: "the preview isn't working, fix it",
      priorMessages: priorWithPreview,
    });
    expect(d.suppress).toBe(true);
    expect(d.reason).toBe("complaint");
  });
});

describe("BUG 1 — a raw block must never reach a bubble, on any path", () => {
  const block = `<html_preview>${JSON.stringify(validPreview)}</html_preview>`;

  it("strips a MALFORMED block (parser returns null → used to leak raw)", () => {
    const bad = "<html_preview>{ not json at all </html_preview>";
    expect(parseHtmlPreviewEnvelope(bad)).toBeNull();
    expect(hasHtmlPreviewBlock(bad)).toBe(true);
    expect(stripHtmlPreviewBlock(`Intro.\n${bad}`)).toBe("Intro.");
  });

  it("strips an OVER-CAP block (>200KB html → schema fails → used to leak raw)", () => {
    const tooBig = `<html_preview>${JSON.stringify({
      ...validPreview,
      html: "x".repeat(HTML_PREVIEW_MAX_CHARS + 1),
    })}</html_preview>`;
    expect(parseHtmlPreviewEnvelope(tooBig)).toBeNull();
    const out = stripHtmlPreviewBlock(`Intro.\n${tooBig}`);
    expect(out).toBe("Intro.");
    expect(out.length).toBeLessThan(100);
  });

  it("strips MULTIPLE blocks and MIXED-CASE blocks", () => {
    expect(stripHtmlPreviewBlock(`A${block}B${block}C`)).toBe("ABC");
    expect(
      stripHtmlPreviewBlock('Intro.\n<HTML_PREVIEW>{"kind":"x"}</HTML_PREVIEW>'),
    ).toBe("Intro.");
  });

  it("returns readable text, NOT an empty bubble, when the block was the whole message", () => {
    expect(stripHtmlPreviewBlock(block)).toBe(HTML_PREVIEW_STRIP_FALLBACK);
  });

  it("is a no-op on text with no block (the 99% path)", () => {
    expect(stripHtmlPreviewBlock("just a normal answer")).toBe("just a normal answer");
  });

  it("strips an UNTERMINATED (truncated) preview block through EOF", () => {
    const raw = `Here you go.\n<html_preview>{"kind":"html_preview","title":"x","html":"<div>lots of inline`;
    const out = stripHtmlPreviewBlock(raw);
    expect(out).not.toContain("<html_preview>");
    expect(out).not.toContain("kind");
    expect(out).toBe("Here you go.");
  });

  it("strips a leading unterminated block to the fallback (nothing else in the message)", () => {
    expect(stripHtmlPreviewBlock('<html_preview>{"kind":"html_preview","html":"<div>')).toBe(
      HTML_PREVIEW_STRIP_FALLBACK,
    );
  });

  it("hasHtmlPreviewBlock detects an unterminated opening tag (so the gate fires)", () => {
    expect(hasHtmlPreviewBlock('intro <html_preview>{"kind":"html_preview"')).toBe(true);
  });
});

describe("BUG 1 — dispatcher seam (the fleet-breaking invariant)", () => {
  const src = readFileSync(
    join(__dirname, "../../../services/agents/generic-dispatcher.ts"),
    "utf-8",
  );

  it("assigns raw_response_text from the UNSTRIPPED rawText", () => {
    expect(src).toContain("raw_response_text: rawText,");
  });

  it("strips the citation output, NEVER rawText", () => {
    expect(src).toContain("const rawTextStripped = stripHtmlPreviewBlock(rawTextCited);");
    expect(src).not.toMatch(/rawText\s*=\s*stripHtmlPreviewBlock/);
  });

  it("strips assistant_turns (Slack posts them verbatim), keeping the >= 2 guard", () => {
    expect(src).toContain("assistantTurns.length >= 2");
    expect(src).toContain("assistantTurns.map(stripHtmlPreviewBlock)");
  });

  it("redacts stage_preview HTML from persisted tool-call input previews", () => {
    expect(src).toContain('toolName.endsWith("__stage_preview")');
    expect(src).toContain('html: "[stored separately]"');
    expect(src).not.toContain(
      "input_preview: previewJson(block.input, INPUT_PREVIEW_BYTES)",
    );
    expect(src).not.toContain(
      "input_preview: previewJson(ev.input, INPUT_PREVIEW_BYTES)",
    );
  });
});

describe("BUG 1 — no surprise PR", () => {
  const src = readFileSync(join(__dirname, "../../index.ts"), "utf-8");
  const fn = src.slice(src.indexOf("const ctoEngineerChatPostProcess"));
  const body = fn.slice(0, fn.indexOf("\n};\n"));

  it("suppresses the build when an explicit preview ask yields an unusable block", () => {
    const suppressIdx = body.indexOf("hasExplicitPreviewIntent(userText)");
    expect(suppressIdx).toBeGreaterThan(-1);
    expect(body.indexOf("runCtoPostRun(")).toBeGreaterThan(suppressIdx);
  });

  it("removes preview payloads before raw_response_text is persisted", () => {
    expect(body).toMatch(/result\.raw_response_text\s*=\s*stripped/);
    expect(body).toContain(
      "result.raw_response_text = stripHtmlPreviewBlock(rawText)",
    );
  });

  it("lets info turns return before the failed-preview build override", () => {
    const infoIdx = body.indexOf('if (ctoChatIntent === "info")');
    const blockedIdx = body.indexOf("preview_build_blocked");
    expect(infoIdx).toBeGreaterThan(-1);
    expect(blockedIdx).toBeGreaterThan(infoIdx);
  });

  it("handles a successful retry surface before the retry fallback", () => {
    const surfaceIdx = body.indexOf("if (surface) {");
    const retryFallbackIdx = body.indexOf("preview_retry_requested");
    expect(surfaceIdx).toBeGreaterThan(-1);
    expect(retryFallbackIdx).toBeGreaterThan(surfaceIdx);
  });
});

describe("hasExplicitPreviewIntent — a coding turn must never block a build", () => {
  it.each([
    "fix the button click handler",
    "fix dashboard page data fetching",
    "run the tests again",
    "show me the failing test",
    "render the list server-side",
  ])("FALSE for an ordinary coding turn: %s", (t) => {
    expect(hasExplicitPreviewIntent(t)).toBe(false);
  });

  it.each(["can I see the preview again?", "show me the preview", "mock it up first"])(
    "TRUE for an explicit preview ask: %s",
    (t) => {
      expect(hasExplicitPreviewIntent(t)).toBe(true);
    },
  );
});

describe('stripHtmlPreviewBlock — must not hijack an unrelated empty reply', () => {
  it('leaves an already-empty / whitespace-only reply EMPTY (no preview copy)', () => {
    expect(stripHtmlPreviewBlock("")).toBe("");
    expect(stripHtmlPreviewBlock("   ")).toBe("");
    expect(stripHtmlPreviewBlock("\n\n")).toBe("");
  });
});
