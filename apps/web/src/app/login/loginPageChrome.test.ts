
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(join(__dirname, "page.tsx"), "utf8");

const shellSource = readFileSync(
  join(__dirname, "..", "..", "components", "auth", "AuthShell.tsx"),
  "utf8",
);

const authUiSource = readFileSync(
  join(__dirname, "..", "..", "components", "auth", "authUi.ts"),
  "utf8",
);

function token(name: string): string {
  const at = authUiSource.indexOf(`export const ${name} =`);
  expect(at, name).toBeGreaterThan(-1);
  const end = authUiSource.indexOf(";", at);
  return authUiSource.slice(at, end);
}

const wordmarkRow = shellSource
  .split("\n")
  .find((line) => line.includes("compact:static") && line.includes("justify-center"));

describe("the sign-in page on a phone", () => {
  it("spaces the wordmark with padding, so no margin collapses out of the page", () => {
    expect(wordmarkRow).toBeTruthy();
    expect(wordmarkRow).toContain("compact:pt-7");
    expect(wordmarkRow).not.toMatch(/compact:mt-\d/);
  });

  it("drops the mode eyebrow, which the heading under it already says", () => {
    const eyebrow = token("AUTH_EYEBROW");
    expect(eyebrow).toContain("text-[#027bff]");
    expect(eyebrow).toContain("compact:hidden");
    expect(source).toContain(": AUTH_EYEBROW}");
  });

  it("never shows a Sign in eyebrow at any width, only the other two modes keep one", () => {
    const eyebrow = source.slice(
      source.indexOf("{(isForgot || signingUp) && ("),
      source.indexOf("<h1 className="),
    );
    expect(eyebrow).toContain("Reset password");
    expect(eyebrow).toContain("Create account");
    expect(eyebrow).not.toContain("Sign in");
  });
});

const oauthButtons = (label: string) =>
  source
    .split(/\n *<button\n/)
    .slice(1)
    .filter((b) => b.includes(`Continue with ${label}`))
    .map((b) => b.slice(0, b.indexOf("</button>")));

describe("the sign-in page's OAuth buttons", () => {
  it.each([
    ["GitHub", "github"],
    ["Google", "google"],
    ["Slack", "slack_oidc"],
  ])("renders %s twice: a labelled full-width button for desktop and an icon tile for the phone", (label, provider) => {
    const blocks = oauthButtons(label);
    expect(blocks).toHaveLength(2);
    const [labelled, tile] = blocks;
    for (const block of blocks) expect(block).toContain(`oauth("${provider}")`);
    expect(labelled).toContain(`: "Continue with ${label}"`);
    expect(labelled).toContain("Redirecting…");
    expect(labelled).toContain("className={oauthButton}");
    const style = source.split("\n").find((l) => l.includes("const oauthButton ="))!;
    expect(style).toContain("w-full");
    expect(style).toContain("h-12");
    expect(labelled).not.toContain("aria-label=");
    expect(tile).toContain(`aria-label="Continue with ${label}"`);
    expect(tile).toContain("h-14 w-14");
    expect(tile).toContain("rounded-[16px]");
    expect(tile).toContain("Loader2");
    expect(tile).not.toContain(`: "Continue with ${label}"`);
  });

  it("shows the labelled stack above the phone breakpoint and the tile row only on the phone", () => {
    const lines = source.split("\n");
    const stack = lines.find((l) => l.includes("mt-6") && l.includes("space-y-2.5"))!;
    const row = lines.find((l) => l.includes("mt-6") && l.includes("justify-center gap-4"))!;
    expect(stack).toContain("compact:hidden");
    expect(row).toContain("hidden");
    expect(row).toContain("compact:flex");
    expect(lines.indexOf(stack)).toBeLessThan(lines.indexOf(row));
  });

  it("keeps the content #2955 removed out at every width", () => {
    expect(source).not.toContain("New here?");
    expect(source).not.toContain("SlackWorkspaceHint");
    expect(source).toContain("At least 8 characters");
  });
});

describe("the sign-in page's provider row", () => {
  it("keeps the quiet email divider on the phone and the original weight on desktop", () => {
    const divider = source
      .split("\n")
      .find((l) => l.includes("my-5 flex items-center gap-3"))!;
    expect(divider).toContain("compact:text-[13px]");
    expect(divider).toContain("compact:text-[#595959]");
    expect(divider).toContain("compact:font-normal");
    expect(divider).toMatch(/(^|[\s"])text-\[16px\]/);
    expect(divider).toMatch(/(^|\s)font-medium/);
    expect(divider).toMatch(/(^|\s)text-\[#0e0f11\]/);
  });

  it("leaves no reserved hole above the submit button", () => {
    const slot = source.slice(source.indexOf('role="alert"'));
    const empty = /className=\{error \? "([^"]*)" : "([^"]*)"\}/.exec(slot);
    expect(empty).toBeTruthy();
    expect(empty![1]).toBe("mt-3");
    expect(empty![2]).toBe("");
    const submit = token("AUTH_SUBMIT");
    expect(submit).toContain("inline-flex min-h-[48px] w-full");
    expect(submit).toContain("bg-[#0e0f11]");
    expect(submit).toContain("mt-5");
    const submits = source.split("\n").filter((l) => l.includes("AUTH_SUBMIT}"));
    expect(submits.length).toBe(2);
  });

  it("gives the text buttons a 44px target that costs no layout", () => {
    const rows = source.split("\n").filter((l) => l.includes("py-["));
    expect(rows.length).toBe(3);
    for (const row of rows) {
      const pad = /(?<!-)\bpy-\[(\d+)px\]/.exec(row)?.[1];
      const pull = /-my-\[(\d+)px\]/.exec(row)?.[1];
      expect(pad, row).toBeTruthy();
      expect(pull, row).toBe(pad);
      expect(Number(pad) * 2 + 18).toBeGreaterThanOrEqual(44);
    }
  });
});
