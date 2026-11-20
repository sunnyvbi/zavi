// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import {
  PICKER_SLOT_CLASS,
  PreviewLoadingScreen,
  WAITING_ACTIONS_CLASS,
  WAITING_BAR_WIDTH_CLASS,
  WAITING_BODY_CLASS,
  WAITING_CARD_CLASS,
  WAITING_MEDIA_CLASS,
  WAITING_METER_CLASS,
  WebsiteBuildProgress,
} from "./WebsiteBuildProgress";
import { PreviewStoppedScreen } from "./PreviewStoppedScreen";
import { AppStartingScreen, StillBuildingScreen } from "./WebsitePreview";
import type { BuildStageRow } from "@/lib/workspace/useBuildPreview";

vi.mock("lottie-web", () => ({ default: { loadAnimation: () => ({ destroy: () => {} }) } }));
vi.mock("@/lib/api", () => ({ apiFetch: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MIN = 60_000;
const T0 = Date.parse("2026-10-07T08:00:00Z");
const RUNNING: BuildStageRow[] = [
  { stage: "provision", status: "done" },
  { stage: "spec", status: "done" },
  { stage: "scaffold", status: "running", started_at: new Date(T0).toISOString(), expected_ms: 10 * MIN },
];

const STATES: Array<[string, () => ReactElement<any>]> = [
  ["coffee", () => <WebsiteBuildProgress stages={RUNNING} failure={null} failed={false} runId="r" />],
  ["publishing", () => <WebsiteBuildProgress stages={RUNNING} failure={null} failed={false} publish="publishing" />],
  ["publish failed", () => <WebsiteBuildProgress stages={RUNNING} failure={null} failed={false} publish="failed-retry" />],
  ["build failed", () => <WebsiteBuildProgress stages={RUNNING} failure={{ class: "internal", message: "x", stage: "scaffold" }} failed />],
  ["preview starting", () => <PreviewStoppedScreen starting error={null} onRestart={() => undefined} />],
  ["preview stopped", () => <PreviewStoppedScreen starting={false} error="nope" onRestart={() => undefined} />],
  ["app loading", () => <AppStartingScreen state="loading" openUrl={null} onRetry={() => undefined} />],
  ["app waking", () => <AppStartingScreen state="checking" openUrl={null} onRetry={() => undefined} />],
  ["app paused", () => <AppStartingScreen state="suspended" openUrl="https://x.example" onRetry={() => undefined} />],
  ["still building", () => <StillBuildingScreen />],
];

const slot = (card: Element, name: string) => card.querySelector(`[data-waiting-slot="${name}"]`) as HTMLElement | null;

const RESERVED = /\bmin-h-|\bh-\d|\binvisible\b/;

function reservedRows(card: Element): string[] {
  const hits: string[] = [];
  if (RESERVED.test(card.className)) hits.push(`card: ${card.className}`);
  for (const el of Array.from(card.querySelectorAll("[data-waiting-slot], [data-waiting-note]"))) {
    if (RESERVED.test(el.className)) hits.push(`${el.getAttribute("data-waiting-slot") ?? el.getAttribute("data-waiting-note")}: ${el.className}`);
    if (el.getAttribute("aria-hidden") === "true") hits.push(`${el.getAttribute("data-waiting-slot")}: aria-hidden`);
    if (el.matches("[data-waiting-slot]") && !el.matches('[data-waiting-slot="media"]') && (el.textContent ?? "").trim() === "" && !el.querySelector('[role="progressbar"]')) {
      hits.push(`${el.getAttribute("data-waiting-slot")}: empty`);
    }
  }
  return hits;
}

describe("every waiting state is one compact card that hugs its content", () => {
  it.each(STATES)("%s: shared shell, equal top and bottom padding, no reserved or empty rows", (_name, el) => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { container } = render(el());
    const cards = container.querySelectorAll("[data-waiting-card]");
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.className).toBe(WAITING_CARD_CLASS);
    expect(card.className).not.toMatch(/min-h-|justify-center/);
    expect(card.className).toMatch(/\bpy-8\b/);
    expect(card.className).not.toMatch(/\b(pt|pb)-/);
    expect(slot(card, "media")?.className).toBe(WAITING_MEDIA_CLASS);
    expect(slot(card, "body")?.className).toBe(WAITING_BODY_CLASS);
    expect(slot(card, "body")?.className).toMatch(/\btext-balance\b/);
    expect(card.querySelector("h2")?.className).toMatch(/\btext-balance\b/);
    expect(reservedRows(card)).toEqual([]);
    const last = card.lastElementChild as HTMLElement;
    expect(["body", "actions"]).toContain(last.getAttribute("data-waiting-slot"));
    expect(container.querySelector('[data-testid="waiting-field"]')?.className).toMatch(/max-w-\[1040px\]/);
  });

  it("a card with a bar puts the same gap above the bar as below it, and keeps the line narrow, and the bar as wide as the percentage bar", () => {
    for (const el of [
      <PreviewLoadingScreen key="a" />,
      <AppStartingScreen key="b" state="loading" openUrl={null} onRetry={() => undefined} />,
      <AppStartingScreen key="c" state="checking" openUrl={null} onRetry={() => undefined} />,
      <StillBuildingScreen key="d" />,
    ]) {
      const { container, unmount } = render(el);
      const card = container.querySelector("[data-waiting-card]")!;
      const meter = slot(card, "meter")!;
      expect(meter.className).toBe(WAITING_METER_CLASS);
      expect(meter.nextElementSibling).toBe(slot(card, "body"));
      const gapAbove = Number(/\bmt-(\d+)\b/.exec(meter.className)![1]);
      const gapBelow = Number(/\bmt-(\d+)\b/.exec(slot(card, "body")!.className)![1]);
      expect(Math.abs(gapAbove - gapBelow)).toBeLessThanOrEqual(1);
      const bar = meter.querySelector('[role="progressbar"]')!;
      expect(bar.className).toContain(WAITING_BAR_WIDTH_CLASS);
      expect(Number(/max-w-\[(\d+)px\]/.exec(slot(card, "body")!.className)![1])).toBeLessThan(460);
      unmount();
    }
  });
});

describe("the Starting your preview card", () => {
  it("stacks headline straight onto a balanced body line, with no empty meter, notes or actions rows between or after", () => {
    const { container } = render(<PreviewStoppedScreen starting error={null} onRestart={() => undefined} />);
    const card = container.querySelector("[data-waiting-card]")!;
    expect(screen.getByRole("heading").textContent).toBe("Starting your preview");
    expect(slot(card, "headline")!.nextElementSibling).toBe(slot(card, "body"));
    expect(slot(card, "meter")).toBeNull();
    expect(slot(card, "notes")).toBeNull();
    expect(slot(card, "actions")).toBeNull();
    expect(slot(card, "body")!.textContent).toBe("This usually takes a minute or two. Your app opens here as soon as it's ready.");
    expect(slot(card, "body")!.className).toMatch(/\btext-balance\b/);
    expect(slot(card, "headline")!.className).not.toMatch(/min-h-/);
  });
});

describe("optional rows appear only when they apply", () => {
  it("the retry and slow notes are absent until they apply, then show as a status line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { container } = render(<WebsiteBuildProgress stages={RUNNING} failure={null} failed={false} runId="r" />);
    expect(container.querySelector("[data-waiting-note]")).toBeNull();
    expect(slot(container.querySelector("[data-waiting-card]")!, "notes")).toBeNull();
    expect(screen.queryByTestId("build-progress-slow")).toBeNull();
    expect(screen.queryByTestId("build-progress-retry")).toBeNull();
    act(() => void vi.advanceTimersByTime(60 * MIN));
    expect(screen.getByTestId("build-progress-slow").className).not.toMatch(/\binvisible\b/);
    expect(screen.getByTestId("build-progress-slow").getAttribute("role")).toBe("status");
    expect(container.querySelector("[data-waiting-note='retry']")).toBeNull();
  });

  it("a card shows its buttons row only when it has buttons", () => {
    for (const el of [
      <PreviewStoppedScreen key="a" starting error={null} onRestart={() => undefined} />,
      <AppStartingScreen key="b" state="loading" openUrl={null} onRetry={() => undefined} />,
    ]) {
      const { container, unmount } = render(el);
      expect(slot(container.querySelector("[data-waiting-card]")!, "actions")).toBeNull();
      expect(container.querySelector("button")).toBeNull();
      unmount();
    }
    const { container } = render(<PreviewStoppedScreen starting={false} error={null} onRestart={() => undefined} />);
    const actions = slot(container.querySelector("[data-waiting-card]")!, "actions")!;
    expect(actions.className).toBe(WAITING_ACTIONS_CLASS);
    expect(actions.querySelector("button")?.textContent).toMatch(/Restart preview/);
  });

  it("an icon state and a Lottie state share one media slot class that sizes to its content", () => {
    const a = render(<PreviewStoppedScreen starting error={null} onRestart={() => undefined} />);
    const lottieSlot = slot(a.container.querySelector("[data-waiting-card]")!, "media")!;
    expect(lottieSlot.querySelector('[data-testid="build-lottie"]')).not.toBeNull();
    const lottieClass = lottieSlot.className;
    a.unmount();
    const b = render(<PreviewStoppedScreen starting={false} error={null} onRestart={() => undefined} />);
    const iconSlot = slot(b.container.querySelector("[data-waiting-card]")!, "media")!;
    expect(iconSlot.querySelector("svg")).not.toBeNull();
    expect(iconSlot.className).toBe(lottieClass);
    expect(iconSlot.className).not.toMatch(/\bh-\d/);
  });
});

