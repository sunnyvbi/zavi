// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
const clearers = vi.hoisted(() => new Set<() => void>());
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));
vi.mock("@/lib/workspace/sessionScopedCache", () => ({
  registerSessionScopedCache: (clear: () => void) => clearers.add(clear),
}));

import { useBlankContext } from "../BlanksFill";

const facts = (name: string) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ facts: [{ key: "company_name", value_text: name }] }) });

afterEach(cleanup);

describe("blank prefill after a different person signs in", () => {
  it("never prefills the previous person's company once the session changes", async () => {
    apiFetch.mockImplementation(() => facts("Northside Yoga"));
    const first = renderHook(() => useBlankContext(["company_name"]));
    await waitFor(() => expect(first.result.current?.companyName).toBe("Northside Yoga"));
    first.unmount();

    for (const clear of clearers) clear();

    apiFetch.mockImplementation(() => facts("Harbor Dental"));
    const second = renderHook(() => useBlankContext(["company_name"]));
    await waitFor(() => expect(second.result.current?.companyName).toBe("Harbor Dental"));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
