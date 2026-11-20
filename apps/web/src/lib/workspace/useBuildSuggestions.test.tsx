// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { useBuildSuggestions } from "./useBuildSuggestions";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const chip = (k: string) => ({ key: k, label: `L ${k}`, prompt: "p" });

describe("useBuildSuggestions more", () => {
  it("a failed more read keeps the + (not exhausted); a capped answer hides it", async () => {
    apiFetch.mockResolvedValueOnce(json({ chips: [chip("a")] }));
    const { result } = renderHook(() => useBuildSuggestions(true, "s-1", "r-1"));
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    apiFetch.mockResolvedValueOnce(json({ error: {} }, 500));
    await act(async () => {
      await result.current.more();
    });
    expect(result.current.exhausted ?? false).toBe(false);
    expect(result.current.moreFailed).toBe(true);
    apiFetch.mockResolvedValueOnce(json({ chips: [chip("b")] }));
    await act(async () => {
      await result.current.more();
    });
    expect(result.current.moreFailed).toBe(false);
    expect(result.current.suggestions.map((s) => s.key)).toEqual(["a", "b"]);
    expect(result.current.exhausted).toBe(false);
    apiFetch.mockResolvedValueOnce(json({ chips: [], more_capped: true }));
    await act(async () => {
      await result.current.more();
    });
    expect(result.current.exhausted).toBe(true);
  });
});
