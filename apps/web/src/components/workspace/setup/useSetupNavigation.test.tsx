// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("next/navigation", async () => await import("./setupNavigation.testSupport"));

import { setSetupLocation } from "./setupNavigation.testSupport";
import { useSetupNavigation } from "./useSetupNavigation";

const CONNECT = "/workspace?tab=autopilot&setupStep=connect-apps";

describe("useSetupNavigation connect return", () => {
  beforeEach(() => setSetupLocation("/workspace"));

  it("reports a failed catalog sign-in", () => {
    setSetupLocation(`${CONNECT}&composio_error=denied`);
    expect(renderHook(() => useSetupNavigation()).result.current.returnError).toBe("denied");
  });

  it("reports a cancelled native sign-in", () => {
    setSetupLocation(`${CONNECT}&connect_error=access_denied&provider=linkedin_ads`);
    expect(renderHook(() => useSetupNavigation()).result.current.returnError).toBe("access_denied");
  });

  it("clears the native sign-in error and provider when a new connect starts", () => {
    setSetupLocation(`${CONNECT}&connect_error=access_denied&provider=linkedin_ads`);
    const { result } = renderHook(() => useSetupNavigation());
    act(() => result.current.beginConnect());
    const params = new URLSearchParams(window.location.search);
    expect(params.has("connect_error")).toBe(false);
    expect(params.has("provider")).toBe(false);
    expect(params.get("setupStep")).toBe("connect-apps");
    expect(result.current.returnError).toBeNull();
  });
});
