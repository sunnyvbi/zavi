// @vitest-environment jsdom
import { render, cleanup, act } from "@testing-library/react";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
const h = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuth: vi.fn(),
  prepare: vi.fn(),
  deliver: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({
  createBrowserSupabase: () => ({
    auth: { getSession: h.getSession, onAuthStateChange: h.onAuth },
  }),
}));
vi.mock("@/lib/signup-location", () => ({
  prepareSignupLocation: h.prepare,
  deliverSignupLocation: h.deliver,
}));
import { SignupLocationCapture } from "./SignupLocationCapture";
const session = () => ({
  user: {
    id: "u1",
    email: "user@example.com",
    created_at: new Date().toISOString(),
  },
  access_token: "synthetic-token",
});
beforeEach(() => {
  vi.useFakeTimers();
  h.getSession.mockReset();
  h.onAuth.mockReset();
  h.prepare.mockReset();
  h.deliver.mockReset();
  h.onAuth.mockReturnValue({
    data: { subscription: { unsubscribe: h.unsubscribe } },
  });
  h.prepare.mockResolvedValue({
    payload: "signed payload",
    signature: "test-signature",
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("captures a new OAuth session once even if the SDK repeats the event", async () => {
  const s = session();
  h.getSession.mockResolvedValue({ data: { session: s } });
  render(<SignupLocationCapture />);
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  h.onAuth.mock.calls[0][0]("SIGNED_IN", s);
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  expect(h.prepare).toHaveBeenCalledTimes(1);
  expect(h.deliver).toHaveBeenCalledWith(
    "u1",
    { payload: "signed payload", signature: "test-signature" },
    "synthetic-token",
  );
});
it("never captures the location of an existing account", async () => {
  const s = session();
  s.user.created_at = "2020-01-01T00:00:00Z";
  h.getSession.mockResolvedValue({ data: { session: s } });
  render(<SignupLocationCapture />);
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  expect(h.prepare).not.toHaveBeenCalled();
});
it("does not crash authentication when the session read fails", async () => {
  h.getSession.mockRejectedValue(Error("network"));
  render(<SignupLocationCapture />);
  await act(async () => {
    await vi.runAllTimersAsync();
  });
  expect(h.prepare).not.toHaveBeenCalled();
});
