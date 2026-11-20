import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { ProposalSummary, ProposalCard } from "../ProposalCard";

const body = {
  kind: "composio_write", app_name: "Square", action: "Create refund", tool_slug: "SQUARE_CREATE_REFUND",
  arguments: { amount: 500, note: "<b>not html</b>", long: "y".repeat(5000) },
  labels: ["moves_money"], fingerprint: "a".repeat(64),
};

describe("Composio write card renders every field without expanding Why?", () => {
  for (const [name, html] of [
    ["ProposalSummary", () => renderToString(<ProposalSummary decisionClass="composio.moves_money" handler="composio.execute_tool" body={body} />)],
    ["ProposalCard", () => renderToString(<ProposalCard decisionClass="composio.moves_money" handler="composio.execute_tool" body={body} />)],
    ["ProposalCard (figma)", () => renderToString(<ProposalCard figma decisionClass="composio.moves_money" handler="composio.execute_tool" body={body} />)],
  ] as const) {
    it(`${name}: app, action, every field in full, red label, values as text`, () => {
      const out = html();
      expect(out).toContain("Square: Create refund");
      expect(out).toContain(">amount<");
      expect(out).toContain(">500<");
      expect(out).toContain("y".repeat(5000));
      expect(out).toContain("Moves money");
      expect(out).toContain("&lt;b&gt;not html&lt;/b&gt;");
      expect(out).not.toContain("<b>not html</b>");
    });
  }
});
