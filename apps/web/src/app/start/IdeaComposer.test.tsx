// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IdeaComposer } from "./IdeaComposer";
import { ideaBackHref } from "./ideaBackHref";

type Handler = ((event: { results: { 0: { transcript: string } }[] }) => void) | null;
let lastRecognition: FakeRecognition | null = null;

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: Handler = null;
  onend: (() => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => this.onend?.());
  abort = vi.fn(() => this.onend?.());
  constructor() {
    lastRecognition = this;
  }
}

function Harness({ initial = "", ready = false, onSubmit = () => {} }: { initial?: string; ready?: boolean; onSubmit?: () => void }) {
  const [idea, setIdea] = useState(initial);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <IdeaComposer
        idea={idea}
        onIdeaChange={setIdea}
        ideaRef={createRef<HTMLTextAreaElement>()}
        ready={ready}
        ctaLabel="Build it"
        onSubmit={onSubmit}
        attach={null}
        images={[]}
      />
      <button type="button" onClick={() => setIdea("A bakery website")}>
        Pick example
      </button>
    </form>
  );
}

afterEach(() => {
  cleanup();
  lastRecognition = null;
  delete (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition;
});

describe("ideaBackHref", () => {
  it("returns to the website step and keeps the other params", () => {
    expect(ideaBackHref("step=idea")).toBe("/start");
    expect(ideaBackHref("step=idea&new=1&utm_source=x")).toBe("/start?new=1&utm_source=x");
    expect(ideaBackHref("resume=build&from=home")).toBe("/start?from=home");
  });
});

describe("IdeaComposer", () => {
  it("labels the round send button with the CTA and disables it until the idea is ready", () => {
    render(<Harness />);
    expect((screen.getByRole("button", { name: "Build it" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const onSubmit = vi.fn();
    render(<Harness initial="A site for my bakery" ready onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole("button", { name: "Build it" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("hides the image button when attaching is off and the mic when the browser cannot dictate", () => {
    render(<Harness />);
    expect(screen.queryByRole("button", { name: "Add images" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dictate your idea" })).toBeNull();
  });

  it("appends dictated words after what was already typed, then stops", () => {
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognition;
    render(<Harness initial="A bakery site" />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate your idea" }));
    expect(lastRecognition?.start).toHaveBeenCalled();
    act(() => {
      lastRecognition?.onresult?.({ results: [{ 0: { transcript: "with a menu" } }, { 0: { transcript: " and opening hours" } }] });
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("A bakery site with a menu and opening hours");
    fireEvent.click(screen.getByRole("button", { name: "Stop dictation" }));
    expect(lastRecognition?.stop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Dictate your idea" })).toBeTruthy();
  });

  it("ends dictation when the founder types, so speech never overwrites an edit", () => {
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognition;
    render(<Harness initial="A bakery site" />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate your idea" }));
    const live = lastRecognition;
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "A cake shop site" } });
    expect(live?.abort).toHaveBeenCalled();
    act(() => {
      live?.onresult?.({ results: [{ 0: { transcript: "with a menu" } }] });
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("A cake shop site");
    expect(screen.getByRole("button", { name: "Dictate your idea" })).toBeTruthy();
  });

  it("ends dictation when a template or example replaces the idea", () => {
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognition;
    render(<Harness initial="A cake shop" />);
    fireEvent.click(screen.getByRole("button", { name: "Dictate your idea" }));
    const live = lastRecognition;
    act(() => {
      live?.onresult?.({ results: [{ 0: { transcript: "with a menu" } }] });
    });
    expect(live?.abort).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pick example" }));
    expect(live?.abort).toHaveBeenCalled();
    act(() => {
      live?.onresult?.({ results: [{ 0: { transcript: "with a menu and prices" } }] });
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("A bakery website");
  });
});
