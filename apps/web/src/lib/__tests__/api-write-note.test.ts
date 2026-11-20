import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({ auth: { getSession: async () => ({ data: { session: { access_token: "t" } } }) } }),
}));

import { apiFetch } from "@/lib/api";
import { onApiWrite } from "@/lib/workspace/apiWrites";

const serve = (status: number) => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
};
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch tells listeners about a write that landed", () => {
  it("a saved POST, PATCH or DELETE is noted, a GET and a refused write are not", async () => {
    const seen: string[] = [];
    const off = onApiWrite((path) => seen.push(path));
    serve(200);
    await apiFetch("/a", { method: "POST" });
    await apiFetch("/b", { method: "PATCH" });
    await apiFetch("/c", { method: "DELETE" });
    await apiFetch("/d");
    serve(422);
    await apiFetch("/e", { method: "POST" });
    off();
    serve(200);
    await apiFetch("/f", { method: "POST" });
    expect(seen).toEqual(["/a", "/b", "/c"]);
  });
});
