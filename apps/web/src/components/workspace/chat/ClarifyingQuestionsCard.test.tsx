// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock("@/lib/agentRegistry", () => ({ agentDisplayName: (slug: string) => slug }));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null }) }),
      }),
    }),
    rpc: async () => ({ data: null, error: null }),
  }),
}));

import { ClarifyingQuestionsCard, type ClarifyEnvelope } from "./ClarifyingQuestionsCard";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function envelope(required = false): ClarifyEnvelope {
  return {
    envelope_kind: "clarifying_questions",
    schema_version: 1,
    request_id: REQUEST_ID,
    agent_slug: "operator",
    questions: [
      {
        id: "goal",
        header: "Page goal",
        text: "What is this landing page for?",
        type: "single",
        options: [
          { id: "host", label: "Host acquisition" },
          { id: "other", label: "Something else" },
        ],
        allow_other: true,
        required,
      },
    ],
  };
}

function option(name: string) {
  return screen.getByRole("radio", { name: new RegExp(name) });
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
});
afterEach(cleanup);

describe("ClarifyingQuestionsCard single-select deselect (#25)", () => {
  it("clicking the selected option again clears it", () => {
    render(<ClarifyingQuestionsCard envelope={envelope()} agentSlug="operator" />);
    fireEvent.click(option("Something else"));
    expect(option("Something else").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(option("Something else"));
    expect(option("Something else").getAttribute("aria-checked")).toBe("false");
    expect(option("Host acquisition").getAttribute("aria-checked")).toBe("false");
  });

  it("switching options still selects exactly one", () => {
    render(<ClarifyingQuestionsCard envelope={envelope()} agentSlug="operator" />);
    fireEvent.click(option("Host acquisition"));
    fireEvent.click(option("Something else"));
    expect(option("Host acquisition").getAttribute("aria-checked")).toBe("false");
    expect(option("Something else").getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the Other text while options are selected and cleared", () => {
    render(<ClarifyingQuestionsCard envelope={envelope()} agentSlug="operator" />);
    const other = screen.getByPlaceholderText("Something else…") as HTMLTextAreaElement;
    fireEvent.change(other, { target: { value: "city launch" } });
    fireEvent.click(option("Something else"));
    fireEvent.click(option("Something else"));
    expect(other.value).toBe("city launch");
  });

  it("submits a cleared pick with only the Other text", async () => {
    render(<ClarifyingQuestionsCard envelope={envelope()} agentSlug="operator" />);
    fireEvent.click(option("Something else"));
    fireEvent.click(option("Something else"));
    fireEvent.change(screen.getByPlaceholderText("Something else…"), {
      target: { value: "city launch" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    });
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [url, init] = apiFetch.mock.calls[0] as [string, { body: string }];
    expect(url).toBe("/api/agents/operator/clarify-submit");
    expect(JSON.parse(init.body)).toEqual({
      request_id: REQUEST_ID,
      answers: [{ question_id: "goal", other_text: "city launch" }],
    });
  });

  it("blocks submit when a required question is cleared and Other is empty", async () => {
    render(<ClarifyingQuestionsCard envelope={envelope(true)} agentSlug="operator" />);
    fireEvent.click(option("Host acquisition"));
    fireEvent.click(option("Host acquisition"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send answers" }));
    });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Page goal");
  });
});