describe("the look picker", () => {
  it("holds a fixed-height skeleton where the picker goes until the looks arrive", () => {
    const view = render(<WebsiteBuildProgress stages={RUNNING} failure={null} failed={false} awaitingPick picker={null} />);
    const frame = screen.getByTestId("look-picker-slot-frame");
    expect(frame.className).toBe(PICKER_SLOT_CLASS);
    expect(frame.className).toMatch(/min-h-\[360px\]/);
    expect(screen.getByTestId("look-picker-skeleton")).toBeTruthy();
    view.rerender(
      <WebsiteBuildProgress stages={RUNNING} failure={null} failed={false} awaitingPick picker={<div data-testid="picker">looks</div>} />,
    );
    expect(screen.getByTestId("look-picker-slot-frame")).toBe(frame);
    expect(screen.queryByTestId("look-picker-skeleton")).toBeNull();
    expect(screen.getByTestId("picker")).toBeTruthy();
  });

  it("the pick view and the coffee card share one outer width, so the switch does not jump sideways", () => {
    const view = render(<WebsiteBuildProgress stages={RUNNING} failure={null} failed={false} awaitingPick picker={null} />);
    const pickField = screen.getByTestId("waiting-field").className;
    view.rerender(<WebsiteBuildProgress stages={RUNNING} failure={null} failed={false} />);
    expect(screen.getByTestId("waiting-field").className).toBe(pickField);
  });
});

