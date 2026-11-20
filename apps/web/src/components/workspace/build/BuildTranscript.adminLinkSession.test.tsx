// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var", className: "" } }));
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

type Reply = { status: number; body: unknown };
const net = vi.hoisted(() => ({
  pending: new Map<string, Array<(r: Reply) => void>>(),
  calls: [] as Array<{ path: string; method?: string; body?: string }>,
}));

vi.mock("@/lib/api", () => ({
  apiFetch: (path: string, opts: { method?: string; body?: string } = {}) => {
    net.calls.push({ path, method: opts.method, body: opts.body });
    const key = path.split("?")[0]!;
    return new Promise((resolve) => {
      const queue = net.pending.get(key) ?? [];
      queue.push((r: Reply) => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body }));
      net.pending.set(key, queue);
    });
  },
}));
vi.mock("@/lib/workspace/useBuildSessions", () => ({ notifyBuildSessionsChanged: () => {} }));

import { BuildTranscript } from "./BuildModePane";

const STATUS = "/api/workspace/autopilot/build-status";
const REFINES = "/api/workspace/autopilot/refines";
const LINK = "/api/workspace/autopilot/build-admin-link";

async function reply(path: string, r: Reply) {
  await waitFor(() => expect(net.pending.get(path)?.length ?? 0).toBeGreaterThan(0));
  const next = net.pending.get(path)!.shift()!;
  await act(async () => {
    next(r);
  });
}

async function mountSite(session: string, host: string) {
  render(<BuildTranscript sessionId={session} />);
  await reply(STATUS, {
    status: 200,
    body: {
      run: { id: session, objective: "Build product: X — y", status: "done", created_at: "2026-09-29T06:55:00.000Z", updated_at: "2026-09-29T07:10:00.000Z", stages: [] },
      target: { live_url: `https://${host}`, admin_url: `https://${host}/admin`, admin_setup_email: "owner@zavi.co" },
    },
  });
  await reply(REFINES, { status: 200, body: { refines: [] } });
}

afterEach(() => {
  cleanup();
  net.pending.clear();
  net.calls.length = 0;
});

describe("Email me a new login link sends the open build session", () => {
  it.each([
    ["d130919a-bec1-48bc-9dbf-fba65217f05a", "alpha.zaviagent.com"],
    ["e240919a-bec1-48bc-9dbf-fba65217f05b", "beta.zaviagent.com"],
  ])("session %s posts its own id", async (session, host) => {
    await mountSite(session, host);
    fireEvent.click(screen.getByRole("button", { name: "Email me a new login link" }));
    await reply(LINK, { status: 200, body: { ok: true, email: "owner@zavi.co" } });
    const post = net.calls.find((c) => c.path === LINK);
    expect(JSON.parse(post!.body!)).toEqual({ conductor_run_id: session });
  });
});
