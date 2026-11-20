import { describe, expect, it } from "vitest";
import {
  HTML_PREVIEW_MAX_ATTEMPTS,
  nextPreviewAttempt,
  previewArtifactMatchesScope,
  sanitizePreviewHtml,
} from "../html-preview-artifacts";
import { HTML_PREVIEW_MAX_CHARS } from "@/agents/engineer/output-schema";

describe("sanitizePreviewHtml", () => {
  it("preserves quotes, newlines, and Unicode without JSON serialization", () => {
    const result = sanitizePreviewHtml(
      '<!doctype html>\n<div title="Tutor">' +
        'He said "नमस्ते". தமிழ் — café 👋\n</div>',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('He said "नमस्ते"');
    expect(result.html).toContain("தமிழ் — café 👋");
  });

  it("removes active content, navigation, forms, and external CSS loads", () => {
    const result = sanitizePreviewHtml(
      `<script>alert(1)</script><iframe src="https://evil.test"></iframe>` +
        `<form action="/steal"><input onfocus="x()"></form>` +
        `<a href="https://evil.test" ping="/p" onclick="x()">link</a>` +
        `<style>@import "https://evil.test/x";.x{background:url(//evil)}</style>`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).not.toMatch(
      /script|iframe|onclick|href=|action=|ping=|@import|url\s*\(/i,
    );
    expect(result.html).toContain("<input");
  });

  it("rejects empty and oversized artifacts before persistence", () => {
    expect(sanitizePreviewHtml("   ")).toEqual({
      ok: false,
      reason: "artifact_empty",
    });
    expect(sanitizePreviewHtml("x".repeat(HTML_PREVIEW_MAX_CHARS + 1))).toEqual({
      ok: false,
      reason: "artifact_oversized",
    });
  });
});

describe("nextPreviewAttempt", () => {
  it("allows one bounded regeneration retry and never a third attempt", () => {
    expect(nextPreviewAttempt(null)).toEqual({ allowed: true, attempt: 1 });
    expect(
      nextPreviewAttempt({
        status: "html_preview_failed",
        attempt_count: 1,
      }),
    ).toEqual({ allowed: true, attempt: 2 });
    expect(
      nextPreviewAttempt({
        status: "html_preview_failed",
        attempt_count: HTML_PREVIEW_MAX_ATTEMPTS,
      }),
    ).toEqual({ allowed: false });
  });
});

describe("previewArtifactMatchesScope", () => {
  const row = { id: "preview-a", tenant_id: "tenant-a", run_id: "run-a" };

  it("rejects cross-tenant, cross-preview, and cross-run reads", () => {
    expect(
      previewArtifactMatchesScope(row, {
        tenant_id: "tenant-b",
        preview_id: "preview-a",
      }),
    ).toBe(false);
    expect(
      previewArtifactMatchesScope(row, {
        tenant_id: "tenant-a",
        preview_id: "preview-b",
      }),
    ).toBe(false);
    expect(
      previewArtifactMatchesScope(row, {
        tenant_id: "tenant-a",
        preview_id: "preview-a",
        run_id: "run-b",
      }),
    ).toBe(false);
  });

  it("accepts only the canonical owner scope", () => {
    expect(
      previewArtifactMatchesScope(row, {
        tenant_id: "tenant-a",
        preview_id: "preview-a",
        run_id: "run-a",
      }),
    ).toBe(true);
  });
});