describe("the waiting card keeps one height whether its line wraps to one, two or three lines", () => {
  const LH = 22.4;
  const realGCS = window.getComputedStyle;
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  let bodyLines = 1;
  beforeEach(() => {
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element, p?: string | null) => {
      const cs = realGCS(el, p);
      if ((el as HTMLElement).getAttribute?.("data-waiting-slot") === "body") {
        return new Proxy(cs, { get: (t, k) => (k === "lineHeight" ? `${LH}px` : Reflect.get(t, k)) }) as CSSStyleDeclaration;
      }
      return cs;
    });
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.getAttribute("data-waiting-slot") === "body") return { height: bodyLines * LH, width: 400, top: 0, left: 0, right: 400, bottom: bodyLines * LH, x: 0, y: 0, toJSON() {} } as DOMRect;
      return realRect.call(this);
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    HTMLElement.prototype.getBoundingClientRect = realRect;
  });

  it.each([
    [1, 32 + LH],
    [2, 32 + LH / 2],
    [3, null],
  ])("%i line(s): the text sits right under the bar and the spare room goes to the card's top and bottom", (n, pad) => {
    bodyLines = n as number;
    const { container } = render(<PreviewLoadingScreen />);
    const card = container.querySelector("[data-waiting-card]") as HTMLElement;
    expect(card.getAttribute("data-body-lines")).toBe(String(n));
    const body = slot(card, "body")!;
    expect(body.className).not.toMatch(/min-h-|justify-center/);
    if (pad === null) {
      expect(card.style.paddingTop).toBe("");
      expect(card.style.paddingBottom).toBe("");
    } else {
      expect(parseFloat(card.style.paddingTop)).toBeCloseTo(pad as number, 5);
      expect(card.style.paddingBottom).toBe(card.style.paddingTop);
    }
    const extra = 2 * (pad === null ? 32 : (pad as number)) + (n as number) * LH;
    expect(extra).toBeCloseTo(2 * 32 + 3 * LH, 5);
  });
});
