// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<(r: Reply) => void>>(),
  calls: [] as Array<{ path: string; method?: string }>,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts: { method?: string } = {}) => {
    net.calls.push({ path, method: opts.method });
    const key = path.split("?")[0]!;
    return new Promise((resolve) => {
      const queue = net.pending.get(key) ?? [];
      queue.push((r: Reply) =>
        resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          json: async () => r.body,
        }),
      );
      net.pending.set(key, queue);
    });
  },
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({
  notifyBuildSessionsChanged: () => {},
}));

import { BuildTranscript } from "./BuildModePane";

const SESSION = "d130919a-bec1-48bc-9dbf-fba65217f05a";
const STATUS = "/api/workspace/autopilot/build-status";
const REFINES = "/api/workspace/autopilot/refines";

const run = (status: string) => ({
  id: SESSION,
  objective: "Build product: Bath & Brush — dog grooming bookings",
  status,
  created_at: "2026-09-29T06:55:00.000Z",
  updated_at: "2026-09-29T07:10:00.000Z",
  stages: [],
});

async function reply(path: string, r: Reply) {
  await waitFor(() =>
    expect(net.pending.get(path)?.length ?? 0).toBeGreaterThan(0),
  );
  const next = net.pending.get(path)!.shift()!;
  await act(async () => {
    next(r);
  });
}

async function mount(status: string, target: Record<string, unknown>) {
  render(<BuildTranscript sessionId={SESSION} />);
  await reply(STATUS, { status: 200, body: { run: run(status), target } });
  await reply(REFINES, { status: 200, body: { refines: [] } });
}

afterEach(() => {
  cleanup();
  net.pending.clear();
  net.calls.length = 0;
});

describe("Build ready card admin login (DEL-1323 B3, Q9)", () => {
  it("says where the owner logs in, as a real link to the site's /admin", async () => {
    await mount("done", {
      live_url: "https://bath-brush.zaviagent.com",
      admin_url: "https://bath-brush.zaviagent.com/admin",
    });
    screen.getByRole("button", { name: /Your app is ready/ });
    const line = screen.getByTestId("build-admin-login");
    expect(line.textContent).toBe(
      "Log in to your admin at https://bath-brush.zaviagent.com/admin?from=zavi. Your Zavi password does not work there. Sign in with an email link first.",
    );
    const link = screen.getByRole("link", {
      name: "https://bath-brush.zaviagent.com/admin?from=zavi",
    });
    expect(link.getAttribute("href")).toBe(
      "https://bath-brush.zaviagent.com/admin?from=zavi",
    );
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("names the owner's email and the one-click login link, not a sign-up step", async () => {
    await mount("done", {
      live_url: "https://bath-brush.zaviagent.com",
      admin_url: "https://bath-brush.zaviagent.com/admin",
      admin_setup_email: "owner@zavi.co",
    });
    screen.getByRole("button", { name: /Your app is ready/ });
    expect(screen.getAllByTestId("build-admin-login")).toHaveLength(1);
    expect(screen.getByTestId("build-admin-login").textContent).toBe(
      "Log in to your admin at https://bath-brush.zaviagent.com/admin?from=zavi. We emailed a one-click login link to owner@zavi.co. Your Zavi password does not work there. Sign in with an email link first.",
    );
  });

  describe("Email me a new login link", () => {
    const LINK = "/api/workspace/autopilot/build-admin-link";
    const mountOwner = () =>
      mount("done", {
        live_url: "https://bath-brush.zaviagent.com",
        admin_url: "https://bath-brush.zaviagent.com/admin",
        admin_setup_email: "owner@zavi.co",
      });
    const posts = () => net.calls.filter((c) => c.path === LINK);

    it("one click posts once, blocks a double click while sending, then says where the link went", async () => {
      await mountOwner();
      const button = screen.getByRole("button", { name: "Email me a new login link" });
      fireEvent.click(button);
      const sending = screen.getByRole("button", { name: "Sending..." });
      expect((sending as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(sending);
      await reply(LINK, { status: 200, body: { ok: true, email: "owner@zavi.co" } });
      expect(posts()).toEqual([{ path: LINK, method: "POST" }]);
      expect(screen.getByRole("status").textContent).toBe("Sent. Check owner@zavi.co for a new one-click login link.");
      expect((screen.getByRole("button", { name: "Email me a new login link" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("rate limited: says a link just went out, not that it failed", async () => {
      await mountOwner();
      fireEvent.click(screen.getByRole("button", { name: "Email me a new login link" }));
      await reply(LINK, { status: 429, body: { error: { code: "too_soon" } } });
      expect(screen.getByRole("status").textContent).toBe("A link was sent in the last few minutes. Check your inbox.");
      expect(screen.queryByText(/^Sent\./)).toBeNull();
    });

    it("a server failure says it failed, never 'Sent'", async () => {
      await mountOwner();
      fireEvent.click(screen.getByRole("button", { name: "Email me a new login link" }));
      await reply(LINK, { status: 502, body: { error: { code: "send_failed" } } });
      expect(screen.getByRole("status").textContent).toBe("Couldn't send a new link. Try again in a few minutes.");
      expect(screen.queryByText(/^Sent\./)).toBeNull();
    });

    it("no owner email on the card: no resend button", async () => {
      await mount("done", {
        live_url: "https://bath-brush.zaviagent.com",
        admin_url: "https://bath-brush.zaviagent.com/admin",
      });
      screen.getByTestId("build-admin-login");
      expect(screen.queryByRole("button", { name: "Email me a new login link" })).toBeNull();
    });
  });

  it("an admin_url that already has a from value still links with from=zavi, once", async () => {
    await mount("done", {
      live_url: "https://bath-brush.zaviagent.com",
      admin_url: "https://bath-brush.zaviagent.com/admin?from=other",
    });
    const link = screen.getByRole("link", {
      name: "https://bath-brush.zaviagent.com/admin?from=zavi",
    });
    expect(link.getAttribute("href")).toBe(
      "https://bath-brush.zaviagent.com/admin?from=zavi",
    );
  });

  it("an admin_setup_email with no admin_url never shows the emailed-link line", async () => {
    await mount("done", {
      live_url: "https://bath-brush.zaviagent.com",
      admin_setup_email: "owner@zavi.co",
    });
    screen.getByRole("button", { name: /Your app is ready/ });
    expect(screen.queryByText(/one-click login link/)).toBeNull();
  });

  it("no admin_url from the server: no admin line", async () => {
    await mount("done", { live_url: "https://shop.test" });
    screen.getByRole("button", { name: /Your app is ready/ });
    expect(screen.queryByTestId("build-admin-login")).toBeNull();
    expect(screen.queryByText(/Log in to your admin/)).toBeNull();
  });

  it("an admin_url with no live site is never shown", async () => {
    await mount("done", {
      live_url: null,
      admin_url: "https://gone.zaviagent.com/admin",
    });
    expect(screen.queryByTestId("build-admin-login")).toBeNull();
  });

  it("a non-http admin_url is never rendered as a link", async () => {
    await mount("done", {
      live_url: "https://shop.test",
      admin_url: "javascript:alert(1)",
    });
    screen.getByRole("button", { name: /Your app is ready/ });
    expect(screen.queryByTestId("build-admin-login")).toBeNull();
    expect(document.querySelector('a[href^="javascript"]')).toBeNull();
  });
});
