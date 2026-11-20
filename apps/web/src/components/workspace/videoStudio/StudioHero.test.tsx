// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef, useState } from "react";
import { ApiError } from "@/lib/workspace/channelActionsApi";
import { StudioHero, type HeroEditing } from "./StudioHero";

afterEach(() => {
  cleanup();
  const w = window as unknown as Record<string, unknown>;
  delete w.SpeechRecognition;
  delete w.webkitSpeechRecognition;
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

type Props = {
  initial?: string;
  onSubmit?: (o: { verbatim: boolean; revise?: boolean }) => void;
  onLoadPrompt?: () => Promise<string>;
  onWriteScript?: (p: string) => Promise<string>;
  editing?: HeroEditing | null;
  withAttach?: boolean;
};

function Harness({ initial = "", onSubmit = () => {}, onLoadPrompt, onWriteScript, editing = null, withAttach = false }: Props) {
  const [text, setText] = useState(initial);
  return (
    <StudioHero
      text={text}
      setText={setText}
      sending={false}
      attachment={null}
      attachError={null}
      onAttach={withAttach ? () => {} : undefined}
      onRemoveAttachment={() => {}}
      onSubmit={onSubmit}
      onLoadPrompt={onLoadPrompt}
      onWriteScript={onWriteScript}
      editing={editing}
    />
  );
}

const generate = () => screen.getAllByRole("button", { name: /^Generate$/ }).slice(-1)[0] as HTMLButtonElement;
const box = () => screen.getByLabelText("Your script") as HTMLTextAreaElement;
const type = (v: string) => fireEvent.change(box(), { target: { value: v } });

describe("StudioHero script length gate (4268)", () => {
  it("keeps Generate off and explains why until a word-for-word script has 6 to 150 words", () => {
    const sent: Array<{ verbatim: boolean }> = [];
    render(<Harness onSubmit={(o) => sent.push(o)} />);
    type("Buy now please");
    expect(generate().disabled).toBe(true);
    expect(screen.getByTestId("video-studio-length-hint").textContent).toBe("A word-for-word script needs 6 to 150 words. This one has 3.");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(sent).toEqual([]);
    type("one two three four five six");
    expect(generate().disabled).toBe(false);
    expect(screen.queryByTestId("video-studio-length-hint")).toBeNull();
    type(Array.from({ length: 151 }, () => "w").join(" "));
    expect(generate().disabled).toBe(true);
    expect(screen.getByTestId("video-studio-length-hint").textContent).toContain("This one has 151.");
    type(Array.from({ length: 150 }, () => "w").join(" "));
    expect(generate().disabled).toBe(false);
    fireEvent.click(generate());
    expect(sent).toEqual([{ verbatim: true }]);
  });

  it("does not apply the word rule once Zavi writes the script from a prompt", async () => {
    render(<Harness onLoadPrompt={async () => "x"} />);
    fireEvent.click(screen.getByRole("switch", { name: "Enable prompt" }));
    await flush();
    type("short idea");
    expect(generate().disabled).toBe(false);
    expect(screen.queryByTestId("video-studio-length-hint")).toBeNull();
  });
});

describe("StudioHero leaving an edit (80b7)", () => {
  it("Cancel edit calls onClear, and is absent when the parent gives no way out", () => {
    const onClear = vi.fn();
    const { rerender } = render(<Harness editing={{ title: "Planner ad", onClear }} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel edit" }));
    expect(onClear).toHaveBeenCalledTimes(1);
    rerender(<Harness editing={{ title: "Planner ad" }} />);
    expect(screen.queryByRole("button", { name: "Cancel edit" })).toBeNull();
  });
});

describe("StudioHero prompt that cannot be written (9669)", () => {
  it("shows a message and switches the toggle back off instead of leaving it on with an empty box", async () => {
    render(<Harness onLoadPrompt={async () => { throw new Error("boom"); }} />);
    const toggle = screen.getByRole("switch", { name: "Enable prompt" });
    fireEvent.click(toggle);
    await flush();
    expect(screen.getByTestId("video-studio-prompt-error").textContent).toMatch(/could not write a prompt/);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(box().value).toBe("");
    fireEvent.click(toggle);
    expect(screen.queryByTestId("video-studio-prompt-error")).toBeNull();
  });
});

describe("StudioHero Undo (f429)", () => {
  it("drops Undo once the founder edits the script Zavi wrote, so it cannot discard those edits", async () => {
    const wm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })) as never;
    try {
      render(<Harness initial="my own words here" onWriteScript={async () => "Zavi wrote this whole script for you"} />);
      fireEvent.click(screen.getByRole("button", { name: "Script writer" }));
      fireEvent.change(screen.getByLabelText("Your prompt"), { target: { value: "serum ad" } });
      fireEvent.click(within(screen.getByRole("dialog", { name: "Script writer" })).getByRole("button", { name: "Generate" }));
      await flush();
      expect(box().value).toBe("Zavi wrote this whole script for you");
      expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
      type("Zavi wrote this whole script for you, plus my edit");
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    } finally {
      window.matchMedia = wm;
    }
  });
});

