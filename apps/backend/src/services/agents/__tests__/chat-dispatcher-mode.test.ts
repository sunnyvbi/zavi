import { describe, it, expect } from "vitest";
import { __resolveProductPmChatMode } from "../chat-dispatcher";

describe("chat-dispatcher pm mode", () => {
  it("non-pm slug → undefined", () => {
    expect(__resolveProductPmChatMode("engineer", "how do I grow?")).toBeUndefined();
  });
  it("pm strategy → strategy_memo", () => {
    expect(__resolveProductPmChatMode("pm", "how can I grow the product?")).toBe("strategy_memo");
  });
  it("pm backlog → delivery", () => {
    expect(__resolveProductPmChatMode("pm", "what's the top backlog item?")).toBe("delivery");
  });
});
