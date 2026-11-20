import { describe, expect, it } from "vitest";
import {
  appendUiWireframeToPrBody,
  buildUiWireframe,
  isUiReviewFile,
} from "../wireframe";

const uiFile = {
  path: "apps/web/src/components/TripCard.tsx",
  action: "modify" as const,
  diff: [
    "--- a/apps/web/src/components/TripCard.tsx",
    "+++ b/apps/web/src/components/TripCard.tsx",
    "@@ -1,4 +1,7 @@",
    '-        <button>Cancel trip</button>',
    '+        <p>Verification: Needs review</p>',
    '+        <button aria-label="Approve trip">Approve</button>',
    '+        <input placeholder="Message guest" />',
  ].join("\n"),
  content: "export function TripCard() { return null; }\n",
};

describe("engineer PR wireframe", () => {
  it("detects UI review files and skips test/story files", () => {
    expect(isUiReviewFile("apps/web/src/components/TripCard.tsx")).toBe(true);
    expect(isUiReviewFile("apps/mobile/app/(tabs)/trips.tsx")).toBe(true);
    expect(isUiReviewFile("src/app/page.tsx")).toBe(true);
    expect(isUiReviewFile("apps/web/src/app/globals.css")).toBe(true);

    expect(isUiReviewFile("apps/backend/src/routes/trips.ts")).toBe(false);
    expect(isUiReviewFile("apps/web/src/components/TripCard.test.tsx")).toBe(false);
    expect(isUiReviewFile("apps/web/src/components/TripCard.stories.tsx")).toBe(false);
  });

  it("builds a compact wireframe from visible UI diff text", () => {
    const wireframe = buildUiWireframe([uiFile]);

    expect(wireframe).toContain("### Wireframe");
    expect(wireframe).toContain("TripCard");
    expect(wireframe).toContain('before: "Cancel trip"');
    expect(wireframe).toContain("Verification: Needs review");
    expect(wireframe).toContain("[Approve trip]");
    expect(wireframe).toContain("Message guest");
  });

  it("appends the wireframe to PR body for UI changes", () => {
    const body = appendUiWireframeToPrBody("## Summary\nAdds review controls.", [
      uiFile,
    ]);

    expect(body).toContain("## Summary\nAdds review controls.");
    expect(body).toContain("### Wireframe");
    expect(body.length).toBeLessThanOrEqual(8000);
  });

  it("does not append for non-UI diffs", () => {
    const body = appendUiWireframeToPrBody("## Summary\nBackend fix.", [
      {
        path: "apps/backend/src/routes/trips.ts",
        action: "modify" as const,
        diff: "+export const ok = true;\n",
        content: "export const ok = true;\n",
      },
    ]);

    expect(body).toBe("## Summary\nBackend fix.");
  });

  it("does not duplicate an existing wireframe section", () => {
    const existing = "## Summary\nx\n\n### Wireframe\nAlready here.";

    expect(appendUiWireframeToPrBody(existing, [uiFile])).toBe(existing);
  });

  it("preserves the schema body cap when the PR body is nearly full", () => {
    const largeBody = "x".repeat(7600);
    const body = appendUiWireframeToPrBody(largeBody, [uiFile]);

    expect(body).toBe(largeBody);
    expect(body.length).toBeLessThanOrEqual(8000);
  });

  it("keeps truncated wireframes as closed markdown code fences", () => {
    const files = Array.from({ length: 4 }, (_, index) => {
      const longText = `Very descriptive changed customer-facing surface ${index} with enough copy to wrap across several wireframe rows`;
      return {
        path: `apps/web/src/components/VeryLongComponentName${index}.tsx`,
        action: "modify" as const,
        diff: [
          "--- a/x.tsx",
          "+++ b/x.tsx",
          "@@ -1,3 +1,8 @@",
          `-        <p>Old ${longText}</p>`,
          `+        <p>${longText}</p>`,
          `+        <button aria-label="Primary action ${longText}">Primary action ${index}</button>`,
          `+        <input placeholder="Secondary input ${longText}" />`,
          `+        <span title="Status label ${longText}">Status label ${index}</span>`,
        ].join("\n"),
        content: "export function X() { return null; }\n",
      };
    });

    const body = appendUiWireframeToPrBody("", files);

    expect(body).toContain("[wireframe truncated to fit PR body limit]");
    expect(body.trimEnd().endsWith("```")).toBe(true);
    expect(body.length).toBeLessThanOrEqual(8000);
  });
});
