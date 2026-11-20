// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { ChatBubble } from "./ChatBubble";

const RUN = "11111111-1111-4111-8111-111111111111";
const CHILD = "22222222-2222-4222-8222-222222222222";

afterEach(() => cleanup());

describe("customer chat credit visibility", () => {
  it("keeps run cost details off completed customer messages while preserving their actions", () => {
    render(
      <div>
        <div data-testid="ask">
          <ChatBubble role="user" text="Add a hero image" runIds={[RUN]} onEdit={() => {}} />
        </div>
        <div data-testid="reply">
          <ChatBubble
            role="assistant"
            text="Done, hero added."
            agentSlug="operator"
            runIds={[RUN, CHILD]}
          />
        </div>
      </div>,
    );

    for (const id of ["ask", "reply"]) {
      const turn = within(screen.getByTestId(id));
      expect(turn.getByRole("button", { name: "Copy message" })).toBeTruthy();
      expect(turn.queryByRole("button", { name: "Message options" })).toBeNull();
      expect(turn.queryByText(/credits used/i)).toBeNull();
    }
    expect(within(screen.getByTestId("ask")).getByRole("button", { name: "Edit message" })).toBeTruthy();
  });

  it("does not expose credit details on a streaming reply", () => {
    render(
      <ChatBubble
        role="assistant"
        text="Half a reply"
        agentSlug="operator"
        isStreaming
        runIds={[RUN]}
      />,
    );

    expect(screen.queryByRole("button", { name: "Message options" })).toBeNull();
    expect(screen.queryByText(/credits used/i)).toBeNull();
  });
});
