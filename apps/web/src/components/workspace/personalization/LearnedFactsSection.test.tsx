// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const LABEL =
  "Conflicting values on record: two saved notes disagree on this. Ask the user which is right before relying on either.";
const NOTE_ID = "44444444-4444-4444-4444-444444444444";
const HEAD = "Late returns cost 20 per hour. ";
const TAIL = "After 24 hours the renter also pays a full extra day.";
const FULL = HEAD + "x".repeat(4000) + " " + TAIL;
const CHUNK = FULL.slice(0, 2000);

type Sent = { method: string; path: string; body: unknown };
const sent: Sent[] = [];
let getMode: "ok" | "fail" | "hold" = "ok";
let releaseGet: (() => void) | null = null;

function reply(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

vi.mock("@/lib/api", () => ({
  apiFetch: vi.fn(async (path: string, opts?: { method?: string; body?: string }) => {
    const method = opts?.method ?? "GET";
    sent.push({ method, path, body: opts?.body ? JSON.parse(opts.body) : undefined });
    if (path === "/api/memory/search") {
      return reply(true, 200, {
        hits: [
          {
            note_id: NOTE_ID,
            title: "Late return fee",
            body: `${LABEL}\n${CHUNK}`,
            source: "agent_distill",
            created_at: "2026-09-01T00:00:00Z",
            superseded_by: null,
          },
        ],
      });
    }
    if (method === "GET" && path === `/api/memory/notes/${NOTE_ID}`) {
      if (getMode === "fail") return reply(false, 500, { error: { code: "internal", message: "note read failed" } });
      if (getMode === "hold") await new Promise<void>((r) => (releaseGet = r));
      return reply(true, 200, { note: { id: NOTE_ID, title: "Late return fee", body_markdown: FULL, tags: ["pricing"] } });
    }
    return reply(true, 200, { ok: true });
  }),
}));

import { LearnedFactsSection } from "./LearnedFactsSection";

afterEach(() => {
  cleanup();
  sent.length = 0;
  getMode = "ok";
  releaseGet = null;
});

async function searchAndOpen() {
  render(<LearnedFactsSection readOnly={false} onChanged={() => undefined} />);
  fireEvent.change(screen.getByPlaceholderText(/late returns/i), { target: { value: "late fee" } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  await screen.findByText("Late return fee");
  fireEvent.click(screen.getByRole("button", { name: "Correct" }));
}

const puts = () => sent.filter((s) => s.method === "PUT");

describe("LearnedFactsSection Correct edits the whole note, not the search chunk", () => {
  it("saves the full edited note body, never the chunk or the conflict label", async () => {
    await searchAndOpen();
    const box = (await screen.findByLabelText("Correct Late return fee")) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe(FULL));
    expect(sent).toContainEqual({ method: "GET", path: `/api/memory/notes/${NOTE_ID}`, body: undefined });
    const edited = FULL.replace("full extra day", "half extra day");
    fireEvent.change(box, { target: { value: edited } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const put = puts()[0];
    expect(put.path).toBe(`/api/memory/notes/${NOTE_ID}`);
    const md = (put.body as { body_markdown: string }).body_markdown;
    expect(md).toBe(edited);
    expect(md.length).toBeGreaterThan(CHUNK.length + LABEL.length);
    expect(md.endsWith("half extra day.")).toBe(true);
    expect(md).not.toContain(LABEL);
    expect(md.startsWith(HEAD)).toBe(true);
  });

  it("cannot save while the full note is still loading", async () => {
    getMode = "hold";
    await searchAndOpen();
    const box = (await screen.findByLabelText("Correct Late return fee")) as HTMLTextAreaElement;
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(box.disabled).toBe(true);
    expect(box.value).not.toContain(CHUNK.slice(0, 50));
    fireEvent.click(save);
    await new Promise((r) => setTimeout(r, 0));
    expect(puts()).toHaveLength(0);
    releaseGet?.();
    await waitFor(() => expect(box.value).toBe(FULL));
    expect(save.disabled).toBe(false);
  });

  it("a failed load shows an error and offers no editor to save the chunk from", async () => {
    getMode = "fail";
    await searchAndOpen();
    expect((await screen.findByRole("alert")).textContent).toMatch(/note read failed/);
    expect(screen.queryByLabelText("Correct Late return fee")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(puts()).toHaveLength(0);
  });

  it("a load that lands after Cancel does not reopen the editor", async () => {
    getMode = "hold";
    await searchAndOpen();
    await screen.findByLabelText("Correct Late return fee");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    releaseGet?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByLabelText("Correct Late return fee")).toBeNull();
    expect(puts()).toHaveLength(0);
  });
});
