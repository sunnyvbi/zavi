// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
const refresh = vi.fn(async () => {});
vi.mock("./SetupProvider", () => ({ useSetupOptional: () => ({ refresh }) }));
vi.mock("./ImportFlow", () => ({ ImportFlow: ({ onDone }: { onDone: () => void }) => <button onClick={onDone}>I am done</button> }));
import { AddKnowledgeButton, showAddKnowledge } from "./AddKnowledgeDialog";
afterEach(cleanup);

describe("Add knowledge", () => {
  it("shows after step 1 is done or skipped, only with setup on, only to owners/admins", () => {
    expect(showAddKnowledge({ enabled: false }, true)).toBe(false);
    expect(showAddKnowledge({ enabled: true, docs: { status: "pending" } } as never, true)).toBe(false);
    expect(showAddKnowledge({ enabled: true, docs: { status: "skipped" } } as never, true)).toBe(true);
    expect(showAddKnowledge({ enabled: true, docs: { status: "skipped" } } as never, false)).toBe(false);
  });
  it("opens the same read flow in a window; I am done closes it and refreshes counts", async () => {
    render(<AddKnowledgeButton />);
    fireEvent.click(screen.getByRole("button", { name: /Add knowledge/ }));
    expect(screen.getByRole("dialog", { name: "Add knowledge" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "I am done" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(refresh).toHaveBeenCalled();
  });
});
