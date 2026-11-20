// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { AgentPageTab } from "./AgentPageTab";

vi.mock("./ProPlanGate", () => ({
  ProPlanGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("./AgentTab", () => ({
  AgentTab: ({ slug, chatOnly }: { slug: string; chatOnly?: boolean }) => (
    <textarea aria-label={`chat:${slug}:${chatOnly ? "chatOnly" : "full"}`} />
  ),
}));

afterEach(cleanup);

const Dash = () => <h2>Engineer dashboard</h2>;

it("renders the dashboard AND that agent's chat, chat open by default", () => {
  const view = render(
    <AgentPageTab slug="engineer" Dashboard={Dash} tabId="engineer-default" />,
  );
  expect(view.getByRole("heading", { name: "Engineer dashboard" })).toBeTruthy();
  expect(view.getByRole("textbox", { name: "chat:engineer:chatOnly" })).toBeTruthy();
  expect(
    view
      .getByRole("button", { name: "Hide the conversation" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
});

it("hides and restores the chat without dropping the draft", () => {
  const view = render(
    <AgentPageTab slug="fundraising" Dashboard={Dash} tabId="t" />,
  );
  const draft = view.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(draft, { target: { value: "find seed investors" } });
  fireEvent.click(view.getByRole("button", { name: "Hide the conversation" }));
  expect(view.queryByRole("textbox")).toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Show the conversation" }));
  expect((view.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "find seed investors",
  );
  expect(view.getByRole("heading", { name: "Engineer dashboard" })).toBeTruthy();
});
