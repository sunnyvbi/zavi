// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/lib/consent", () => ({ hasAnalyticsConsent: () => false }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn(async (path: string) => ({
  ok: path.endsWith("/config"),
  status: path.endsWith("/config") ? 200 : 400,
  headers: new Headers(),
  json: async () => path.endsWith("/config") ? { captcha: { required: false } } : { error: { recoverable: true, message: "Test refusal" } },
})) }));

import { apiFetch } from "@/lib/api";
import { LaunchVideoForm } from "./LaunchVideoForm";

afterEach(() => { cleanup(); vi.clearAllMocks(); window.localStorage.clear(); window.history.replaceState({}, "", "/"); });

describe("launch-video URL attribution", () => {
  it("sends the landing source with generation even when analytics storage is declined", async () => {
    window.history.replaceState({}, "", "/launch-video?from=filter-coffee&utm_source=newsletter&utm_campaign=launch");
    render(<LaunchVideoForm />);
    fireEvent.submit(screen.getByRole("form", { name: "Launch video details" }));
    await waitFor(() => {
      const call = vi.mocked(apiFetch).mock.calls.find(([path]) => path === "/api/public/launch-video/generate");
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]?.body)).attribution).toEqual({
        from: "filter-coffee", utm_source: "newsletter", utm_campaign: "launch",
      });
    });
    expect(window.localStorage.getItem("zft_first_touch")).toBeNull();
  });
});
