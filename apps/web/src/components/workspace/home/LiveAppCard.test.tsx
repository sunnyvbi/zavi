import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BUILD_FIXES_EXHAUSTED, BUILD_INTERNAL_FAILURE, BUILD_STALLED, BUILD_STOPPED_BY_YOU } from "@zavi/shared";
import { LiveAppCard } from "./LiveAppCard";

vi.mock("@/fonts", () => ({ inter: { variable: "font-inter-var" }, jakartaBody: { variable: "v" } }));

describe("LiveAppCard failure details", () => {
  it("l1.5: a build you stopped says how to start it again with what is on screen, not a missing Start again button", () => {
    for (const failure of [
      { class: "user_cancelled", message: "Build was stopped by the user.", stage: null, retry_count: 0 },
      { class: "user_cancelled", code: "stopped_by_you", message: BUILD_STOPPED_BY_YOU, stage: null, retry_count: 0 },
    ]) {
      const html = renderToStaticMarkup(<LiveAppCard status="failed" url={null} failure={failure} />);
      expect(html).toContain("Build stopped");
      expect(html).toContain("You stopped this build. To build it again, describe it in the message box.");
      expect(html).not.toMatch(/Start it again|whenever you/i);
      expect(html).not.toContain("Build was stopped by the user.");
    }
  });

  it("never shows the raw pipeline reason, the stage name or the agent (QA 2026-10-02)", () => {
    const html = renderToStaticMarkup(
      <LiveAppCard
        status="failed"
        url={null}
        failure={{
          class: "repair_exhausted",
          message: "vite: module not found: ./Dashboard",
          stage: "build",
          retry_count: 3,
        }}
      />,
    );
    expect(html).toContain("Build failed");
    expect(html).toContain(BUILD_FIXES_EXHAUSTED.replace(/'/g, "&#x27;"));
    expect(html).not.toContain("vite: module not found");
    expect(html).not.toMatch(/Stage: |Agent: |Retries: /);
  });

  it("shows founder copy from the server as sent when it carries a code", () => {
    const html = renderToStaticMarkup(
      <LiveAppCard
        status="failed"
        url={null}
        failure={{ class: "stage_failed", code: "internal", message: BUILD_INTERNAL_FAILURE, stage: "build", retry_count: 0 }}
      />,
    );
    expect(html).toContain("Something went wrong on our side");
  });

  it("an internal sandbox error from an older server body maps to the generic line", () => {
    const html = renderToStaticMarkup(
      <LiveAppCard
        status="failed"
        url={null}
        failure={{
          class: "stage_failed",
          message: "onSiteSandboxReady: the running preview could not be stopped (exit 1)",
          stage: "build",
          retry_count: 0,
        }}
      />,
    );
    expect(html).not.toMatch(/onSiteSandboxReady|exit 1/);
    expect(html).toContain("Something went wrong on our side");
  });

  it("never shows a raw model-provider auth error", () => {
    const html = renderToStaticMarkup(
      <LiveAppCard
        status="failed"
        url={null}
        failure={{
          class: "dispatch_failed",
          message:
            "Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token has been revoked",
          stage: "build",
          retry_count: 0,
        }}
      />,
    );
    expect(html).not.toMatch(/OAuth|401|revoked/);
    expect(html).toContain("Something went wrong on our side");
  });

  it("labels budget and stale failures as stopped, not crashed", () => {
    for (const failureClass of ["budget_halted", "stale_reaped"]) {
      const html = renderToStaticMarkup(
        <LiveAppCard
          status="failed"
          url={null}
          failure={{
            class: failureClass,
            message: "Build stopped after the active stage stopped reporting progress.",
            stage: null,
            retry_count: 0,
          }}
        />,
      );
      expect(html).toContain("Build stopped");
    }
    const stale = renderToStaticMarkup(
      <LiveAppCard
        status="failed"
        url={null}
        failure={{ class: "stale_reaped", message: "Build stopped after the active stage stopped reporting progress.", stage: null, retry_count: 0 }}
      />,
    );
    expect(stale).toContain(BUILD_STALLED);
  });
});
