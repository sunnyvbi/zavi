// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<(r: Reply) => void>>(),
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string) => {
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
});

describe("Build ready card for a suspended site (DEL-1323 B4)", () => {
  it("says the site is offline and never links the dead address", async () => {
    await mount("done", { live_url: null, admin_url: null, site_offline: true });
    screen.getByRole("button", { name: /Your app is ready/ });
    expect(screen.getByTestId("build-site-offline").textContent).toBe(
      "Your site is offline. Its hosting is suspended, so visitors see an error page.",
    );
    expect(screen.queryByTestId("build-admin-login")).toBeNull();
    expect(document.querySelector('a[href*="onrender.com"]')).toBeNull();
  });

  it("a serving site has no offline line", async () => {
    await mount("done", { live_url: "https://bath-brush.zaviagent.com" });
    screen.getByRole("button", { name: /Your app is ready/ });
    expect(screen.queryByTestId("build-site-offline")).toBeNull();
  });
});