describe("StudioHero image copy (1505)", () => {
  it("names every accepted format and the size limit", () => {
    render(<Harness withAttach />);
    fireEvent.click(screen.getByRole("radio", { name: "Image to video" }));
    expect(screen.getByText("A photo of your product, car or place. PNG, JPEG or WebP, up to 5 MB.")).toBeTruthy();
    expect(screen.queryByText(/JPG or PNG/)).toBeNull();
  });
});

describe("StudioHero mic reason (dc81)", () => {
  it("shows why dictation failed as visible text beside the box, not only in a tooltip", async () => {
    class Fake {
      continuous = false;
      interimResults = false;
      lang = "";
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      onstart: (() => void) | null = null;
      start = vi.fn(() => {
        this.onerror?.({ error: "not-allowed" });
        this.onend?.();
      });
      stop = vi.fn();
      abort = vi.fn();
    }
    const w = window as unknown as Record<string, unknown>;
    w.SpeechRecognition = Fake;
    w.webkitSpeechRecognition = Fake;
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Start dictation" }));
    await flush();
    expect(screen.getByTestId("dictation-error").textContent).toMatch(/Microphone permission denied/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel voice input" }));
    await flush();
    const alert = screen.getAllByRole("alert").find((a) => /Microphone permission denied/.test(a.textContent ?? ""));
    expect(alert).toBeTruthy();
  });
});

describe("StudioHero script writer popover (8217)", () => {
  const open = () => {
    render(<Harness onWriteScript={async () => "a b c d e f"} />);
    const trigger = screen.getByRole("button", { name: "Script writer" });
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Script writer" })).toBeTruthy();
    return trigger;
  };

  it("closes on a touch/pointer tap outside, which iOS sends instead of mousedown", () => {
    open();
    fireEvent.pointerDown(box());
    expect(screen.queryByRole("dialog", { name: "Script writer" })).toBeNull();
  });

  it("stays open for a tap inside it", () => {
    open();
    fireEvent.pointerDown(screen.getByLabelText("Your prompt"));
    expect(screen.getByRole("dialog", { name: "Script writer" })).toBeTruthy();
  });

  it("Escape returns focus to the Script writer button, not the script box", () => {
    const trigger = open();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Script writer" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe("StudioHero revision chips (81da)", () => {
  it("shows Make it shorter and Different presenter only on a ready edit, and each sends its line as a request, not a script", () => {
    const sent: Array<{ verbatim: boolean; text: string }> = [];
    let current = "";
    function Probe({ ready }: { ready: boolean }) {
      const [text, setText] = useState("");
      current = text;
      return (
        <StudioHero
          text={text}
          setText={setText}
          sending={false}
          attachment={null}
          attachError={null}
          onRemoveAttachment={() => {}}
          onSubmit={(o) => sent.push({ ...o, text: current })}
          editing={{ title: "Planner ad", ready }}
        />
      );
    }
    const { rerender } = render(<Probe ready={false} />);
    expect(screen.queryByRole("button", { name: "Make it shorter" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Different presenter" })).toBeNull();
    rerender(<Probe ready />);
    fireEvent.click(screen.getByRole("button", { name: "Make it shorter" }));
    fireEvent.click(screen.getByRole("button", { name: "Different presenter" }));
    expect(sent.map((s) => s.verbatim)).toEqual([false, false]);
    expect(box().value).toBe("Use a different presenter");
  });

  it("a chip marks its send as a revision even with an image staged or still uploading, so the image is never attached to it", () => {
    const sent: Array<{ verbatim: boolean; revise?: boolean }> = [];
    function Probe({ path }: { path: string | null }) {
      const [text, setText] = useState("");
      return (
        <StudioHero
          text={text}
          setText={setText}
          sending={false}
          attachment={{ path, preview: null }}
          attachError={null}
          onAttach={() => {}}
          onRemoveAttachment={() => {}}
          onSubmit={(o) => sent.push(o)}
          editing={{ title: "Planner ad", ready: true }}
        />
      );
    }
    const { rerender } = render(<Probe path="uploads/car.png" />);
    fireEvent.click(screen.getByRole("button", { name: "Make it shorter" }));
    rerender(<Probe path={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Different presenter" }));
    expect(sent).toEqual([
      { verbatim: false, revise: true },
      { verbatim: false, revise: true },
    ]);
  });
});

describe("StudioHero script writer races and errors (41db, dd50)", () => {
  const open = async (onWriteScript: (p: string) => Promise<string>, onSubmit?: (o: { verbatim: boolean; revise?: boolean }) => void) => {
    render(<Harness initial="my own words here" onWriteScript={onWriteScript} onSubmit={onSubmit} onLoadPrompt={async () => "loaded prompt"} withAttach />);
    fireEvent.click(screen.getByRole("button", { name: "Script writer" }));
    fireEvent.change(screen.getByLabelText("Your prompt"), { target: { value: "serum ad" } });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Script writer" })).getByRole("button", { name: "Generate" }));
  };

  it("does not put a script into the Image to video box when the founder switched modes while it was writing", async () => {
    let resolve!: (s: string) => void;
    await open(() => new Promise<string>((r) => (resolve = r)));
    fireEvent.click(screen.getByRole("radio", { name: "Image to video" }));
    resolve("Zavi wrote this whole script for you");
    await flush();
    expect(screen.queryByDisplayValue("Zavi wrote this whole script for you")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Script to video" }));
    expect(box().value).toBe("Zavi wrote this whole script for you");
    expect(screen.getByRole("switch", { name: "Enable prompt" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(box().value).toBe("my own words here");
  });

  it("turns prompt mode off for a script written while the founder was in Image to video, so Make sends it word for word", async () => {
    const sent: Array<{ verbatim: boolean; revise?: boolean }> = [];
    let resolve!: (s: string) => void;
    await open(() => new Promise<string>((r) => (resolve = r)), (o) => sent.push(o));
    fireEvent.click(screen.getByRole("switch", { name: "Enable prompt" }));
    await flush();
    expect(screen.getByRole("switch", { name: "Enable prompt" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Image to video" }));
    resolve("Zavi wrote this whole script for you right now");
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: "Script to video" }));
    expect(box().value).toBe("Zavi wrote this whole script for you right now");
    expect(screen.getByRole("switch", { name: "Enable prompt" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(generate());
    expect(sent).toEqual([{ verbatim: true }]);
  });

  it("shows the plain sentence, not the raw server text, when the writer fails", async () => {
    await open(() => Promise.reject(new ApiError("upstream 502: bad gateway at pod-7f", 502)));
    await flush();
    expect(screen.getByText("The script could not be written. Try again.")).toBeTruthy();
    expect(screen.queryByText(/pod-7f/)).toBeNull();
  });

  it("keeps the connection message when the writer could not reach Zavi", async () => {
    await open(() => Promise.reject(new Error("Could not reach Zavi. Check your connection.")));
    await flush();
    expect(screen.getByText("Could not reach Zavi. Check your connection.")).toBeTruthy();
    expect(screen.queryByText("The script could not be written. Try again.")).toBeNull();
  });
});

describe("StudioHero editing row", () => {
  function Harness({ ready, sent }: { ready: boolean; sent: Array<{ text: string; verbatim: boolean }> }) {
    const [text, setText] = useState("");
    const textRef = useRef(text);
    const set = (t: string) => {
      textRef.current = t;
      setText(t);
    };
    return (
      <StudioHero
        text={text}
        setText={set}
        sending={false}
        attachment={null}
        attachError={null}
        onRemoveAttachment={() => {}}
        onSubmit={({ verbatim }) => sent.push({ text: textRef.current, verbatim })}
        editing={{ title: "Planner ad", ready }}
      />
    );
  }

  it("shows what is being edited, and offers the quick edits only once that video is ready", () => {
    const sent: Array<{ text: string; verbatim: boolean }> = [];
    const { rerender } = render(<Harness ready={false} sent={sent} />);
    expect(screen.getByTestId("video-studio-editing").textContent).toBe("Editing “Planner ad”");
    expect(screen.queryByRole("button", { name: "Make it shorter" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Different presenter" })).toBeNull();
    rerender(<Harness ready sent={sent} />);
    fireEvent.click(screen.getByRole("button", { name: "Make it shorter" }));
    fireEvent.click(screen.getByRole("button", { name: "Different presenter" }));
    expect(sent).toEqual([
      { text: "Make it shorter", verbatim: false },
      { text: "Use a different presenter", verbatim: false },
    ]);
  });
});
