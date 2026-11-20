// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SetupState } from "./setupState";
import { setSetupLocation } from "./setupNavigation.testSupport";

const h = vi.hoisted(() => ({ active: null as SetupState | null, pending: false, marks: [] as unknown[], drafts: 0, saved: [] as unknown[], saveOk: true, fail: "", release: null as (() => void) | null, workspace: null as { tabs: never[]; activeTabId: string } | null }));
const base = (over: Partial<SetupState> = {}): SetupState => ({
  enabled: true, docs: { status: "pending", files: 0, facts: 0 }, connectors: { status: "pending" }, done: false, home_seen: false,
  draft: { status: "none", run_id: null, attempts: 0, can_retry: false, free_retry: true }, ...over,
});
const afterDocs = () => base({ docs: { status: "skipped", files: 0, facts: 0 } });
vi.mock("next/navigation", async () => import("./setupNavigation.testSupport"));
vi.mock("./SetupProvider", () => ({
  useSetupActive: () => h.active,
  useSetupOptional: () => h.active || h.pending ? {
    pending: h.pending, state: h.active, imports: { files: [], refresh: vi.fn() }, setAfterRead: vi.fn(),
    mark: async (mark: { step: string }) => {
      h.marks.push(mark);
      if (h.fail === mark.step) throw new Error("Progress couldn't be saved");
      if (h.fail === "waiting") await new Promise<void>((resolve) => { h.release = resolve; });
      return null;
    },
    startDraft: async () => { h.drafts += 1; h.marks.push({ draftAfterAnswers: h.saved.length }); },
  } : null,
}));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => h.workspace }));
vi.mock("./PastWorkStep", () => ({ PastWorkStep: ({ onComplete, onSkip }: { onComplete: () => Promise<unknown>; onSkip: () => Promise<unknown> }) => <div>past work<button type="button" onClick={() => void onComplete()}>Add to Zavi</button><button type="button" onClick={() => void onSkip()}>Skip</button></div> }));
vi.mock("./SetupConnectorsStep", () => ({ SetupConnectorsStep: ({ onContinue, onSkip, onBack, busy, error }: { onContinue: () => Promise<unknown>; onSkip: () => Promise<unknown>; onBack: () => void; busy: boolean; error?: string | null }) => <div>connect apps<button type="button" disabled={busy} onClick={onBack}>Back</button><button type="button" disabled={busy} onClick={() => void onContinue()}>Start growing with 1 app</button><button type="button" disabled={busy} onClick={() => void onSkip()}>Skip</button>{error && <p role="alert">{error}</p>}</div> }));
vi.mock("./SetupQuestionsStep", () => ({
  saveSetupAnswers: async (answers: unknown) => { h.saved.push(answers); return h.saveOk; },
  SetupQuestionsStep: ({ onFinish, onSkip, onBack, onChange, busy, error }: { onFinish: (a: unknown) => Promise<unknown>; onSkip: () => Promise<unknown>; onBack: () => void; onChange: (f: (p: object) => object) => void; busy: boolean; error?: string | null }) => <div>your business<button type="button" disabled={busy} onClick={onBack}>Back</button><button type="button" onClick={() => onChange(() => ({ customers: ["6-20"] }))}>Pick 6-20</button><button type="button" disabled={busy} onClick={() => void onFinish({ constraint: ["They look, but don't buy"] })}>Build my strategy</button><button type="button" disabled={busy} onClick={() => void onSkip()}>Skip questions</button>{error && <p role="alert">{error}</p>}</div>,
}));
import { FullscreenSetup, currentStep } from "./FullscreenSetup";

beforeEach(() => { setSetupLocation(); h.active = null; h.pending = false; h.marks = []; h.saved = []; h.saveOk = true; window.sessionStorage.clear(); h.drafts = 0; h.fail = ""; h.release = null; h.workspace = null; });
afterEach(cleanup);

