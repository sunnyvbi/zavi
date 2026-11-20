// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { LOTTIE_RELEASE_MS, WebsiteBuildProgress } from "./WebsiteBuildProgress";
import { PreviewStoppedScreen } from "./PreviewStoppedScreen";
import type { BuildStageRow } from "@/lib/workspace/useBuildPreview";
import buildLoaderAnimation from "@/assets/build-loader.json";

const { destroyAnimation, loadAnimation } = vi.hoisted(() => ({
  destroyAnimation: vi.fn(),
  loadAnimation: vi.fn(),
}));

vi.mock("lottie-web", () => ({
  default: {
    loadAnimation: (...args: unknown[]) => {
      loadAnimation(...args);
      return { destroy: destroyAnimation };
    },
  },
}));

const STAGES: BuildStageRow[] = [
  { stage: "provision", status: "done" },
  { stage: "spec", status: "done" },
  { stage: "scaffold", status: "running" },
  { stage: "build", status: "pending" },
  { stage: "qa", status: "pending" },
];

const building = (stages: BuildStageRow[] = STAGES) =>
  renderToStaticMarkup(
    <WebsiteBuildProgress stages={stages} failure={null} failed={false} />,
  );

afterEach(() => {
  cleanup();
  loadAnimation.mockClear();
  destroyAnimation.mockClear();
});

