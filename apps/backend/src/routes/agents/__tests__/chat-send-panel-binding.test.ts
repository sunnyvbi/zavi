
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "..", "chat-send.ts"), "utf8");
const code = src
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
  .join("\n");

describe("chat-send panel binding (S4)", () => {
  it("accepts panel_session_id as a uuid only", () => {
    expect(code).toMatch(/panel_session_id:\s*z\.string\(\)\.uuid\(\)\.optional\(\)/);
  });

  it("binds with the JWT user and active tenant, never a body id", () => {
    const call = code.match(/bindRunToPanelSession\(\{([\s\S]*?)\}\)/)?.[1] ?? "";
    expect(call).toMatch(/tenant_id:\s*auth\.tenant_id/);
    expect(call).toMatch(/user_id:\s*auth\.user_id/);
    expect(call).toMatch(/panel_session_id:\s*body\.panel_session_id/);
    expect(call).not.toMatch(/body\.(tenant_id|user_id|tab_id)/);
  });

  it("binds before the run is dispatched", () => {
    const bind = code.indexOf("bindRunToPanelSession({");
    const dispatch = code.indexOf("buildRunRequestedEvent({", bind);
    expect(bind).toBeGreaterThan(0);
    expect(dispatch).toBeGreaterThan(bind);
  });
});
