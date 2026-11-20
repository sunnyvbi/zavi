// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const resp: { ok: boolean; body: unknown } = { ok: true, body: {} };
vi.mock("@/lib/api", () => ({
  apiFetch: () => Promise.resolve({ ok: resp.ok, json: () => Promise.resolve(resp.body) }),
}));

import { TeamsTile } from "./TeamsTile";
import { ConnectorLockup, ConnectorTile, TileButton } from "./ConnectorTile";
import { connectionState } from "./connectorHealth";

beforeEach(() => {
  resp.ok = true;
  resp.body = { configured: true, connected: false };
});
afterEach(cleanup);

function referenceTile(readOnly: boolean) {
  const { container } = render(
    <div data-testid="reference">
      <ConnectorTile
        id="connector-discord"
        logo={<ConnectorLockup slug="discord" label="Discord" />}
        name="Discord"
        description="Message your agents from Discord."
        status={connectionState(false, undefined)}
        action={
          readOnly ? null : (
            <TileButton onClick={() => undefined} ariaExpanded={false}>
              <span aria-hidden>Connect</span>
              <span className="sr-only">Connect Discord</span>
            </TileButton>
          )
        }
      />
    </div>,
  );
  return container.querySelector("#connector-discord") as HTMLElement;
}

function shape(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll("*")).map((n) =>
    n.tagName === "IMG" ? "IMG" : `${n.tagName}.${n.getAttribute("class") ?? ""}`,
  );
}

describe("TeamsTile, not connected", () => {
  for (const readOnly of [false, true]) {
    it(`is the same card as Discord, element for element${readOnly ? " (read-only)" : ""}`, async () => {
      const ref = referenceTile(readOnly);
      render(<TeamsTile readOnly={readOnly} />);
      const teams = document.getElementById("connector-teams") as HTMLElement;
      expect(teams.tagName).toBe(ref.tagName);
      expect(teams.className).toBe(ref.className);
      expect(teams.getAttribute("title")).toBeNull();
      expect(shape(teams)).toEqual(shape(ref));
      expect(teams.textContent).toContain("Message your agents from Microsoft Teams.");
      expect(teams.textContent).toContain("Not connected");
      expect(teams.querySelector('span[aria-hidden="true"].rounded-full')).not.toBeNull();
      await screen.findByText("Not connected", { selector: `#connector-teams span` });
    });
  }

  it("Connect is the shared tile button and opens the flow that carries the upload instruction", async () => {
    render(<TeamsTile />);
    const connect = screen.getByRole("button", { name: "Connect Microsoft Teams" });
    const ref = referenceTile(false);
    const refButton = ref.querySelector("button") as HTMLButtonElement;
    expect(connect.className).toBe(refButton.className);
    expect(connect.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(connect);
    expect(connect.getAttribute("aria-expanded")).toBe("true");
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Add the Zavi app in Teams, then enter the one-time code it sends you.");
  });

  it("gives a member no Connect and no way to open the flow", () => {
    render(<TeamsTile readOnly />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
