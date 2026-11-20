import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { DecisionBody } from "./ApprovalsIsland";

const island = readFileSync(join(__dirname, "ApprovalsIsland.tsx"), "utf8");

describe("DecisionBody renders a Composio write as the full card", () => {
  it("app, action, every field and the red label, without a raw JSON wall", () => {
    const html = renderToString(
      <DecisionBody
        decisionClass="composio.moves_money"
        handler="composio.execute_tool"
        body={{ kind: "composio_write", app_name: "Square", action: "Create refund", arguments: { amount: 500, charge: "ch_1" }, labels: ["moves_money"], fingerprint: "a".repeat(64) }}
      />,
    );
    expect(html).toContain("Square: Create refund");
    expect(html).toContain(">amount<");
    expect(html).toContain(">ch_1<");
    expect(html).toContain("Moves money");
    expect(html).not.toContain("&quot;kind&quot;");
  });
});

describe("approve surfaces send the seal", () => {
  it("the island approves with approveExtrasFor (the card's fingerprint)", () => {
    expect(island).toMatch(/approveExtrasFor\(/);
  });
  it("the island surfaces a crashed Composio dispatch as Outcome unknown", () => {
    expect(island).toContain('apiFetch("/api/approvals?status=dispatching")');
    expect(island).toMatch(/outcomeUnknownRows\(/);
    expect(island).toContain("Outcome unknown. Check");
  });
});
