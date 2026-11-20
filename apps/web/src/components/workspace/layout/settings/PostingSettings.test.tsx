// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch }));

import { PostingSettings, type ModeControl } from "./PostingSettings";
import { prefsFrom } from "@/lib/workspace/channelPrefsApi";

const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
const puts = () => apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
const body = (i: number) => JSON.parse(String((puts()[i][1] as RequestInit).body)) as { items: string[] };

afterEach(cleanup);
beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockImplementation(async (_url: string, init?: RequestInit) =>
    init?.method === "PUT" ? ok({}) : ok({ fields: { voice: [{ item: "Plain and friendly." }] } }),
  );
});

describe("prefsFrom", () => {
  it("defaults to ask first, an empty voice, and the first two alerts", () => {
    expect(prefsFrom({})).toEqual({ mode: "ask", voice: "", notify: ["ready", "posted"] });
  });

  it("reads a saved choice, and a saved 'none' as no alerts at all", () => {
    expect(prefsFrom({ post_mode: [{ item: "auto" }], notify_when: [{ item: "none" }] })).toMatchObject({ mode: "auto", notify: [] });
  });

  it("ignores a value it does not know", () => {
    expect(prefsFrom({ post_mode: [{ item: "sometimes" }] }).mode).toBe("ask");
  });
});

const control = (over: Partial<ModeControl> = {}): ModeControl => ({
  value: "ask",
  onChange: vi.fn(),
  busy: false,
  locked: false,
  error: null,
  loadError: null,
  onRetry: vi.fn(),
  ...over,
});

describe("PostingSettings", () => {
  it("shows the saved voice with its count, and no posting or alert choices", async () => {
    render(<PostingSettings slug="linkedin_organic" name="LinkedIn" canEdit />);
    const voice = await screen.findByLabelText("Voice on LinkedIn");
    expect((voice as HTMLTextAreaElement).value).toBe("Plain and friendly.");
    expect(screen.getByText("19/200")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Tell me when" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Before Zavi posts" })).toBeNull();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("draws Before Zavi posts only with a real mode control, and hands the choice to it", async () => {
    const mode = control();
    render(<PostingSettings slug="linkedin_organic" name="LinkedIn" canEdit mode={mode} />);
    const ask = await screen.findByRole("radio", { name: /Ask me first/ }) as HTMLInputElement;
    expect(ask.checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: /Go ahead on my behalf/ }));
    expect(mode.onChange).toHaveBeenCalledWith("auto");
    expect(puts()).toHaveLength(0);
  });

  it("saves the voice on blur only when it changed", async () => {
    render(<PostingSettings slug="linkedin_organic" name="LinkedIn" canEdit />);
    const voice = await screen.findByLabelText("Voice on LinkedIn");
    fireEvent.blur(voice);
    expect(puts()).toHaveLength(0);
    fireEvent.change(voice, { target: { value: "Short. Warm." } });
    fireEvent.blur(voice);
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(body(0).items).toEqual(["Short. Warm."]);
  });

  it("puts the voice back and says why when the save is refused", async () => {
    apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === "PUT" ? ok({}, 403) : ok({ fields: { voice: [{ item: "Plain and friendly." }] } })));
    render(<PostingSettings slug="linkedin_organic" name="LinkedIn" canEdit />);
    const voice = await screen.findByLabelText("Voice on LinkedIn") as HTMLTextAreaElement;
    fireEvent.change(voice, { target: { value: "Short. Warm." } });
    fireEvent.blur(voice);
    expect((await screen.findByRole("alert")).textContent).toContain("owner or admin");
    expect(voice.value).toBe("Plain and friendly.");
  });

  it("queues a revert behind the first save and ignores the older failure", async () => {
    let finishFirst: (response: ReturnType<typeof ok>) => void = () => undefined;
    const first = new Promise<ReturnType<typeof ok>>((resolve) => { finishFirst = resolve; });
    let writes = 0;
    apiFetch.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return ok({ fields: { voice: [{ item: "Plain and friendly." }] } });
      writes += 1;
      return writes === 1 ? first : ok({});
    });
    render(<PostingSettings slug="linkedin_organic" name="LinkedIn" canEdit />);
    const voice = await screen.findByLabelText("Voice on LinkedIn") as HTMLTextAreaElement;
    fireEvent.change(voice, { target: { value: "First edit." } });
    fireEvent.blur(voice);
    await waitFor(() => expect(puts()).toHaveLength(1));
    fireEvent.change(voice, { target: { value: "Plain and friendly." } });
    fireEvent.blur(voice);
    expect(puts()).toHaveLength(1);
    await act(async () => finishFirst(ok({}, 403)));
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(body(0).items).toEqual(["First edit."]);
    expect(body(1).items).toEqual(["Plain and friendly."]);
    expect(voice.value).toBe("Plain and friendly.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says why when the mode control's save was refused", async () => {
    render(<PostingSettings slug="linkedin_organic" name="LinkedIn" canEdit mode={control({ error: "Only a workspace owner or admin can change this." })} />);
    expect((await screen.findByRole("alert")).textContent).toContain("owner or admin");
    expect((screen.getByRole("radio", { name: /Ask me first/ }) as HTMLInputElement).checked).toBe(true);
  });

  it("locks every control for a member and says who can change them", async () => {
    render(<PostingSettings slug="linkedin_organic" name="LinkedIn" canEdit={false} mode={control({ locked: true })} />);
    expect((await screen.findByRole("radio", { name: /Ask me first/ }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Voice on LinkedIn") as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText(/Only a workspace owner or admin/)).toBeTruthy();
  });
});
