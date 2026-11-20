// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { useSetupHandoff } from "./useSetupHandoff";

vi.mock("../WorkspaceShell", () => ({
  useWorkspace: () => ({ tabs: [], activeTabId: null, openAgentTab: vi.fn() }),
}));
vi.mock("../layout/shared", () => ({ useOpenStatic: () => vi.fn() }));

afterEach(() => { window.sessionStorage.clear(); });

describe("setup handoff hydration", () => {
  it("matches the server and first client render before adopting the signup hint", async () => {
    window.sessionStorage.setItem("zavi.setup.expected", "1");
    const values: boolean[] = [];
    function Probe() {
      const expected = useSetupHandoff(null, true);
      values.push(expected);
      return <p>{String(expected)}</p>;
    }
    const server = renderToString(<Probe />);
    const container = document.createElement("div");
    container.innerHTML = server;
    const errors = vi.fn();
    values.length = 0;
    const root = hydrateRoot(container, <Probe />, { onRecoverableError: errors });
    await act(async () => {});
    expect(values[0]).toBe(false);
    expect(server).toBe("<p>false</p>");
    expect(container.textContent).toBe("true");
    expect(errors).not.toHaveBeenCalled();
    await act(() => root.unmount());
  });
});
