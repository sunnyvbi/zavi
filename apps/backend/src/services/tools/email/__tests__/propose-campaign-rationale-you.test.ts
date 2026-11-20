import { describe, expect, it } from "vitest";
import { makeProposeCampaignTool, type ProposeCampaignDeps } from "../propose_campaign";

describe("the email card's why is written to the founder, not about them", () => {
  it("the rationale field tells the model to say you and never the founder", () => {
    const tool = makeProposeCampaignTool({} as ProposeCampaignDeps);
    const field = (tool.input_schema as unknown as { shape: Record<string, { description?: string }> }).shape.rationale;
    expect(field.description).toMatch(/"you"/);
    expect(field.description).toMatch(/never write "the founder"/);
  });
});
