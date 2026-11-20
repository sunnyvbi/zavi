// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { VideoOverview } from "./VideoOverview";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch, IDEMPOTENCY_HEADER: "Idempotency-Key", newIdempotencyKey: () => `key-${Math.random()}` }));
vi.mock("../WorkspaceShell", () => ({ useWorkspaceOptional: () => null, useWorkspace: () => null }));
vi.mock("../actions/useChannelActions", () => ({
  useChannelActions: () => ({ actions: [], refreshSilent: async () => undefined, loading: false, completed: [], more: 0, plan: null, metrics: [] }),
}));

const res = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });

const EMPTY = { thread_id: null, messages: [], renders: {} };

beforeEach(() => {
  apiFetch.mockReset();
  window.sessionStorage.clear();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const Hero = () => <VideoOverview slug="generated_video" focusThread={null} />;

const pickImageMode = () => fireEvent.click(screen.getByRole("radio", { name: "Image to video" }));

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("VideoOverview hero", () => {
  it("Enter sends once and clears the box; Enter while composing text or with Shift sends nothing", async () => {
    apiFetch.mockImplementation(async (_path: string, opts?: { method?: string }) => {
      if (opts?.method === "POST") return res({ ok: true });
      return res({ thread_id: null, messages: [], renders: {} });
    });
    render(<Hero />);
    await flush();
    const box = screen.getByLabelText("Your script") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "a promo for our local gym today" } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    await flush();
    const posts = () => apiFetch.mock.calls.filter(([, opts]) => opts?.method === "POST");
    expect(posts()).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter" });
    await flush();
    expect(posts()).toHaveLength(1);
    expect(JSON.parse(posts()[0][1].body)).toEqual({ text: "a promo for our local gym today", verbatim: true, new_thread: true });
  });

  it("an attached image uploads first, the send waits for it, and an image-only send carries just the image path", async () => {
    let finishUpload: (v: unknown) => void = () => {};
    apiFetch.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === "/api/chat/upload-image") return new Promise((r) => (finishUpload = r));
      if (opts?.method === "POST") return res({ ok: true });
      return res({ thread_id: null, messages: [], renders: {} });
    });
    render(<Hero />);
    await flush();
    const file = new File([new Uint8Array([1, 2, 3])], "cafe.png", { type: "image/png" });
    pickImageMode();
    fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [file] } });
    await flush();
    const upload = apiFetch.mock.calls.find(([p]) => p === "/api/chat/upload-image")!;
    expect((upload[1].body as FormData).get("file")).toBe(file);
    expect(screen.getByTestId("video-studio-attachment")).toBeTruthy();
    const send = screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.keyDown(screen.getByLabelText("How the image should move"), { key: "Enter" });
    await flush();
    expect(apiFetch.mock.calls.some(([p]) => p === "/api/channels/generated_video/studio/messages")).toBe(false);
    await act(async () => finishUpload(res({ image_path: "t1/cafe.jpg" })));
    await flush();
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await flush();
    const post = apiFetch.mock.calls.find(([p]) => p === "/api/channels/generated_video/studio/messages")!;
    expect(JSON.parse(post[1].body)).toEqual({ text: "", image_path: "t1/cafe.jpg", new_thread: true });
    expect(screen.queryByTestId("video-studio-attachment")).toBeNull();
  });

  it("Change image opens the picker and swaps the attached image for the new one", async () => {
    apiFetch.mockImplementation(async (path: string, opts?: { method?: string; body?: FormData }) => {
      if (path === "/api/chat/upload-image") return res({ image_path: `t1/${(opts!.body!.get("file") as File).name}` });
      if (opts?.method === "POST") return res({ ok: true });
      return res({ thread_id: null, messages: [], renders: {} });
    });
    render(<Hero />);
    await flush();
    pickImageMode();
    expect(screen.queryByRole("button", { name: "Change image" })).toBeNull();
    fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [new File([new Uint8Array([1])], "first.png", { type: "image/png" })] } });
    await flush();
    const input = screen.getByTestId("video-studio-file") as HTMLInputElement;
    const opened = vi.spyOn(input, "click").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: "Change image" }));
    expect(opened).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([2])], "second.png", { type: "image/png" })] } });
    await flush();
    expect(screen.getAllByTestId("video-studio-attachment")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await flush();
    const post = apiFetch.mock.calls.find(([p]) => p === "/api/channels/generated_video/studio/messages")!;
    expect(JSON.parse(post[1].body)).toEqual({ text: "", image_path: "t1/second.png", new_thread: true });
  });

  it("removing an image while it uploads keeps it removed when the upload finishes late", async () => {
    let finishUpload: (v: unknown) => void = () => {};
    apiFetch.mockImplementation(async (path: string) => {
      if (path === "/api/chat/upload-image") return new Promise((r) => (finishUpload = r));
      return res({ thread_id: null, messages: [], renders: {} });
    });
    render(<Hero />);
    await flush();
    pickImageMode();
    fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })] } });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Remove the image" }));
    await act(async () => finishUpload(res({ image_path: "t1/a.jpg" })));
    await flush();
    expect(screen.queryByTestId("video-studio-attachment")).toBeNull();
    expect((screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it.each([
    ["unsupported_mime", "file content not recognized as png/jpeg/webp", "That file is not a PNG, JPEG or WebP image. Attach a real image."],
    ["invalid_image", "image could not be processed: Input buffer contains unsupported image format", "That image could not be read. Attach a different PNG, JPEG or WebP image."],
  ])("a file named .png that is not really an image shows plain words, not the server's %s text", async (code, message, shown) => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === "/api/chat/upload-image") return res({ error: { code, message } }, 400);
      return res({ thread_id: null, messages: [], renders: {} });
    });
    render(<Hero />);
    await flush();
    pickImageMode();
    fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [new File(["not a png"], "fake.png", { type: "image/png" })] } });
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(shown);
    expect(screen.getByRole("alert").textContent).not.toContain("recognized as");
    expect(screen.queryByTestId("video-studio-attachment")).toBeNull();
  });

  it.each([
    ["file_too_large", 400, "That image is over 5 MB. Attach a smaller one."],
    ["upload_rejected", 400, "That image could not be uploaded. Attach a different PNG, JPEG or WebP image."],
    ["no_file", 400, "No image was attached. Choose an image and try again."],
    ["unauthenticated", 401, "You are signed out. Sign in again and retry."],
  ])("the backend code %s shows its plain copy, not the server text", async (code, status, shown) => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === "/api/chat/upload-image") return res({ error: { code, message: "SERVER-RAW-TEXT" } }, status);
      return res({ thread_id: null, messages: [], renders: {} });
    });
    render(<Hero />);
    await flush();
    pickImageMode();
    fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [new File(["x"], "a.png", { type: "image/png" })] } });
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(shown);
    expect(screen.getByRole("alert").textContent).not.toContain("SERVER-RAW-TEXT");
  });

  it.each([
    [500, "internal", "boom"],
    [500, "upload_failed", "storage exploded: bucket x"],
    [503, "auth_unavailable", "Zavi can't check your sign-in right now."],
    [500, "file_too_large", "5xx wins over a known code"],
    [400, "some_new_code", "raw new message"],
  ])("a %s with code %s shows the generic line and never the server text", async (status, code, message) => {
    apiFetch.mockImplementation(async (path: string) => {
      if (path === "/api/chat/upload-image") return res({ error: { code, message } }, status);
      return res({ thread_id: null, messages: [], renders: {} });
    });
    render(<Hero />);
    await flush();
    pickImageMode();
    fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [new File(["x"], "a.png", { type: "image/png" })] } });
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("The image did not upload. Try again.");
    expect(screen.getByRole("alert").textContent).not.toContain(message);
  });

  it("a file that is not an image is refused in the browser and nothing is uploaded or sent", async () => {
    apiFetch.mockImplementation(async () => res({ thread_id: null, messages: [], renders: {} }));
    render(<Hero />);
    await flush();
    pickImageMode();
    fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [new File(["x"], "a.gif", { type: "image/gif" })] } });
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("PNG, JPEG or WebP");
    expect(apiFetch.mock.calls.some(([p]) => p === "/api/chat/upload-image")).toBe(false);
    expect(screen.queryByTestId("video-studio-attachment")).toBeNull();
  });

  it("Enable prompt starts off and the box is sent as the exact script, with verbatim set, and no prompt is fetched", async () => {
    apiFetch.mockImplementation(async (_p: string, opts?: { method?: string }) => (opts?.method === "POST" ? res({ ok: true }) : res(EMPTY)));
    render(<Hero />);
    await flush();
    const toggle = screen.getByRole("switch", { name: "Enable prompt" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(apiFetch.mock.calls.some(([p]) => String(p).endsWith("/studio/prompt"))).toBe(false);
    fireEvent.change(screen.getByLabelText("Your script"), { target: { value: "Rent my car while I sleep. Upcar pays my lease." } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await flush();
    const posts = apiFetch.mock.calls.filter(([p, o]) => p === "/api/channels/generated_video/studio/messages" && o?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({ text: "Rent my car while I sleep. Upcar pays my lease.", verbatim: true, new_thread: true });
  });

  it("Script writer shows the credit headline and a Top up credits control on a 402, never the raw server sentence", async () => {
    const RAW = "You're out of credits. Top up in Billing to keep your agents running.";
    apiFetch.mockImplementation(async (path: string) => {
      if (path === "/api/channels/generated_video/studio/script") return res({ error: { code: "out_of_credits", message: RAW } }, 402);
      return res(EMPTY);
    });
    render(<Hero />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Script writer" }));
    fireEvent.change(screen.getByLabelText("Your prompt"), { target: { value: "a host who pays her lease by renting her car" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Script writer" })).getByRole("button", { name: "Generate" }));
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Script writer" });
    const alert = within(dialog).getByRole("alert");
    expect(alert.textContent).toContain("Out of credits.");
    expect(within(dialog).getByRole("button", { name: "Top up credits" })).toBeTruthy();
    expect(screen.queryByText(/keep your agents running/)).toBeNull();
  });

  it("Script writer closes on Generate, locks the box and Generate while it writes, then puts the script in and turns the prompt off", async () => {
    const reduce = vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: q.includes("reduce"), media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as MediaQueryList);
    let finish: (v: unknown) => void = () => {};
    apiFetch.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path === "/api/channels/generated_video/studio/script") return new Promise((r) => (finish = r));
      if (opts?.method === "POST") return res({ ok: true });
      return res(EMPTY);
    });
    render(<Hero />);
    await flush();
    fireEvent.change(screen.getByLabelText("Your script"), { target: { value: "old words" } });
    fireEvent.click(screen.getByRole("button", { name: "Script writer" }));
    fireEvent.change(screen.getByLabelText("Your prompt"), { target: { value: "a host who pays her lease by renting her car" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Script writer" })).getByRole("button", { name: "Generate" }));
    await flush();
    expect(screen.queryByRole("dialog", { name: "Script writer" })).toBeNull();
    const trigger = screen.getByRole("button", { name: "Writing…" }) as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Script writer" })).toBeNull();
    const writes = apiFetch.mock.calls.filter(([p]) => p === "/api/channels/generated_video/studio/script");
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0][1].body)).toEqual({ prompt: "a host who pays her lease by renting her car" });
    const main = screen.getByLabelText("Your script") as HTMLTextAreaElement;
    expect(main.value).toBe("old words");
    expect(main.readOnly).toBe(true);
    const generate = screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    fireEvent.keyDown(main, { key: "Enter" });
    await flush();
    expect(apiFetch.mock.calls.some(([p]) => p === "/api/channels/generated_video/studio/messages")).toBe(false);
    await act(async () => finish(res({ script: "My car paid my lease this month. Here is how." })));
    await flush();
    expect(main.value).toBe("My car paid my lease this month. Here is how.");
    expect(main.readOnly).toBe(false);
    expect(document.activeElement).toBe(main);
    expect(screen.getByRole("button", { name: "Script writer" })).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Enable prompt" }).getAttribute("aria-checked")).toBe("false");
    expect(apiFetch.mock.calls.some(([p]) => p === "/api/channels/generated_video/studio/messages")).toBe(false);
    fireEvent.click(generate);
    await flush();
    const post = apiFetch.mock.calls.find(([p]) => p === "/api/channels/generated_video/studio/messages")!;
    expect(JSON.parse(post[1].body)).toEqual({ text: "My car paid my lease this month. Here is how.", verbatim: true, new_thread: true });
    reduce.mockRestore();
  });

  it("Script writer types the script in word by word, keeps the box locked until the last word, and Undo puts the old text back", async () => {
    let finish: (v: unknown) => void = () => {};
    apiFetch.mockImplementation(async (path: string) => (path.endsWith("/studio/script") ? new Promise((r) => (finish = r)) : res(EMPTY)));
    render(<Hero />);
    await flush();
    const main = screen.getByLabelText("Your script") as HTMLTextAreaElement;
    fireEvent.change(main, { target: { value: "my own draft" } });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Script writer" }));
    fireEvent.change(screen.getByLabelText("Your prompt"), { target: { value: "a lease ad" } });
    vi.useFakeTimers();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Script writer" })).getByRole("button", { name: "Generate" }));
    await act(async () => finish(res({ script: "One two three four five six" })));
    await flush();
    expect(main.value).toBe("");
    expect(main.readOnly).toBe(true);
    act(() => vi.advanceTimersByTime(45));
    expect(main.value).toBe("One");
    act(() => vi.advanceTimersByTime(90));
    expect(main.value).toBe("One two three");
    expect(main.readOnly).toBe(true);
    expect((screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => vi.advanceTimersByTime(135));
    expect(main.value).toBe("One two three four five six");
    expect(main.readOnly).toBe(false);
    expect((screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement).disabled).toBe(false);
    act(() => vi.advanceTimersByTime(500));
    expect(main.value).toBe("One two three four five six");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(main.value).toBe("my own draft");
    expect(document.activeElement).toBe(main);
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("Undo pressed mid-typing stops the typing and restores the old text", async () => {
    let finish: (v: unknown) => void = () => {};
    apiFetch.mockImplementation(async (path: string) => (path.endsWith("/studio/script") ? new Promise((r) => (finish = r)) : res(EMPTY)));
    render(<Hero />);
    await flush();
    const main = screen.getByLabelText("Your script") as HTMLTextAreaElement;
    fireEvent.change(main, { target: { value: "keep this" } });
    fireEvent.click(screen.getByRole("button", { name: "Script writer" }));
    fireEvent.change(screen.getByLabelText("Your prompt"), { target: { value: "x" } });
    vi.useFakeTimers();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Script writer" })).getByRole("button", { name: "Generate" }));
    await act(async () => finish(res({ script: "a b c d e f" })));
    await flush();
    act(() => vi.advanceTimersByTime(90));
    expect(main.value).toBe("a b");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    act(() => vi.advanceTimersByTime(1000));
    expect(main.value).toBe("keep this");
    expect(main.readOnly).toBe(false);
  });

  it("Undo goes away as soon as the user edits the written script, so it cannot throw the edits away", async () => {
    const reduce = vi.spyOn(window, "matchMedia").mockImplementation((q: string) => ({ matches: q.includes("reduce"), media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }) as MediaQueryList);
    apiFetch.mockImplementation(async (path: string, opts?: { method?: string }) => {
      if (path.endsWith("/studio/script")) return res({ script: "Written by Zavi for your new ad." });
      if (opts?.method === "POST") return res({ ok: true });
      return res(EMPTY);
    });
    render(<Hero />);
    await flush();
    const main = screen.getByLabelText("Your script") as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: "Script writer" }));
    fireEvent.change(screen.getByLabelText("Your prompt"), { target: { value: "x" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Script writer" })).getByRole("button", { name: "Generate" }));
    await flush();
    expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
    fireEvent.change(main, { target: { value: "Written by Zavi for your new ad. Edited." } });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await flush();
    const post = apiFetch.mock.calls.find(([p]) => p === "/api/channels/generated_video/studio/messages")!;
    expect(JSON.parse(post[1].body).text).toBe("Written by Zavi for your new ad. Edited.");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    reduce.mockRestore();
  });

  it("Generate needs 6 to 150 words of script, not counting spaces", async () => {
    apiFetch.mockImplementation(async () => res(EMPTY));
    render(<Hero />);
    await flush();
    const main = screen.getByLabelText("Your script") as HTMLTextAreaElement;
    const generate = screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement;
    fireEvent.change(main, { target: { value: "  one two three four five   " } });
    expect(generate.disabled).toBe(true);
    fireEvent.keyDown(main, { key: "Enter" });
    await flush();
    expect(apiFetch.mock.calls.some(([, o]) => o?.method === "POST")).toBe(false);
    fireEvent.change(main, { target: { value: " one two three four five six " } });
    expect(generate.disabled).toBe(false);
  });

  it("Escape closes the Script writer and puts focus back on the button that opened it", async () => {
    apiFetch.mockImplementation(async () => res(EMPTY));
    render(<Hero />);
    await flush();
    const trigger = screen.getByRole("button", { name: "Script writer" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Script writer" });
    expect(trigger.getAttribute("aria-controls")).toBe(dialog.id);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const prompt = screen.getByLabelText("Your prompt");
    prompt.focus();
    expect(document.activeElement).toBe(prompt);
    fireEvent.keyDown(prompt, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Script writer" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  function fakeSpeech() {
    const instances: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; onresult: ((e: unknown) => void) | null }> = [];
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      onstart: (() => void) | null = null;
      start = vi.fn(() => this.onstart?.());
      stop = vi.fn(() => this.onend?.());
      abort = vi.fn(() => this.onend?.());
      constructor() {
        instances.push(this as never);
      }
    }
    const w = window as unknown as Record<string, unknown>;
    w.SpeechRecognition = FakeRecognition;
    w.webkitSpeechRecognition = FakeRecognition;
    return {
      instances,
      restore: () => {
        delete w.SpeechRecognition;
        delete w.webkitSpeechRecognition;
      },
    };
  }

  it("the mic opens the chat composer's recording surface over the prompt box, and Confirm puts the heard words in the script", async () => {
    const speech = fakeSpeech();
    try {
      apiFetch.mockImplementation(async () => res(EMPTY));
      render(<Hero />);
      await flush();
      const box = screen.getByLabelText("Your script") as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: "Intro." } });
      const mic = screen.getByRole("button", { name: "Start dictation" }) as HTMLButtonElement;
      expect(mic.disabled).toBe(false);
      expect(screen.queryByTestId("dictation-wave")).toBeNull();
      fireEvent.click(mic);
      await flush();
      const group = screen.getByRole("group", { name: "Voice input, recording" });
      const wave = within(group).getByTestId("dictation-wave");
      expect(wave.getAttribute("data-phase")).toBe("recording");
      expect(wave.querySelectorAll("span").length).toBeGreaterThanOrEqual(16);
      expect(group.className).toContain("absolute");
      let host = group.parentElement;
      while (host && !host.classList.contains("relative")) host = host.parentElement;
      expect(host?.contains(box)).toBe(true);
      expect(host?.querySelector('[role="radiogroup"]')).toBeNull();
      expect(within(group).getByRole("status").textContent).toBe("Recording");
      for (const name of ["Cancel voice input", "Pause recording", "Stop recording", "Confirm and insert transcript"]) {
        expect(within(group).getByRole("button", { name })).toBeTruthy();
      }
      const rec = speech.instances[speech.instances.length - 1];
      expect(rec.start).toHaveBeenCalledTimes(1);
      await act(async () => rec.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: "hello world" }], { isFinal: true })] }));
      await flush();
      expect(within(group).getByTestId("dictation-transcript").textContent).toContain("hello world");
      fireEvent.click(within(group).getByRole("button", { name: "Pause recording" }));
      await flush();
      expect(screen.getByTestId("dictation-wave").getAttribute("data-phase")).toBe("paused");
      expect(screen.getByRole("group", { name: "Voice input, paused" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Confirm and insert transcript" }));
      await flush();
      expect(box.value).toBe("Intro. hello world");
      expect(screen.queryByTestId("dictation-wave")).toBeNull();
      expect(screen.getByRole("button", { name: "Start dictation" })).toBeTruthy();
    } finally {
      speech.restore();
    }
  });

  it("Cancel on the recording surface throws the heard words away and leaves the script untouched", async () => {
    const speech = fakeSpeech();
    try {
      apiFetch.mockImplementation(async () => res(EMPTY));
      render(<Hero />);
      await flush();
      const box = screen.getByLabelText("Your script") as HTMLTextAreaElement;
      fireEvent.change(box, { target: { value: "Keep me." } });
      fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
      await flush();
      const rec = speech.instances[speech.instances.length - 1];
      await act(async () => rec.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: "throw away" }], { isFinal: true })] }));
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "Cancel voice input" }));
      await flush();
      expect(box.value).toBe("Keep me.");
      expect(screen.queryByTestId("dictation-wave")).toBeNull();
    } finally {
      speech.restore();
    }
  });

  it("the mic is off while the Script writer types, and says when the browser cannot dictate", async () => {
    const speech = fakeSpeech();
    let finish: (v: unknown) => void = () => {};
    try {
      apiFetch.mockImplementation(async (path: string) => (path === "/api/channels/generated_video/studio/script" ? new Promise((r) => (finish = r)) : res(EMPTY)));
      render(<Hero />);
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "Script writer" }));
      fireEvent.change(screen.getByLabelText("Your prompt"), { target: { value: "a host who rents her car" } });
      fireEvent.click(within(screen.getByRole("dialog", { name: "Script writer" })).getByRole("button", { name: "Generate" }));
      await flush();
      const mic = screen.getByRole("button", { name: "Start dictation" }) as HTMLButtonElement;
      expect(mic.disabled).toBe(true);
      fireEvent.click(mic);
      await flush();
      expect(speech.instances).toHaveLength(0);
      expect(screen.queryByTestId("dictation-wave")).toBeNull();
      await act(async () => finish(res({ script: "Short." })));
      await flush();
      expect((screen.getByRole("button", { name: "Start dictation" }) as HTMLButtonElement).disabled).toBe(false);
    } finally {
      speech.restore();
    }
    cleanup();
    apiFetch.mockImplementation(async () => res(EMPTY));
    render(<Hero />);
    await flush();
    const unsupported = screen.getByRole("button", { name: "Dictation is not supported in this browser" }) as HTMLButtonElement;
    expect(unsupported.disabled).toBe(true);
    expect(unsupported.getAttribute("title")).toBe("Dictation is not supported in this browser");
    expect(screen.getByTestId("dictation-unsupported").textContent).toBe("Dictation is not supported in this browser");
  });

  const PROMPT = "A short talking-head ad for UpcarAI.\nOpen with the problem our customer has.";
  const promptCalls = () => apiFetch.mock.calls.filter(([p]) => p === "/api/channels/generated_video/studio/prompt");
  const box = () => screen.getByLabelText("Your script") as HTMLTextAreaElement;

  it("turning Enable prompt on fills the empty box with the business prompt, and off clears it when untouched", async () => {
    apiFetch.mockImplementation(async (path: string, opts?: { method?: string }) =>
      path.endsWith("/studio/prompt") ? res({ prompt: PROMPT }) : opts?.method === "POST" ? res({ ok: true }) : res(EMPTY),
    );
    render(<Hero />);
    await flush();
    const toggle = screen.getByRole("switch", { name: "Enable prompt" });
    fireEvent.click(toggle);
    await flush();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(promptCalls()).toHaveLength(1);
    expect(box().value).toBe(PROMPT);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(box().value).toBe("");
    fireEvent.click(toggle);
    await flush();
    expect(promptCalls()).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await flush();
    const post = apiFetch.mock.calls.find(([p]) => p === "/api/channels/generated_video/studio/messages")!;
    expect(JSON.parse(post[1].body)).toEqual({ text: PROMPT, new_thread: true });
  });

  it("Enable prompt keeps what the person wrote: it never fetches over text, and off keeps an edited prompt", async () => {
    apiFetch.mockImplementation(async (path: string) => (path.endsWith("/studio/prompt") ? res({ prompt: PROMPT }) : res(EMPTY)));
    render(<Hero />);
    await flush();
    const toggle = screen.getByRole("switch", { name: "Enable prompt" });
    fireEvent.change(box(), { target: { value: "my own idea" } });
    fireEvent.click(toggle);
    await flush();
    expect(promptCalls()).toHaveLength(0);
    expect(box().value).toBe("my own idea");
    fireEvent.click(toggle);
    expect(box().value).toBe("my own idea");
    fireEvent.change(box(), { target: { value: "" } });
    fireEvent.click(toggle);
    await flush();
    fireEvent.change(box(), { target: { value: `${PROMPT} Make it funny.` } });
    fireEvent.click(toggle);
    expect(box().value).toBe(`${PROMPT} Make it funny.`);
  });

  it("a prompt that lands after the switch went off again, or that fails, leaves the box empty", async () => {
    let land: (v: unknown) => void = () => {};
    let fail = false;
    apiFetch.mockImplementation(async (path: string) => {
      if (!path.endsWith("/studio/prompt")) return res(EMPTY);
      if (fail) return res({ error: { message: "nope" } }, 500);
      return new Promise((r) => (land = r));
    });
    render(<Hero />);
    await flush();
    const toggle = screen.getByRole("switch", { name: "Enable prompt" });
    fireEvent.click(toggle);
    await flush();
    expect(toggle.getAttribute("aria-busy")).toBe("true");
    expect(box().getAttribute("placeholder")).toBe("Writing a prompt for your business…");
    fireEvent.click(toggle);
    await act(async () => land(res({ prompt: PROMPT })));
    await flush();
    expect(box().value).toBe("");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("aria-busy")).toBeNull();
    fail = true;
    fireEvent.click(toggle);
    await flush();
    expect(box().value).toBe("");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("video-studio-prompt-error")).toBeTruthy();
    expect(toggle.getAttribute("aria-busy")).toBeNull();
  });

  it("a Script writer refusal shows the server's words, keeps the box and the prompt as they were", async () => {
    apiFetch.mockImplementation(async (path: string) =>
      path.endsWith("/studio/script") ? res({ error: { code: "plan", message: "Video is not on your plan." } }, 403) : res(EMPTY),
    );
    render(<Hero />);
    await flush();
    fireEvent.change(screen.getByLabelText("Your script"), { target: { value: "keep me" } });
    fireEvent.click(screen.getByRole("button", { name: "Script writer" }));
    fireEvent.change(screen.getByLabelText("Your prompt"), { target: { value: "anything" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Script writer" })).getByRole("button", { name: "Generate" }));
    await flush();
    expect(screen.getByRole("dialog", { name: "Script writer" }).textContent).toContain("Video is not on your plan.");
    expect((screen.getByLabelText("Your script") as HTMLTextAreaElement).value).toBe("keep me");
    expect(screen.getByRole("switch", { name: "Enable prompt" }).getAttribute("aria-checked")).toBe("false");
  });

  it("Image to video cannot Generate from text alone, and going back to Script drops the image", async () => {
    apiFetch.mockImplementation(async (path: string) => (path === "/api/chat/upload-image" ? res({ image_path: "t1/a.jpg" }) : res(EMPTY)));
    render(<Hero />);
    await flush();
    fireEvent.change(screen.getByLabelText("Your script"), { target: { value: "make it move like a dream" } });
    const send = screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    pickImageMode();
    expect(send.disabled).toBe(true);
    expect(screen.queryByRole("switch", { name: "Enable prompt" })).toBeNull();
    fireEvent.change(screen.getByTestId("video-studio-file"), { target: { files: [new File([new Uint8Array([1])], "a.png", { type: "image/png" })] } });
    await flush();
    expect(send.disabled).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: "Script to video" }));
    await flush();
    expect(screen.queryByTestId("video-studio-attachment")).toBeNull();
    fireEvent.click(send);
    await flush();
    const post = apiFetch.mock.calls.find(([p]) => p === "/api/channels/generated_video/studio/messages")!;
    expect(JSON.parse(post[1].body)).toEqual({ text: "make it move like a dream", verbatim: true, new_thread: true });
  });

  it("the mode thumb slides under whichever mode is picked, and only animates after it first lands", async () => {
    const box = (el: HTMLElement) =>
      el.getAttribute("role") !== "radio" ? { l: 0, w: 0 } : el.textContent?.includes("Image") ? { l: 130, w: 140 } : { l: 4, w: 120 };
    const left = vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      return box(this).l;
    });
    const width = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (this: HTMLElement) {
      return box(this).w;
    });
    apiFetch.mockImplementation(async () => res(EMPTY));
    render(<Hero />);
    await flush();
    const thumb = screen.getByTestId("video-studio-mode-thumb");
    expect(thumb.getAttribute("aria-hidden")).toBe("true");
    expect([thumb.style.left, thumb.style.width]).toEqual(["4px", "120px"]);
    expect(thumb.className).not.toContain("transition-[left,width]");
    pickImageMode();
    await flush();
    expect([thumb.style.left, thumb.style.width]).toEqual(["130px", "140px"]);
    expect(thumb.className).toContain("transition-[left,width]");
    fireEvent.click(screen.getByRole("radio", { name: "Script to video" }));
    await flush();
    expect([thumb.style.left, thumb.style.width]).toEqual(["4px", "120px"]);
    left.mockRestore();
    width.mockRestore();
  });

  it("a send the server is still processing is asked again with the SAME key until the real answer arrives, and the ad stays on the page", async () => {
    vi.useFakeTimers();
    try {
      let posts = 0;
      apiFetch.mockImplementation(async (path: string, opts?: { method?: string }) => {
        if (opts?.method === "POST") {
          posts++;
          if (posts < 3) return res({ error: { code: "idempotency_in_progress", message: "still" } }, 409);
          return res({ thread_id: "th-1" });
        }
        return res(EMPTY);
      });
      render(<Hero />);
      await flush();
      fireEvent.change(screen.getByLabelText("Your script"), { target: { value: "a promo for our local gym today" } });
      fireEvent.click(screen.getByRole("button", { name: "Generate" }));
      for (let i = 0; i < 4; i++) await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
      await flush();
      const postCalls = apiFetch.mock.calls.filter(([, o]) => o?.method === "POST");
      expect(postCalls).toHaveLength(3);
      const keys = new Set(postCalls.map(([, o]) => (o.headers as Record<string, string>)["Idempotency-Key"]));
      expect(keys.size).toBe(1);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.getAllByTestId("suggested-ad")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
