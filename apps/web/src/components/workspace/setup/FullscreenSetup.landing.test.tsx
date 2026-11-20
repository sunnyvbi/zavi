// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { useState } from "react";
import { setSetupLocation } from "./setupNavigation.testSupport";

const h = vi.hoisted(() => ({ setState: null as null | ((s: unknown) => void), state: null as unknown, opened: [] as string[], ws: null as unknown }));
vi.mock("next/navigation", async () => import("./setupNavigation.testSupport"));
const running = { enabled: true, docs: { status: "done", files: 0, facts: 0 }, connectors: { status: "pending" }, done: false, home_seen: false, draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: true } };
vi.mock("./useSetupState", () => ({
  useSetupState: () => {
    const [state, setState] = useState<unknown>(null);
    h.setState = setState; h.state = state;
    return { state, loadError: false, refresh: async () => {}, mark: async (m: { step: string; outcome?: string }) => {
      await Promise.resolve();
      const prev = h.state as typeof running;
      const next = m.step === "done" ? { ...prev, done: true } : m.step === "connectors" ? { ...prev, connectors: { status: m.outcome } } : prev;
      setState(next); return next;
    } };
  },
}));
vi.mock("./draftStarter", () => ({ runDraftStarter: async () => ({ status: "running" }), shouldAutoStartDraft: () => false }));
vi.mock("./importReads", () => ({ useImportReads: () => ({ files: [], refresh: vi.fn() }), summarizeReads: () => ({ reading: [] }) }));
vi.mock("./importReadState", () => ({ loadAfterRead: () => null, saveAfterRead: () => {} }));
vi.mock("../layout/shared", () => ({ useOpenStatic: () => (k: string) => { h.opened.push("static:" + k); } }));
vi.mock("../WorkspaceSwitcher", () => ({ WorkspaceSwitcher: () => null }));
vi.mock("./PastWorkStep", () => ({ PastWorkStep: () => <div>past work</div> }));
vi.mock("./SetupConnectorsStep", () => ({ SetupConnectorsStep: ({ onContinue }: { onContinue: () => Promise<unknown> }) => <button type="button" onClick={() => void onContinue()}>Start growing</button> }));
vi.mock("./SetupQuestionsStep", () => ({ saveSetupAnswers: async () => true, SetupQuestionsStep: ({ onFinish }: { onFinish: (a: unknown) => Promise<unknown> }) => <button type="button" onClick={() => void onFinish({})}>Build my strategy</button> }));
vi.mock("../WorkspaceShell", () => {
  const useWs = () => h.ws as never;
  return { useWorkspace: useWs, useWorkspaceOptional: useWs };
});
import { SetupProvider } from "./SetupProvider";
import { FullscreenSetup } from "./FullscreenSetup";

function Shell() {
  const [active, setActive] = useState("g");
  const tabs = [{ id: "g", kind: "autopilot", payload: { kind: "autopilot" } }, ...(active === "chat" ? [{ id: "chat", kind: "agent", payload: { kind: "agent" } }] : [])];
  h.ws = { tabs, activeTabId: active, role: "owner", openBuildTab: vi.fn(), buildSessionId: null,
    openAgentTab: async (slug: string) => { h.opened.push("agent:" + slug); window.history.pushState(null, "", "/workspace?agent=" + slug); setActive("chat"); return "chat"; } };
  return <SetupProvider><FullscreenSetup /><p data-testid="active">{active}</p></SetupProvider>;
}
it("finishing Connect apps lands on chat", async () => {
  setSetupLocation("/workspace?tab=growth&setupStep=connect-apps");
  render(<Shell />);
  await act(async () => { h.setState!(running); });
  fireEvent.click(await screen.findByRole("button", { name: "Start growing" }));
  fireEvent.click(await screen.findByRole("button", { name: "Build my strategy" }));
  await waitFor(() => expect(screen.getByTestId("active").textContent).toBe("chat"));
  console.log("OPENED", h.opened, window.location.href);
});