describe("WebsiteBuildProgress — the build loader", () => {
  it("uses the reference mint, cyan, pink, and black palette", () => {
    const serialized = JSON.stringify(buildLoaderAnimation);
    expect(serialized).toContain('"k":[0.9451,0.3569,0.7098,1]');
    expect(serialized).toContain('"k":[0,0.7333,0.9765,1]');
    expect(serialized).toContain('"k":[0,0.9608,0.8314,1]');
    expect(serialized).toContain('"k":[0,0,0,1]');
    expect(serialized).not.toContain('"k":[0.1938,0.3449,0.4862,1]');
    expect(serialized).not.toContain('"k":[0.0039,0.6157,0.5686,1]');
    expect(serialized).not.toContain('"k":[0.0314,0.3412,0.6275,1]');
  });

  it("loops the supplied Lottie only inside the icon container, and lets it go once nothing shows it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = render(
      <WebsiteBuildProgress stages={STAGES} failure={null} failed={false} />,
    );
    const icon = screen.getByTestId("build-lottie");

    await waitFor(() => {
      expect(loadAnimation).toHaveBeenCalledWith(
        expect.objectContaining({
          container: icon.firstElementChild,
          renderer: "svg",
          loop: true,
          autoplay: true,
          animationData: expect.objectContaining({
            nm: "Main Scene",
            fr: 30,
          }),
        }),
      );
    });

    unmount();
    expect(destroyAnimation).not.toHaveBeenCalled();
    vi.advanceTimersByTime(LOTTIE_RELEASE_MS);
    expect(destroyAnimation).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("keeps one running animation across card swaps: no reload, no restart, drawn in the first paint of the next card", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const first = render(<WebsiteBuildProgress stages={STAGES} failure={null} failed={false} />);
    await waitFor(() => expect(loadAnimation).toHaveBeenCalledTimes(1));
    const drawn = screen.getByTestId("build-lottie").firstElementChild;
    first.unmount();
    render(<PreviewStoppedScreen starting error={null} onRestart={() => undefined} />);
    expect(screen.getByTestId("build-lottie").firstElementChild).toBe(drawn);
    vi.advanceTimersByTime(LOTTIE_RELEASE_MS * 3);
    expect(loadAnimation).toHaveBeenCalledTimes(1);
    expect(destroyAnimation).not.toHaveBeenCalled();
    cleanup();
    vi.advanceTimersByTime(LOTTIE_RELEASE_MS);
    expect(destroyAnimation).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("shows the running build instead of an invitation to type a URL", () => {
    const html = building();
    expect(html).toContain("Have a coffee, or<br/>take a break");
    expect(html).toContain("we&#x27;ll let you know the moment it&#x27;s live");
    expect(html).not.toContain("Enter a URL");
  });

  it("promises an early live preview and a later publish, with no made-up time when the stages carry no budgets", () => {
    const html = building();
    expect(html).toContain("once your site is fully built");
    expect(html).toContain("Publishing it to your live address comes after");
    expect(html).not.toContain("few minutes");
    expect(html).not.toContain("minutes left");
    expect(html).not.toContain("20 minutes");
    expect(html).not.toContain("\u2014");
  });

  it("does not animate the heading, progress bar, or loading card", () => {
    const html = building();
    expect(html).not.toContain("animate-");
    expect(html).not.toContain("transition-");
  });

  it("renders the REAL stage-derived percentage, in both the bar and the label", () => {
    const html = building();
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain("50%");
    expect(html).toContain("width:50%");
  });

  it("starts at 0% and reaches 100% rather than stalling short", () => {
    const pending = STAGES.map((s) => ({ ...s, status: "pending" }));
    expect(building(pending)).toContain('aria-valuenow="0"');

    const done = STAGES.map((s) => ({ ...s, status: "done" }));
    const html = building(done);
    expect(html).toContain('aria-valuenow="100"');
    expect(html).toContain("100%");
  });

  it("announces itself politely to a screen reader while building", () => {
    const html = building();
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
  });

  it("explains a build that stopped instead of showing the loader", () => {
    const html = renderToStaticMarkup(
      <WebsiteBuildProgress
        stages={STAGES}
        failure={{ message: "scaffold blew up", stage: "scaffold" }}
        failed
      />,
    );
    expect(html).toContain("The build stopped before your site was ready");
    expect(html).not.toContain("scaffold blew up");
    expect(html).toContain("Something went wrong on our side");
    expect(html).toContain("Stopped at: Scaffolding the codebase");
    expect(html).not.toContain("Have a coffee");
    expect(html).not.toContain('role="progressbar"');
  });

  it("still renders a stopped build with no recorded reason", () => {
    const html = renderToStaticMarkup(
      <WebsiteBuildProgress stages={STAGES} failure={null} failed />,
    );
    expect(html).toContain("Something went wrong on our side");
  });

  it("does not keep a polite live region on the terminal failed state", () => {
    const html = renderToStaticMarkup(
      <WebsiteBuildProgress stages={STAGES} failure={null} failed />,
    );
    expect(html).toContain('role="status"');
    expect(html).not.toContain('aria-live');
  });
});

describe("WebsiteBuildProgress — publishing after the app is ready", () => {
  it("shows a spinner and Publishing instead of the build loader", () => {
    render(<WebsiteBuildProgress stages={STAGES} failure={null} failed={false} publish="publishing" />);
    expect(screen.getByRole("heading").textContent).toBe("Publishing");
    expect(screen.getByTestId("build-publishing-spinner").getAttribute("class")).toMatch(/animate-spin/);
    expect(screen.queryByTestId("build-lottie")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });

  it("shows a failed publish as unfinished publishing, not a stopped build", () => {
    render(
      <WebsiteBuildProgress
        stages={STAGES}
        failure={{ message: "Render deploy failed", stage: "deploy" }}
        failed
        publish="failed"
      />,
    );
    expect(screen.getByRole("heading").textContent).toBe("Publishing didn't finish");
    expect(screen.queryByText("The build stopped before your site was ready")).toBeNull();
    expect(screen.queryByText(/Retry/)).toBeNull();
    expect(screen.getByText(/didn't finish\. Start a new build to try again\./)).toBeTruthy();
  });

  it("names Retry publish only when the caller says Retry is on screen", () => {
    render(
      <WebsiteBuildProgress
        stages={STAGES}
        failure={{ message: "Render deploy failed", stage: "deploy" }}
        failed
        publish="failed-retry"
      />,
    );
    expect(screen.getByRole("heading").textContent).toBe("Publishing didn't finish");
    expect(screen.getByText(/Use Retry publish/)).toBeTruthy();
    expect(screen.queryByText(/Start a new build/)).toBeNull();
  });
});
