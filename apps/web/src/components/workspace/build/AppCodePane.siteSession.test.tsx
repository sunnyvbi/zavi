// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string) => {
    calls.push(path);
    if (path.startsWith("/api/workspace/app-code/tree")) {
      const session = new URL(`http://x${path}`).searchParams.get("build_session_id");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          entries: [{ path: `${session ?? "workspace"}.md`, type: "file", sha: `sha-${session ?? "workspace"}` }],
          truncated: false,
          branch: "main",
          name: session ?? "workspace",
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ kind: "text", content: "hello" }) };
  },
}));
vi.mock("../layout/shared", () => ({
  cx: (...parts: unknown[]) => parts.filter((p) => typeof p === "string" && p).join(" "),
  FOCUS_RING: "",
}));
vi.mock("@/lib/workspace/codeHighlight", () => ({ highlightCode: async () => null }));

import { AppCodePane, codeSessionQuery } from "./AppCodePane";
import { clearAppCodeCache } from "@/lib/workspace/appCodeCache";

const RUN_A = "aaaaaaaa-1111-4000-8000-00000000000a";
const RUN_B = "bbbbbbbb-1111-4000-8000-00000000000b";

afterEach(() => {
  cleanup();
  calls.length = 0;
  clearAppCodeCache();
});

describe("AppCodePane names the Build session in view", () => {
  it("builds the session query (none without a session)", () => {
    expect(codeSessionQuery(RUN_A)).toBe(`build_session_id=${RUN_A}`);
    expect(codeSessionQuery(null)).toBe("app=workspace");
  });

  it("site A's and site B's panes read their own session's tree and files", async () => {
    render(<AppCodePane scope={`site:${RUN_A}`} sessionId={RUN_A} />);
    fireEvent.click(await screen.findByText(`${RUN_A}.md`));
    await waitFor(() => expect(calls.some((c) => c.startsWith("/api/workspace/app-code/file"))).toBe(true));
    cleanup();
    render(<AppCodePane scope={`site:${RUN_B}`} sessionId={RUN_B} />);
    await screen.findByText(`${RUN_B}.md`);

    expect(calls).toContain(`/api/workspace/app-code/tree?build_session_id=${RUN_A}`);
    expect(calls).toContain(`/api/workspace/app-code/file?path=${encodeURIComponent(`${RUN_A}.md`)}&build_session_id=${RUN_A}`);
    expect(calls).toContain(`/api/workspace/app-code/tree?build_session_id=${RUN_B}`);
    expect(calls.filter((c) => c.includes(RUN_A) && c.includes(RUN_B))).toEqual([]);
  });

  it("without a session the pane reads the workspace app, as before", async () => {
    render(<AppCodePane scope="old.test" />);
    await screen.findByText("workspace.md");
    expect(calls[0]).toBe("/api/workspace/app-code/tree?app=workspace");
  });
});
