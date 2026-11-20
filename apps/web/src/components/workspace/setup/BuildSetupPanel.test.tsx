// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { useEffect } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

const h = vi.hoisted(() => ({
  setup: null as null | { locked: boolean; buildOpen: boolean },
  opened: [] as string[],
  mounts: 0,
  tenant: "t-a" as string | null | undefined,
}));
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var" } }));
vi.mock("./SetupProvider", () => ({ useSetupOptional: () => h.setup }));
vi.mock("../brain/useActiveTenant", () => ({ useActiveTenant: () => h.tenant }));
vi.mock("../layout/shared", async (orig) => ({
  ...(await orig<typeof import("../layout/shared")>()),
  useOpenStatic: () => (kind: string) => h.opened.push(kind),
}));

import { BuildSetupFrame, buildPanelDismissedKey } from "./BuildSetupPanel";

function Pane() {
  useEffect(() => {
    h.mounts += 1;
  }, []);
  return <p>build preview</p>;
}
const frame = () => render(<BuildSetupFrame><Pane /></BuildSetupFrame>);
const panel = () => screen.queryByRole("complementary", { name: "Your growth setup is waiting" });

beforeEach(() => {
  h.setup = { locked: true, buildOpen: true };
  h.opened = [];
  h.mounts = 0;
  h.tenant = "t-a";
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe("B10: build view setup panel", () => {
  it("shows beside the running build, never instead of it", () => {
    frame();
    expect(panel()).not.toBeNull();
    expect(screen.getByText("build preview")).toBeTruthy();
  });
  it("Continue setup opens Growth Strategy", () => {
    frame();
    fireEvent.click(screen.getByRole("button", { name: /Continue setup/ }));
    expect(h.opened).toEqual(["autopilot"]);
  });
  it("Not now hides it for the session without remounting the build pane", () => {
    frame();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(panel()).toBeNull();
    expect(screen.getByText("build preview")).toBeTruthy();
    expect(h.mounts).toBe(1);
    expect(window.sessionStorage.getItem(buildPanelDismissedKey("t-a"))).toBe("1");
    cleanup();
    frame();
    expect(panel()).toBeNull();
  });
  it("a dismissal in one workspace does not hide the panel in another", () => {
    frame();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(panel()).toBeNull();
    cleanup();
    h.tenant = "t-b";
    frame();
    expect(panel()).not.toBeNull();
    cleanup();
    h.tenant = "t-a";
    frame();
    expect(panel()).toBeNull();
  });
  it("switching workspace in place brings the panel back for the other one", () => {
    const { rerender } = frame();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(panel()).toBeNull();
    h.tenant = "t-b";
    rerender(<BuildSetupFrame><Pane /></BuildSetupFrame>);
    expect(panel()).not.toBeNull();
    expect(h.mounts).toBe(1);
  });
  it("waits for the workspace to resolve before showing, so a dismissed panel never flashes", () => {
    window.sessionStorage.setItem(buildPanelDismissedKey("t-a"), "1");
    h.tenant = undefined;
    const { rerender } = frame();
    expect(panel()).toBeNull();
    h.tenant = "t-a";
    rerender(<BuildSetupFrame><Pane /></BuildSetupFrame>);
    expect(panel()).toBeNull();
    expect(screen.getByText("build preview")).toBeTruthy();
  });
  it("a blocked sessionStorage still lets the founder dismiss it", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    frame();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(panel()).toBeNull();
    get.mockRestore();
    set.mockRestore();
  });
  it.each([
    ["the key is off", { locked: true, buildOpen: false }],
    ["the setup is finished", { locked: false, buildOpen: true }],
    ["there is no setup context", null],
  ])("stays hidden when %s", (_label, setup) => {
    h.setup = setup;
    frame();
    expect(panel()).toBeNull();
    expect(screen.getByText("build preview")).toBeTruthy();
  });
  it("the panel appearing once the setup read lands does not remount the build pane", () => {
    h.setup = null;
    const { rerender } = frame();
    h.setup = { locked: true, buildOpen: true };
    rerender(<BuildSetupFrame><Pane /></BuildSetupFrame>);
    expect(panel()).not.toBeNull();
    expect(h.mounts).toBe(1);
  });
});
