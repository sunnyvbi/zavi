// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PosthogForm } from "../PosthogConnectForm";

const apiFetch = vi.fn();
const toastAdd = vi.fn();
const showConnectorError = vi.fn();

vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
vi.mock("@/components/ui/toast", () => ({
  toast: { add: (...args: unknown[]) => toastAdd(...args) },
}));
vi.mock("@/components/workspace/settings/connectorErrorDialog", () => ({
  showConnectorError: (...args: unknown[]) => showConnectorError(...args),
}));

const PROJECTS = [
  { id: "1", name: "Upcar_staging" },
  { id: "2", name: "Upcar_prod" },
];

function routes(projects: { id: string; name: string }[]) {
  apiFetch.mockImplementation(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url.endsWith("/projects") ? { projects } : { ok: true }),
  }));
}

function submitKey(container: HTMLElement, key = "phx_test") {
  fireEvent.change(screen.getByPlaceholderText("phx_…"), { target: { value: key } });
  fireEvent.submit(container.querySelector("form")!);
}

beforeEach(() => {
  apiFetch.mockReset();
  toastAdd.mockReset();
  showConnectorError.mockReset();
});
afterEach(cleanup);

describe("PosthogForm", () => {
  it("does not pre-pick a project when the key reaches several", async () => {
    routes(PROJECTS);
    const { container } = render(<PosthogForm onClose={() => {}} />);
    submitKey(container);

    const select = (await screen.findByText("Choose a project…")).closest("select")!;
    expect(select.value).toBe("");
    const button = screen.getByRole("button", { name: "Connect project" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(select, { target: { value: "2" } });
    expect(button.disabled).toBe(false);
  });

  it("connects the picked project, refreshes the tiles, closes and confirms", async () => {
    routes(PROJECTS);
    const onConnected = vi.fn();
    const onClose = vi.fn();
    const { container } = render(<PosthogForm onClose={onClose} onConnected={onConnected} />);
    submitKey(container);

    const select = (await screen.findByText("Choose a project…")).closest("select")!;
    fireEvent.change(select, { target: { value: "2" } });
    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onConnected).toHaveBeenCalled();
    const connectCall = apiFetch.mock.calls.find(([u]) => String(u).endsWith("/connect"))!;
    expect(JSON.parse(connectCall[1].body).project_id).toBe("2");
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Connected to PostHog. Reading from Upcar_prod." }),
    );
    expect(container.textContent).not.toContain("Connected to PostHog");
  });

  it("drops the project list when the key changes", async () => {
    routes(PROJECTS);
    const { container } = render(<PosthogForm onClose={() => {}} />);
    submitKey(container);
    await screen.findByText("Choose a project…");

    fireEvent.change(screen.getByPlaceholderText("phx_…"), { target: { value: "phx_other" } });
    expect(screen.queryByText("Choose a project…")).toBeNull();
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("says so when the key reaches no project", async () => {
    routes([]);
    const onConnected = vi.fn();
    const { container } = render(<PosthogForm onClose={() => {}} onConnected={onConnected} />);
    submitKey(container);

    await waitFor(() => expect(showConnectorError).toHaveBeenCalled());
    expect(showConnectorError.mock.calls[0][0].message).toBe(
      "That key can't reach any PostHog project.",
    );
    expect(onConnected).not.toHaveBeenCalled();
  });
});
