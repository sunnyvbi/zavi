
import { describe, it, expect } from "vitest";
import { SetBody, ClearBody } from "../engine-override";

const TID = "73db45ff-457e-4541-bc8f-bdb625390204";

describe("engine-override SetBody", () => {
  it("accepts a valid openai canary row", () => {
    expect(
      SetBody.safeParse({
        tenant_id: TID,
        agent_slug: "support-lead",
        provider: "openai",
        model: "gpt-5.5",
      }).success,
    ).toBe(true);
  });

  it("accepts a valid fireworks (GLM-5.2) canary row", () => {
    expect(
      SetBody.safeParse({
        tenant_id: TID,
        agent_slug: "engineer",
        provider: "fireworks",
        model: "accounts/fireworks/models/glm-5p2",
      }).success,
    ).toBe(true);
  });

  it("accepts anthropic revert", () => {
    expect(
      SetBody.safeParse({
        tenant_id: TID,
        agent_slug: "pm",
        provider: "anthropic",
        model: "claude-opus-4-7",
      }).success,
    ).toBe(true);
  });

  it("rejects a non-uuid tenant_id", () => {
    expect(
      SetBody.safeParse({
        tenant_id: "nope",
        agent_slug: "pm",
        provider: "openai",
        model: "gpt-5.5",
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown provider", () => {
    expect(
      SetBody.safeParse({
        tenant_id: TID,
        agent_slug: "pm",
        provider: "gemini",
        model: "x",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty model", () => {
    expect(
      SetBody.safeParse({
        tenant_id: TID,
        agent_slug: "pm",
        provider: "openai",
        model: "",
      }).success,
    ).toBe(false);
  });

  it("rejects an empty agent_slug", () => {
    expect(
      SetBody.safeParse({
        tenant_id: TID,
        agent_slug: "",
        provider: "openai",
        model: "gpt-5.5",
      }).success,
    ).toBe(false);
  });
});

describe("engine-override ClearBody", () => {
  it("accepts tenant_id + agent_slug", () => {
    expect(ClearBody.safeParse({ tenant_id: TID, agent_slug: "pm" }).success).toBe(true);
  });
  it("rejects a missing agent_slug", () => {
    expect(ClearBody.safeParse({ tenant_id: TID }).success).toBe(false);
  });
});
