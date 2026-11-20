
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const BACKEND_SRC = path.join(process.cwd(), "src");
const AGENTS_ROOT = path.join(BACKEND_SRC, "agents");
const TOOL_SRC = path.join(
  BACKEND_SRC,
  "services",
  "tools",
  "report",
  "render_pdf.ts",
);

describe("PDF artifact-delivery rule — no 'Artifacts tab' regression lock", () => {
  it("the shared report__render_pdf tool description carries the delivery rule", () => {
    const src = readFileSync(TOOL_SRC, "utf-8");
    expect(src).toMatch(/DELIVERY — where the file shows up/);
    expect(src).toMatch(/The chip on this message is the/);
    expect(src).toMatch(/do NOT redirect the operator somewhere else/);
    expect(src).toMatch(/there is no 'Files' or 'Downloads' page/);
  });

  it("the pm agent.md artifact-delivery rule names the chip as the only location", () => {
    const body = readFileSync(
      path.join(AGENTS_ROOT, "pm", "agent.md"),
      "utf-8",
    );
    expect(body).toMatch(/NEVER redirect the operator somewhere else to fetch the file/);
    expect(body).toMatch(/clickable chip directly under this chat message/);
  });

  it("the operator agent.md document-delivery rule refuses to claim a delivery it cannot perform", () => {
    const body = readFileSync(
      path.join(AGENTS_ROOT, "operator", "agent.md"),
      "utf-8",
    );
    expect(body).toMatch(
      /You can only deliver into the conversation you are already in/,
    );
    expect(body).toMatch(/NEVER claim you posted, sent, or DM'd something you did not/);
    expect(body).toMatch(/Failed render → still deliver, in chat/);
  });
});
