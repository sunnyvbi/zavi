// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { GeoPromptSetup } from "./GeoPromptSetup";

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
});

type Deferred = { promise: Promise<unknown>; resolve: (v: unknown) => void };
function deferred(): Deferred {
  let resolve!: (v: unknown) => void;
  const promise = new Promise<unknown>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const emptySet = { ok: true, json: async () => ({ active: [], suggested: [] }) };

function Parent({ tick }: { tick: number }) {
  const [n, setN] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setN((v) => v + 1)}>
        re-render
      </button>
      <span data-testid="renders">{n + tick}</span>
      {}
      <GeoPromptSetup brand="Upcar" autoStart onChanged={() => {}} />
    </div>
  );
}

describe("GeoPromptSetup — the starter spinner always clears", () => {
  it("survives a re-render while the draft is in flight", async () => {
    const post = deferred();
    apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/api/geo/prompts") return emptySet;
      if (path === "/api/geo/prompts/starter" && init?.method === "POST") return post.promise;
      return { ok: false, json: async () => ({}) };
    });

    render(<Parent tick={0} />);
    expect(await screen.findByText(/choosing the questions to track/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "re-render" }));
    fireEvent.click(screen.getByRole("button", { name: "re-render" }));

    post.resolve({
      ok: false,
      json: async () => ({
        error: { message: "Zavi's writing model is rate-limited right now — that is on Zavi's side, not yours. Try again in a minute." },
      }),
    });

    await waitFor(() =>
      expect(screen.queryByText(/choosing the questions to track/i)).toBeNull(),
    );
    expect(screen.getByText(/rate-limited right now/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Suggest prompts/ })).toBeTruthy();
  });

  it("shows the refusal in plain words, never the provider's error", async () => {
    apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/api/geo/prompts") return emptySet;
      if (path === "/api/geo/prompts/starter" && init?.method === "POST") {
        return {
          ok: false,
          json: async () => ({
            error: {
              code: "draft_unavailable",
              message: "Zavi's writing model is rate-limited right now — that is on Zavi's side, not yours. Try again in a minute.",
            },
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });

    render(<GeoPromptSetup brand="Upcar" autoStart onChanged={() => {}} />);

    expect(await screen.findByText(/rate-limited right now/i)).toBeTruthy();
    expect(screen.queryByText(/429|request_id|rate_limit_error/)).toBeNull();
  });

  it("lists what Zavi picked, with a way to remove each one", async () => {
    const onChanged = vi.fn();
    let active: Array<{ id: string; prompt_text: string; rationale: string | null }> = [];
    apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path === "/api/geo/prompts") {
        return { ok: true, json: async () => ({ active, suggested: [] }) };
      }
      if (path === "/api/geo/prompts/starter" && init?.method === "POST") {
        active = [
          { id: "p1", prompt_text: "best app to rent a car by the hour", rationale: "Recommendation intent" },
        ];
        return { ok: true, json: async () => ({ ok: true, state: "started", accepted: 1 }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<GeoPromptSetup brand="Upcar" autoStart onChanged={onChanged} />);

    expect(await screen.findByText("best app to rent a car by the hour")).toBeTruthy();
    expect(screen.getByText("Tracked prompts (1)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("never seeds a tenant that already has a set", async () => {
    const calls: string[] = [];
    apiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path === "/api/geo/prompts") {
        return {
          ok: true,
          json: async () => ({
            active: [{ id: "a1", prompt_text: "cheapest way to rent a car", rationale: null }],
            suggested: [],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<GeoPromptSetup brand="Upcar" autoStart onChanged={() => {}} />);

    await screen.findByText("cheapest way to rent a car");
    expect(calls).not.toContain("POST /api/geo/prompts/starter");
  });
});
