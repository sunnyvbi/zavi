// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));
vi.mock("@/app/connectors/composioConnect", () => ({ startComposioConnect: vi.fn() }));

import { ChannelMetricsRow } from "./ChannelMetricsRow";
import { PinterestReadinessLine } from "./PinterestReadinessLine";
import { __resetAgentDashCache } from "../agent/dashboard-ui";
import { platformFor } from "./platforms";

const reply = (body: unknown) => ({ ok: true, json: async () => body });

function row(slug: string, connected: boolean) {
  return render(
    <ChannelMetricsRow
      slug={slug}
      metrics={[]}
      platform={platformFor(slug)}
      loading={false}
      connected={connected}
      hasConnectors
      connectors={["composio.pinterest"]}
    />,
  );
}

beforeEach(() => { apiFetch.mockReset(); __resetAgentDashCache(); });
afterEach(cleanup);

describe("Pinterest overview readiness line", () => {
  it("shows nothing once the account has a board to publish to", async () => {
    apiFetch.mockResolvedValue(reply({ connected: true, readiness: { ok: true, checks: { board: { status: "pass" } }, board_count: 4 } }));
    const { container } = render(<PinterestReadinessLine />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith("/api/channels/pinterest_organic/readiness"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(container.querySelector('[data-testid="pinterest-readiness"]')).toBeNull();
    expect(container.textContent).not.toMatch(/Ready to publish/);
  });

  it("turns the no-boards block into one calm line with the Pinterest link, not an error", async () => {
    apiFetch.mockResolvedValue(
      reply({
        connected: true,
        readiness: {
          ok: false,
          reason_code: "pinterest_no_boards",
          reason: "Your Pinterest account has no boards yet, and every pin has to go on a board. Create a board on Pinterest, then try again.",
          checks: { board: { status: "fail", reason_code: "pinterest_no_boards" } },
          board_count: 0,
        },
      }),
    );
    const { container } = render(<PinterestReadinessLine />);
    await waitFor(() => expect(container.querySelector('[data-testid="pinterest-readiness"]')).not.toBeNull());
    const card = container.querySelector('[data-testid="pinterest-readiness"]')!;
    expect(card.className).not.toMatch(/text-coral/);
    expect(card.textContent).toBe("Connected. Add a board so Zavi has somewhere to pin.Create a boardCreate on PinterestCheck again");
    expect(card.textContent).not.toMatch(/try again/i);
    const open = card.querySelector<HTMLAnchorElement>('[data-testid="pinterest-readiness-open"]')!;
    expect(open.href).toBe("https://www.pinterest.com/");
    expect(open.target).toBe("_blank");
    expect(open.rel).toContain("noopener");
  });

  it("Check again asks the server once more and the line disappears once a board exists", async () => {
    apiFetch
      .mockResolvedValueOnce(reply({ connected: true, readiness: { ok: false, reason_code: "pinterest_no_boards" } }))
      .mockResolvedValueOnce(reply({ connected: true, readiness: { ok: true, board_count: 1 } }));
    const { container } = render(<PinterestReadinessLine />);
    const recheck = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('[data-testid="pinterest-readiness-recheck"]');
      expect(b).not.toBeNull();
      return b!;
    });
    fireEvent.click(recheck);
    await waitFor(() => expect(container.querySelector('[data-testid="pinterest-readiness"]')).toBeNull());
    expect(apiFetch.mock.calls.filter((c) => c[0] === "/api/channels/pinterest_organic/readiness")).toHaveLength(2);
  });

  it("locks Check again while the answer is out, keeps the card on a failed recheck, and survives unmount mid-flight", async () => {
    let release!: (v: unknown) => void;
    apiFetch
      .mockResolvedValueOnce(reply({ connected: true, readiness: { ok: false, reason_code: "pinterest_no_boards" } }))
      .mockRejectedValueOnce(new Error("network"))
      .mockReturnValueOnce(new Promise((r) => (release = r)));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container, unmount } = render(<PinterestReadinessLine />);
    const recheck = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('[data-testid="pinterest-readiness-recheck"]');
      expect(b).not.toBeNull();
      return b!;
    });
    fireEvent.click(recheck);
    await waitFor(() => expect(recheck.disabled).toBe(false));
    expect(container.querySelector('[data-testid="pinterest-readiness"]')?.textContent).toContain("Add a board so Zavi");
    fireEvent.click(recheck);
    await waitFor(() => expect(recheck.textContent).toBe("Checking"));
    expect(recheck.disabled).toBe(true);
    fireEvent.click(recheck);
    expect(apiFetch).toHaveBeenCalledTimes(3);
    unmount();
    await act(async () => {
      release(reply({ connected: true, readiness: { ok: true } }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("Create a board makes a public board in Zavi, then checks again and the line goes", async () => {
    const NO_BOARDS = reply({ connected: true, readiness: { ok: false, reason_code: "pinterest_no_boards" } });
    let made = false;
    apiFetch.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url === "/api/channels/pinterest_organic/boards" && init?.method === "POST") {
        made = true;
        return reply({ board: { id: "9001", label: "Autumn" } });
      }
      return made ? reply({ connected: true, readiness: { ok: true, board_count: 1 } }) : NO_BOARDS;
    });
    const { container, getByLabelText, getByText } = render(<PinterestReadinessLine />);
    const open = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('[data-testid="pinterest-new-board"]');
      expect(b).not.toBeNull();
      return b!;
    });
    fireEvent.click(open);
    fireEvent.change(getByLabelText("Board name"), { target: { value: "  Autumn  " } });
    fireEvent.change(getByLabelText("Board description (optional)"), { target: { value: "Table ideas" } });
    const make = getByText("Make board") as HTMLButtonElement;
    fireEvent.click(make);
    fireEvent.click(make);
    await waitFor(() => expect(container.querySelector('[data-testid="pinterest-readiness"]')).toBeNull());
    const posts = apiFetch.mock.calls.filter((c) => c[0] === "/api/channels/pinterest_organic/boards");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({ name: "Autumn", description: "Table ideas" });
    expect(apiFetch.mock.calls.filter((c) => c[0] === "/api/channels/pinterest_organic/readiness")).toHaveLength(2);
  });

  it("a board Pinterest will not make says why in plain words and keeps the line", async () => {
    apiFetch.mockImplementation(async (url: string, init?: { method?: string }) =>
      url === "/api/channels/pinterest_organic/boards" && init?.method === "POST"
        ? { ok: false, status: 409, json: async () => ({ error: { code: "name_taken", message: "You already have a board with that name." } }) }
        : reply({ connected: true, readiness: { ok: false, reason_code: "pinterest_no_boards" } }),
    );
    const { container, getByLabelText, getByText, findByRole } = render(<PinterestReadinessLine />);
    const open = await waitFor(() => {
      const b = container.querySelector<HTMLButtonElement>('[data-testid="pinterest-new-board"]');
      expect(b).not.toBeNull();
      return b!;
    });
    fireEvent.click(open);
    fireEvent.change(getByLabelText("Board name"), { target: { value: "Ideas" } });
    fireEvent.click(getByText("Make board"));
    expect((await findByRole("alert")).textContent).toBe("You already have a board with that name.");
    expect(container.querySelector('[data-testid="pinterest-readiness"]')).not.toBeNull();
    expect(apiFetch.mock.calls.filter((c) => c[0] === "/api/channels/pinterest_organic/readiness")).toHaveLength(1);
  });

  it("a lookup failure says Zavi could not check, offers Check again, and sends nobody to Pinterest", async () => {
    apiFetch.mockResolvedValue(
      reply({ connected: true, readiness: { ok: false, checks: { board: { status: "unverified", reason_code: "pinterest_lookup_failed" } } } }),
    );
    const { container } = render(<PinterestReadinessLine />);
    await waitFor(() => expect(container.querySelector('[data-testid="pinterest-readiness"]')).not.toBeNull());
    const card = container.querySelector('[data-testid="pinterest-readiness"]')!;
    expect(card.textContent).toBe("Connected. Zavi could not check your boards just now.Check again");
    expect(card.querySelector('[data-testid="pinterest-readiness-open"]')).toBeNull();
    expect(card.querySelector('[data-testid="pinterest-readiness-recheck"]')).not.toBeNull();
  });

  it("an unknown block still shows the server reason inside the card", async () => {
    apiFetch.mockResolvedValue(reply({ connected: true, readiness: { ok: false, reason: "Something new Pinterest refused." } }));
    const { container } = render(<PinterestReadinessLine />);
    await waitFor(() =>
      expect(container.querySelector('[data-testid="pinterest-readiness"]')?.textContent).toContain("Something new Pinterest refused."),
    );
  });

  it("draws nothing and asks nothing while Pinterest is not connected, or on another channel", async () => {
    apiFetch.mockResolvedValue(reply({ connected: true, readiness: { ok: true } }));
    const a = row("pinterest_organic", false);
    const b = row("instagram_organic", true);
    await new Promise((r) => setTimeout(r, 20));
    expect(apiFetch.mock.calls.filter((c) => String(c[0]).includes("pinterest_organic/readiness"))).toHaveLength(0);
    expect(a.container.querySelector('[data-testid="pinterest-readiness"]')).toBeNull();
    expect(b.container.querySelector('[data-testid="pinterest-readiness"]')).toBeNull();
  });

  it("never claims Connected when the server says the account is not linked", async () => {
    apiFetch.mockResolvedValue(reply({ connected: false, readiness: { ok: false, reason: "Pinterest is not connected." } }));
    const { container } = render(<PinterestReadinessLine />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('[data-testid="pinterest-readiness"]')).toBeNull();
  });
});
