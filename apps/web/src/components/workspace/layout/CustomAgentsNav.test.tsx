import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomAgentsNav } from "./ContextPanel";

const ID = "44444444-4444-4444-8444-444444444444";
const agents = [{ slug: "c-aaaaaaaa01", name: "Daily standup", custom: true, custom_agent_id: ID }];

const current = (activeAgentId: string | null) =>
  renderToStaticMarkup(
    <CustomAgentsNav agents={agents} activeAgentId={activeAgentId} onOpen={() => {}} />,
  ).includes('aria-current="page"');

describe("CustomAgentsNav", () => {
  it("marks the row current when the page was opened by id", () => {
    expect(current(ID)).toBe(true);
  });
  it("marks the row current when the page was opened by slug", () => {
    expect(current("c-aaaaaaaa01")).toBe(true);
  });
  it("leaves it alone on the list or another agent's page", () => {
    expect(current(null)).toBe(false);
    expect(current("55555555-5555-4555-8555-555555555555")).toBe(false);
  });
});
