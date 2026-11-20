// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ query: "", replace: vi.fn(), api: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/workspace",
  useSearchParams: () => new URLSearchParams(h.query),
  useRouter: () => ({ replace: h.replace }),
}));
vi.mock("next/font/local", () => ({
  default: () => ({ variable: "onboarding-font" }),
}));
vi.mock("@/lib/api", () => ({
  apiFetch: (...args: unknown[]) => h.api(...args),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
  }: {
    href: string;
    children: React.ReactNode;
  }) => <a href={href}>{children}</a>,
}));
import { PastWorkStep } from "./PastWorkStep";
import { PAST_WORK_PROMPT } from "./pastWorkCopy";
const json = (body: unknown, status = 201) =>
  new Response(JSON.stringify(body), { status });
const complete = vi.fn();
const skip = vi.fn();
const refresh = vi.fn();
const props = () => ({
  imports: { files: [], refresh },
  onComplete: complete,
  onSkip: skip,
});
beforeEach(() => {
  h.query = "";
  h.replace.mockReset();
  h.api.mockReset();
  h.api.mockResolvedValue(json({ document: { id: "doc" } }));
  complete.mockReset().mockResolvedValue(null);
  skip.mockReset().mockResolvedValue(null);
  refresh.mockReset().mockResolvedValue(null);
});
afterEach(cleanup);
describe("Past work", () => {
  const choose = (files: File[]) =>
    fireEvent.change(screen.getByLabelText("Choose past-work files"), {
      target: { files },
    });
  it("shows the three steps with an upload at step 3 and no mode switch", () => {
    render(<PastWorkStep {...props()} />);
    expect(
      screen.getByRole("heading", { name: "Bring your past work" }),
    ).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    const steps = screen.getAllByRole("heading", { level: 3 });
    expect(steps).toHaveLength(3);
    expect(steps[2].textContent).toContain("Upload your files");
    expect(
      screen.getByRole("button", { name: /Drop your files here/ }),
    ).toBeTruthy();
    const add = () =>
      screen.getByRole("button", { name: "Add to Zavi" }) as HTMLButtonElement;
    expect(add().disabled).toBe(true);
    choose([new File(["context"], "zavi-context.md")]);
    expect(add().disabled).toBe(false);
  });
  it("keeps a paste option one click away and saves pasted text with any files", async () => {
    h.api.mockImplementation(async () => json({ document: { id: "doc" } }));
    render(<PastWorkStep {...props()} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Or paste text instead" }));
    const add = () => screen.getByRole("button", { name: "Add to Zavi" }) as HTMLButtonElement;
    expect(add().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Paste the answer here" }), {
      target: { value: "Our customers are florists" },
    });
    choose([new File(["pricing"], "pricing.pdf")]);
    fireEvent.click(add());
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    const uploaded = await Promise.all(
      h.api.mock.calls.map(async ([, request]) => {
        const f = (request.body as FormData).get("file") as File;
        const body = await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.readAsText(f);
        });
        return [f.name, body];
      }),
    );
    expect(uploaded).toEqual([
      ["zavi-context.md", "Our customers are florists"],
      ["pricing.pdf", "pricing"],
    ]);
  });
  it("uploads several files before advancing", async () => {
    h.api.mockImplementation(async () => json({ document: { id: "doc" } }));
    render(<PastWorkStep {...props()} />);
    choose([new File(["first"], "zavi-context.md"), new File(["second"], "pricing.pdf")]);
    fireEvent.click(screen.getByRole("button", { name: "Add to Zavi" }));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(h.api).toHaveBeenCalledTimes(2);
    expect(
      h.api.mock.calls.map(([, request]) => ((request.body as FormData).get("file") as File).name),
    ).toEqual(["zavi-context.md", "pricing.pdf"]);
    expect(h.api.mock.calls[0][0]).toBe("/api/personalization/documents?purpose=import");
  });
  it("keeps the chosen files and stays on the step when an upload fails", async () => {
    h.api.mockResolvedValue(
      json({ error: { message: "Upload unavailable" } }, 503),
    );
    render(<PastWorkStep {...props()} />);
    choose([new File(["context"], "zavi-context.md")]);
    fireEvent.click(screen.getByRole("button", { name: "Add to Zavi" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Some files couldn't be added",
    );
    expect(complete).not.toHaveBeenCalled();
    expect(screen.getByText("zavi-context.md")).toBeTruthy();
  });
  it("retries progress saving without uploading the files twice", async () => {
    complete.mockRejectedValueOnce(new Error("Could not save that step"));
    render(<PastWorkStep {...props()} />);
    choose([new File(["context"], "zavi-context.md")]);
    fireEvent.click(screen.getByRole("button", { name: "Add to Zavi" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Add to Zavi" }));
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(h.api).toHaveBeenCalledOnce();
  });
  it("skips without posting an empty document", async () => {
    render(<PastWorkStep {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() => expect(skip).toHaveBeenCalledOnce());
    expect(h.api).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
  it("rejects unsupported, empty, oversized files and cumulative selections above 20", async () => {
    h.query = "pastWork=files";
    render(<PastWorkStep {...props()} />);
    const large = new File(["x"], "large.pdf");
    Object.defineProperty(large, "size", { value: 26 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText("Choose past-work files"), {
      target: {
        files: [new File(["x"], "bad.exe"), new File([], "empty.txt"), large],
      },
    });
    expect(screen.getByRole("alert").textContent).toMatch(
      /bad.exe.*empty.txt.*large.pdf/,
    );
    const files = Array.from(
      { length: 21 },
      (_, i) => new File(["context"], `${i}.md`),
    );
    fireEvent.change(screen.getByLabelText("Choose past-work files"), {
      target: { files },
    });
    expect(screen.getByRole("alert").textContent).toContain("up to 20");
    expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(20);
    expect(h.api).not.toHaveBeenCalled();
  });
  it("caps files across separate selections, not just per drop", () => {
    render(<PastWorkStep {...props()} />);
    const batch = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => new File(["context"], `${from + i}.md`));
    fireEvent.change(screen.getByLabelText("Choose past-work files"), { target: { files: batch(0, 15) } });
    expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(15);
    fireEvent.change(screen.getByLabelText("Choose past-work files"), { target: { files: batch(15, 6) } });
    expect(screen.getByRole("alert").textContent).toContain("up to 20");
    expect(screen.getAllByRole("button", { name: /^Remove/ })).toHaveLength(20);
  });
  it("handles partial uploads and only retries unsuccessful files", async () => {
    h.query = "pastWork=files";
    h.api
      .mockResolvedValueOnce(json({ document: { id: "first" } }))
      .mockResolvedValueOnce(json({ error: { message: "Try again" } }, 500))
      .mockResolvedValueOnce(json({ document: { id: "second" } }));
    render(<PastWorkStep {...props()} />);
    fireEvent.drop(
      screen.getByRole("button", { name: /Drop your files here/ }),
      {
        dataTransfer: {
          files: [
            new File(["first"], "first.md"),
            new File(["second"], "second.pdf"),
          ],
        },
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Add to Zavi" }),
    );
    await screen.findByRole("alert");
    expect(complete).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Add to Zavi" }),
    );
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect(h.api).toHaveBeenCalledTimes(3);
    expect(
      ((h.api.mock.calls[2][1].body as FormData).get("file") as File).name,
    ).toBe("second.pdf");
  });
  it("restores server-saved knowledge after a reload and can continue without another upload", async () => {
    render(
      <PastWorkStep
        {...props()}
        imports={{
          refresh,
          files: [
            {
              id: "saved",
              filename: "zavi-context.md",
              created_at: "2026-10-18T00:00:00Z",
              status: "reading",
              facts: 0,
              redactions: 0,
              truncated: false,
              unclaimed: true,
            },
          ],
        }}
      />,
    );
    expect(
      screen.getByText(/zavi-context.md: Reading in the background/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Add to Zavi" }),
    );
    await waitFor(() => expect(complete).toHaveBeenCalled());
    expect(h.api).not.toHaveBeenCalled();
  });
  it("copies the full prompt and announces a clipboard error when copying fails", async () => {
    const copy = vi.fn().mockResolvedValue(null);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    render(<PastWorkStep {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(copy).toHaveBeenCalledWith(PAST_WORK_PROMPT);
    copy.mockRejectedValueOnce(new Error("Denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Couldn't copy"),
    );
    for (const name of ["Claude", "ChatGPT", "Gemini", "Codex"])
      expect(
        screen
          .getByRole("link", { name: `${name} (opens in a new tab)` })
          .getAttribute("rel"),
      ).toContain("noopener");
  });
  it("keeps the same markup through hydration and disables animation for reduced motion", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const p = props();
    const html = renderToString(<PastWorkStep {...p} />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const server = container.cloneNode(true);
    let root: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, <PastWorkStep {...p} />);
    });
    expect(container.isEqualNode(server)).toBe(true);
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(
      /hydrat|did not match/i,
    );
    expect(
      container.querySelector(".motion-reduce\\:animate-none"),
    ).toBeTruthy();
    expect(
      within(container).getByRole("button", { name: "Skip" }),
    ).toBeTruthy();
    await act(async () => root.unmount());
    container.remove();
    errors.mockRestore();
  });
});
