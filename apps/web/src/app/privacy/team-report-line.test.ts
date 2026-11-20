import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

describe("privacy page: report to Zavi team", () => {
  it("says what we keep and for how long, in the collect list", () => {
    expect(src).toContain(
      "If you send us a report from chat, we keep your note and a link to that chat for up to 180 days to fix the problem.",
    );
  });
  it("lists the class in the retention section", () => {
    const retention = src.slice(src.indexOf('id: "retention"'), src.indexOf('id: "breach"'));
    expect(retention).toContain("Reports you send from chat");
    expect(retention).toContain("180 days");
  });
});
