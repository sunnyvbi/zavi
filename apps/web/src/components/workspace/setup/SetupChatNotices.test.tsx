// @vitest-environment jsdom
vi.mock("next/navigation", async () => import("./setupNavigation.testSupport"));
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SetupProvider, useSetupOptional } from "./SetupProvider";
vi.mock("./PastWorkStep", () => ({ PastWorkStep: ({ onComplete, onSkip, onBack }: { onBack?: () => void; onComplete: () => Promise<unknown>; onSkip: () => Promise<unknown> }) => <div>past work{onBack && <button type="button" onClick={onBack}>Back to your build</button>}<button type="button" onClick={() => void onComplete()}>Add to Zavi</button><button type="button" onClick={() => void onSkip()}>Skip</button></div> }));
import { FullscreenSetup } from "./FullscreenSetup";
import { SetupChatNotices } from "./SetupChatNotices";

const h = vi.hoisted(() => ({ done: false, opened: vi.fn() }));
vi.mock("@/fonts", () => ({ inter: { variable: "inter" } }));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("../WorkspaceShell", () => {
  const workspace = { tabs: [{ id: "growth", kind: "autopilot" }], activeTabId: "growth", role: "owner", openAgentTab: h.opened };
  return { useWorkspace: () => workspace, useWorkspaceOptional: () => workspace };
});
vi.mock("../layout/shared", () => ({ useOpenStatic: () => () => {} }));
vi.mock("./SetupPolishStep", () => ({
  SetupPolishStep: ({ onFinish }: { onFinish: (problems: string[]) => Promise<void> }) =>
    <button type="button" onClick={() => void onFinish(["company name"])}>Finish with a failed save</button>,
}));
vi.mock("./ImportFlow", () => ({ ImportFlow: () => null, uploadAll: vi.fn() }));
vi.mock("./SetupConnectorsStep", () => ({ SetupConnectorsStep: () => null }));
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string) => {
    if (path === "/api/workspace/setup/progress") h.done = true;
    if (path.startsWith("/api/workspace/setup")) return new Response(JSON.stringify({
      enabled: true, docs: { status: "done", files: 1, facts: 0 }, connectors: { status: "done" },
      done: h.done, home_seen: false, has_plan: false,
      draft: { status: "running", run_id: "run", attempts: 1, can_retry: false, free_retry: false },
    }));
    return new Response(JSON.stringify({ facts: [], connectors: [], files: [] }));
  }),
}));

afterEach(() => { cleanup(); h.done = false; h.opened.mockClear(); window.sessionStorage.clear(); });
const warning = "Some details didn't save (company name). You can change them in Company Details.";
function FinishFeedback() {
  const setup = useSetupOptional();
  return <button type="button" onClick={() => { setup?.setFinishNote(warning); void setup?.mark({ step: "done" }); }}>Finish with a failed save</button>;
}

describe("setup feedback in chat", () => {
  it.each([false, true])("keeps failed-save feedback visible after opening chat (embedded=%s)", async (embedded) => {
    render(<SetupProvider><FullscreenSetup /><FinishFeedback /><SetupChatNotices embedded={embedded} /></SetupProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Finish with a failed save" }));
    expect(await screen.findByText(warning)).toBeTruthy();
    expect(h.opened).toHaveBeenCalledWith("operator", { newThread: true, push: true });
    expect(screen.queryByRole("dialog", { name: "Set up Zavi" })).toBeNull();
  });
});
