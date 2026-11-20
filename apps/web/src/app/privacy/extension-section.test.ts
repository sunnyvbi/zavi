
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(join(__dirname, "page.tsx"), "utf8").replace(/\s+/g, " ");

describe("the /privacy extension section", () => {
  it("exists, and is reachable from the table of contents", () => {
    expect(page).toContain('id: "chrome-extension"');
    expect(page).toContain('title: "Zavi Chrome extension"');
  });

  it("says a screenshot is sent on EVERY Send and each tab step, and never in the background", () => {
    expect(page).toContain("every time you press Send");
    expect(page).toContain("at each step while Zavi is working in your tab");
    expect(page).toContain("does not capture anything when you open the panel");
  });

  it("says Zavi works in the tab, pauses before money, and can be stopped", () => {
    expect(page).toContain("It clicks, types, scrolls and opens pages on the same website");
    expect(page).toContain("Zavi stops and asks you to confirm in the panel");
    expect(page).toContain("Press Stop or close the panel at any time to stop it.");
    expect(page).not.toContain("never clicks, types, fills in forms, or navigates");
  });

  it("states the actual capture bound", () => {
    expect(page).toContain("1568 pixels");
    expect(page).toContain("query string and fragment removed");
  });

  it("warns that the screenshot is unfiltered", () => {
    expect(page).toContain("A screenshot is not filtered");
    expect(page).toContain("messages from other people");
  });

  it("names who can see it, in the same terms as the consent screen", () => {
    expect(page).toContain("Zavi staff supporting your account");
    expect(page).toContain("review of answer quality");
  });

  it("makes the Limited Use commitments explicitly", () => {
    expect(page).toContain("We do not sell it");
    expect(page).toContain("do not use it to train any foundation model");
    expect(page).toContain("Chrome Web Store User Data Policy");
  });

  it("promises deletion on revoke, and points at the deletion page", () => {
    expect(page).toContain("the screenshots it already sent for you are deleted");
    expect(page).toContain("/legal/data-deletion");
  });

  it("carries the date of the last material change", () => {
    expect(page).toContain('const LAST_UPDATED = "2026-10-19"');
  });
});
