// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { SetupState } from "./setupState";
import { fileFromServer, loadAfterRead, saveAfterRead, type ImportFile } from "./importReadState";

let state: SetupState;
let files: ImportFile[] = [];
let afterRead: unknown = null;
let facts: Array<{ key: string; value_text: string }> = [];
vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ facts }) })),
}));
vi.mock("./ImportFlow", () => ({ uploadAll: vi.fn(async () => 0) }));
const setAfterRead = vi.fn();
vi.mock("./SetupProvider", () => ({
  useSetupOptional: () => ({ state, afterRead, setAfterRead, imports: { files, refresh: vi.fn() } }),
}));

import { AfterSetupReadNote } from "./AfterSetupReadNote";

const done = (draft: SetupState["draft"]["status"]): SetupState => ({
  enabled: true,
  docs: { status: "done", files: 1, facts: 0 },
  connectors: { status: "skipped" },
  done: true,
  home_seen: false,
  draft: { status: draft, run_id: null, attempts: 0, can_retry: false, free_retry: false },
});
const file = (extraction: unknown, id = "d", filename = "zavi-context.md") =>
  fileFromServer({ id, filename, created_at: new Date(Date.now() - 3_000).toISOString(), extraction });

beforeEach(() => {
  files = [];
  afterRead = null;
  facts = [];
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe("After setup, a read still open", () => {
  it("says the strategy starts the moment the file is read", () => {
    state = done("none");
    files = [file({ state: "reading", claim_id: "c" })];
    afterRead = { files: ["d"], untouched: [] };
    render(<AfterSetupReadNote />);
    expect(screen.getByText("Setup is done. Your strategy starts the moment I finish reading zavi-context.md.")).toBeTruthy();
    expect(screen.getByText("You can leave this page; I'll keep going.")).toBeTruthy();
  });

  it("once it lands, lists what the file filled in where the founder kept the website guess", async () => {
    state = done("running");
    files = [file({ state: "read", facts: 9 })];
    afterRead = { files: ["d"], untouched: [{ key: "what_we_sell", label: "What you do", value: "Tutoring" }] };
    facts = [{ key: "what_we_sell", value_text: "Tutors for NRI kids" }];
    render(<AfterSetupReadNote />);
    expect(await screen.findByText(/I filled in What you do, where you'd kept my website guess\./)).toBeTruthy();
    expect(screen.getByText("I read zavi-context.md.")).toBeTruthy();
  });

  it("a failed read offers Try another file", () => {
    state = done("running");
    files = [file({ state: "unreadable", reason: "no text in it" })];
    afterRead = { files: ["d"], untouched: [] };
    render(<AfterSetupReadNote />);
    expect(screen.getByText("I couldn't read zavi-context.md (no text in it), so this uses your website and your details.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try another file" })).toBeTruthy();
  });

  it("says nothing when no read was open at the finish and none is now", () => {
    state = done("running");
    files = [file({ state: "read", facts: 9 })];
    const { container } = render(<AfterSetupReadNote />);
    expect(container.textContent).toBe("");
  });

  it("only the files open at the finish count: an earlier read that landed cannot hide a later failure", () => {
    state = done("running");
    files = [file({ state: "unreadable", reason: "no text in it" }, "late", "late.md"), file({ state: "read", facts: 9 }, "early", "early.md")];
    afterRead = { files: ["late"], untouched: [] };
    render(<AfterSetupReadNote />);
    expect(screen.getByText("I couldn't read late.md (no text in it), so this uses your website and your details.")).toBeTruthy();
  });
});

describe("a later upload after the tracked read settled", () => {
  it("the note reports the new file, not the old one", () => {
    state = done("running");
    files = [file({ state: "read", facts: 4 }, "new", "new.md"), file({ state: "read", facts: 9 }, "d", "zavi-context.md")];
    afterRead = { files: ["new"], untouched: [] };
    render(<AfterSetupReadNote />);
    expect(screen.getByText("I read new.md.")).toBeTruthy();
  });
});

describe("the post-finish note survives a reload", () => {
  it("saveAfterRead/loadAfterRead round-trip through sessionStorage; null clears it", () => {
    saveAfterRead({ files: ["d"], untouched: [] });
    expect(loadAfterRead()).toEqual({ files: ["d"], untouched: [] });
    saveAfterRead(null);
    expect(loadAfterRead()).toBeNull();
  });

  it("keeps it while the read is open, and clears it once the settled note has shown", () => {
    state = done("running");
    afterRead = { files: ["d"], untouched: [] };
    saveAfterRead(afterRead as never);
    files = [file({ state: "reading", claim_id: "c" })];
    const { rerender } = render(<AfterSetupReadNote />);
    expect(loadAfterRead()).not.toBeNull();
    files = [file({ state: "read", facts: 9 })];
    rerender(<AfterSetupReadNote />);
    expect(screen.getByText("I read zavi-context.md.")).toBeTruthy();
    expect(loadAfterRead()).toBeNull();
  });
});
