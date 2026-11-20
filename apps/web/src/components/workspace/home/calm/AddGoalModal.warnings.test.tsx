// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const posts: string[] = [];
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string) => {
    posts.push(path);
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: "g-1", warnings: ["The goal was saved, but its current value was not."] }),
    } as unknown as Response;
  },
}));

import { AddGoalModal } from "./AddGoalModal";

afterEach(cleanup);

describe("AddGoalModal", () => {
  it("shows the create warning instead of closing, then Done closes", async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(<AddGoalModal open onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByPlaceholderText(/Get weekly signups/), { target: { value: "Grow MRR to 5000" } });
    fireEvent.click(screen.getByRole("button", { name: /Set goal/ }));
    expect(await screen.findByText(/current value was not/)).toBeTruthy();
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(posts).toHaveLength(1);
  });
});