describe("new onboarding handoff", () => {
  it("Escape skips the optional steps and finishes through the existing backend progress flow", async () => {
    h.active = base();
    render(<FullscreenSetup />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(h.marks.filter((m) => "step" in (m as object))).toEqual([{ step: "docs", outcome: "skipped" }, { step: "connectors", outcome: "skipped" }, { step: "done" }]));
    expect(h.drafts).toBe(1);
  });
  it("waits for setup loading and renders nothing when inactive", () => {
    const view = render(<FullscreenSetup />);
    expect(view.container.innerHTML).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();
    h.pending = true;
    view.rerender(<FullscreenSetup />);
    expect(screen.getByRole("status", { name: "Loading your setup" })).toBeTruthy();
  });
  it("saves only the documents step when Past work is skipped", async () => {
    h.active = base();
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(h.marks).toEqual([{ step: "docs", outcome: "skipped" }]));
    expect(h.drafts).toBe(0);
  });
  it("shows Connect apps after Past work, with no old rail or questionnaire", () => {
    h.active = afterDocs();
    render(<FullscreenSetup />);
    expect(screen.getByText("connect apps")).toBeTruthy();
    expect(screen.queryByText("past work")).toBeNull();
    expect(screen.queryByText(/Step 2 of 3/)).toBeNull();
  });
  it("shows no company header above the setup steps", () => {
    h.active = base();
    render(<FullscreenSetup />);
    expect(screen.getByRole("dialog", { name: "Set up Zavi" })).toBeTruthy();
    expect(document.querySelector("header")).toBeNull();
  });
  it.each(["Skip", "Start growing with 1 app"])("%s opens the questions and saves nothing until they end", async (label) => {
    h.active = afterDocs();
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(await screen.findByText("your business")).toBeTruthy();
    expect(h.marks).toEqual([]);
    expect(h.drafts).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Skip questions" }));
    await waitFor(() => expect(h.marks).toEqual([{ step: "connectors", outcome: label === "Skip" ? "skipped" : "done" }, { draftAfterAnswers: 0 }, { step: "done" }]));
    expect(h.drafts).toBe(1);
  });
  it("puts the questions step in the URL, and a reload reopens it with the connector choice", async () => {
    h.active = afterDocs();
    const view = render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Start growing with 1 app" }));
    await screen.findByText("your business");
    expect(window.location.search).toContain("setupStep=your-business");
    expect(window.location.search).toContain("connectors=done");
    view.unmount();
    render(<FullscreenSetup />);
    fireEvent.click(await screen.findByRole("button", { name: "Skip questions" }));
    await waitFor(() => expect(h.marks).toContainEqual({ step: "connectors", outcome: "done" }));
  });
  it("saves the answers before the strategy starts", async () => {
    h.active = afterDocs();
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Start growing with 1 app" }));
    fireEvent.click(await screen.findByRole("button", { name: "Build my strategy" }));
    await waitFor(() => expect(h.marks).toEqual([{ step: "connectors", outcome: "done" }, { draftAfterAnswers: 1 }, { step: "done" }]));
    expect(h.saved).toEqual([{ constraint: ["They look, but don't buy"] }]);
  });
  it("Back from the questions returns to Connect apps without saving", async () => {
    h.active = afterDocs();
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(await screen.findByText("connect apps")).toBeTruthy();
    expect(h.marks).toEqual([]);
  });
  it("holds the step when an answer did not save, and starts nothing", async () => {
    h.active = afterDocs();
    h.saveOk = false;
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Build my strategy" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/didn't save/);
    expect(h.marks).toEqual([]);
    expect(h.drafts).toBe(0);
  });
  it("Escape after Back to Past work still saves the held picks", async () => {
    h.active = afterDocs();
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick 6-20" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    await screen.findByText("past work");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(h.saved).toEqual([{ customers: ["6-20"] }]));
  });
  it("keeps the picks across a full reload (an OAuth round trip) and drops them once setup ends", async () => {
    h.active = afterDocs();
    h.workspace = { tabs: [], activeTabId: "", tenantId: "t1" } as never;
    const view = render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick 6-20" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    view.unmount();
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Build my strategy" }));
    await waitFor(() => expect(h.marks).toContainEqual({ step: "done" }));
    expect(window.sessionStorage.length).toBe(0);
  });
  it("never shows one workspace's held picks in another", async () => {
    window.sessionStorage.setItem("zavi.setup.answers:t1", JSON.stringify({ customers: ["6-20"] }));
    h.active = afterDocs();
    h.workspace = { tabs: [], activeTabId: "", tenantId: "t2" } as never;
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip questions" }));
    await waitFor(() => expect(h.marks).toContainEqual({ step: "done" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(h.saved).toEqual([]);
  });
  it("shows a failed Escape save on Connect apps too", async () => {
    h.active = afterDocs();
    h.saveOk = false;
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick 6-20" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText("connect apps");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect((await screen.findByRole("alert")).textContent).toMatch(/didn't save/);
    expect(h.marks).toEqual([]);
  });
  it("Escape keeps setup open with the error when the picks did not save", async () => {
    h.active = afterDocs();
    h.saveOk = false;
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick 6-20" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect((await screen.findByRole("alert")).textContent).toMatch(/didn't save/);
    expect(h.marks).toEqual([]);
    expect(h.drafts).toBe(0);
  });
  it("Escape after Back to Connect apps still saves the held picks", async () => {
    h.active = afterDocs();
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick 6-20" }));
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByText("connect apps");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(h.saved).toEqual([{ customers: ["6-20"] }]));
  });
  it("Escape on the questions saves the picks and keeps the connector choice", async () => {
    h.active = afterDocs();
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Start growing with 1 app" }));
    fireEvent.click(await screen.findByRole("button", { name: "Pick 6-20" }));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(h.marks.filter((m) => "step" in (m as object))).toEqual([{ step: "connectors", outcome: "done" }, { step: "done" }]));
    expect(h.saved).toEqual([{ customers: ["6-20"] }]);
    expect(h.marks).toContainEqual({ draftAfterAnswers: 1 });
  });
  it("returns to saved Past work using the URL without changing its progress", async () => {
    h.active = afterDocs();
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(window.location.search).toContain("setupStep=past-work");
    expect(screen.getByText("past work")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add to Zavi" }));
    await waitFor(() => expect(screen.getByText("connect apps")).toBeTruthy());
    expect(h.marks).toEqual([]);
    expect(h.drafts).toBe(0);
  });
  it("keeps Connect apps open if progress fails and does not start a draft", async () => {
    h.active = afterDocs();
    h.fail = "connectors";
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip questions" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(h.marks).toEqual([{ step: "connectors", outcome: "skipped" }]);
    expect(h.drafts).toBe(0);
  });
  it("retries final completion without starting another draft or overwriting the connector choice", async () => {
    h.active = afterDocs();
    h.fail = "done";
    render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Start growing with 1 app" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip questions" }));
    await screen.findByRole("alert");
    h.fail = "";
    fireEvent.click(screen.getByRole("button", { name: "Skip questions" }));
    await waitFor(() => expect(h.marks).toHaveLength(4));
    expect(h.marks).toEqual([{ step: "connectors", outcome: "done" }, { draftAfterAnswers: 0 }, { step: "done" }, { step: "done" }]);
    expect(h.drafts).toBe(1);
  });
  it("locks repeated clicks while the backend is saving", async () => {
    h.active = afterDocs();
    h.fail = "waiting";
    const view = render(<FullscreenSetup />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip questions" }));
    fireEvent.click(screen.getByRole("button", { name: "Skip questions" }));
    expect(h.marks).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
    h.fail = "";
    h.release?.();
  });
  it("resumes an interrupted final step on Connect apps rather than the removed questionnaire", () => {
    h.active = base({ docs: { status: "done", files: 1, facts: 2 }, connectors: { status: "done" } });
    render(<FullscreenSetup />);
    expect(screen.getByText("connect apps")).toBeTruthy();
    expect(currentStep(h.active)).toBe(3);
  });
});
