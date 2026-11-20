
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, render } from "@testing-library/react";
import {
  __resetWorkspaceThreadsForTest,
  notifyThreadsChanged,
  useWorkspaceThreads,
} from "./useAgentThreads";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

function jsonOk(threads: unknown[]) {
  return Promise.resolve({ ok: true, json: async () => ({ threads }) });
}

function row(id: string, agent_slug: string, title: string) {
  return {
    id,
    agent_slug,
    title,
    last_message_at: "2026-09-11T10:00:00Z",
    created_at: "2026-09-11T10:00:00Z",
    last_message: null,
    run_status: null,
    pending: false,
  };
}

function Probe() {
  const { threads } = useWorkspaceThreads();
  return (
    <ul>
      {threads.map((t) => (
        <li key={t.id}>{`${t.agent_slug}:${t.title}`}</li>
      ))}
    </ul>
  );
}

function StatusProbe() {
  const { threads } = useWorkspaceThreads();
  return <p>{threads[0]?.presentation_status ?? "missing"}</p>;
}

beforeEach(() => {
  apiFetch.mockReset();
  __resetWorkspaceThreadsForTest();
});
afterEach(cleanup);

it("refetches on a threads-changed event with no key or prop change", async () => {
  apiFetch.mockReturnValueOnce(jsonOk([row("t1", "operator", "First chat")]));
  const view = render(<Probe />);
  await act(async () => {});
  expect(apiFetch).toHaveBeenCalledTimes(1);
  expect(apiFetch).toHaveBeenCalledWith("/api/workspace/threads");
  expect(view.getByText("operator:First chat")).toBeTruthy();

  apiFetch.mockReturnValueOnce(
    jsonOk([
      row("t2", "growth-lead", "Second chat"),
      row("t1", "operator", "First chat"),
    ]),
  );
  await act(async () => {
    notifyThreadsChanged();
  });
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(view.getByText("growth-lead:Second chat")).toBeTruthy();
});

it("keeps the last good list when a refetch fails", async () => {
  apiFetch.mockReturnValueOnce(jsonOk([row("t1", "operator", "First chat")]));
  const view = render(<Probe />);
  await act(async () => {});

  apiFetch.mockReturnValueOnce(Promise.reject(new Error("offline")));
  await act(async () => {
    notifyThreadsChanged();
  });
  expect(view.getByText("operator:First chat")).toBeTruthy();

  apiFetch.mockReturnValueOnce(
    Promise.resolve({ ok: false, json: async () => ({}) }),
  );
  await act(async () => {
    notifyThreadsChanged();
  });
  expect(view.getByText("operator:First chat")).toBeTruthy();
});

it("shares one list across mounts and paints it immediately on remount", async () => {
  apiFetch.mockReturnValueOnce(jsonOk([row("t1", "operator", "First chat")]));
  const first = render(<Probe />);
  await act(async () => {});
  expect(apiFetch).toHaveBeenCalledTimes(1);
  first.unmount();

  const second = render(<Probe />);
  expect(second.getByText("operator:First chat")).toBeTruthy();
  await act(async () => {});
  expect(apiFetch).toHaveBeenCalledTimes(1);
});

it("queues one follow-up when a change lands mid-request", async () => {
  let resolveFirst!: (v: unknown) => void;
  apiFetch.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
  const view = render(<Probe />);
  await act(async () => {});

  apiFetch.mockReturnValueOnce(jsonOk([row("t2", "operator", "Newer chat")]));
  await act(async () => {
    notifyThreadsChanged();
    notifyThreadsChanged();
  });
  expect(apiFetch).toHaveBeenCalledTimes(1);

  await act(async () => {
    resolveFirst({
      ok: true,
      json: async () => ({ threads: [row("t1", "operator", "First chat")] }),
    });
  });
  expect(apiFetch).toHaveBeenCalledTimes(2);
  expect(view.getByText("operator:Newer chat")).toBeTruthy();
});

it("polls a running Recent row through its terminal status", async () => {
  vi.useFakeTimers();
  try {
    apiFetch
      .mockReturnValueOnce(
        jsonOk([
          {
            ...row("t1", "operator", "Build my app"),
            presentation_status: "running",
          },
        ]),
      )
      .mockReturnValueOnce(
        jsonOk([
          {
            ...row("t1", "operator", "Build my app"),
            run_status: "success",
            presentation_status: "answered",
          },
        ]),
      );
    const view = render(<StatusProbe />);
    await act(async () => {});
    expect(view.getByText("running")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(view.getByText("answered")).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
