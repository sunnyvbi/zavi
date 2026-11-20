// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const hook = vi.hoisted(() => ({ state: { phase: "waiting", detail: "", elapsedSec: 3, costUsd: null } as Record<string, unknown> }));
vi.mock("@/lib/workspace/useInlineStatus", () => ({ useInlineStatus: () => hook.state }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

import { InlineStatusRow } from "../InlineStatusRow";

describe("InlineStatusRow waiting phase", () => {
  it("shows who the run is waiting on", () => {
    hook.state = { phase: "waiting", detail: "waiting on @seo", elapsedSec: 3, costUsd: null };
    render(<InlineStatusRow agentSlug="operator" runId="r1" />);
    expect(screen.getByRole("status").textContent).toContain("waiting on @seo");
  });

  it("keeps the approval copy for an approval pause", () => {
    hook.state = { phase: "waiting", detail: "waiting for your approval", elapsedSec: 3, costUsd: null };
    render(<InlineStatusRow agentSlug="operator" runId="r2" headless />);
    expect(screen.getAllByRole("status").at(-1)!.textContent).toContain("waiting for your approval");
  });
});
