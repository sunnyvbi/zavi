// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Skeleton } from "./Skeleton";

afterEach(cleanup);

describe("workspace skeleton theme treatment", () => {
  it("uses a theme surface for the shimmer so rounded loading edges never flash white in dark mode", () => {
    const { container } = render(
      <div className="workspace-shell">
        <Skeleton className="h-10 w-40" rounded="rounded-2xl" />
      </div>,
    );

    const shimmer = container.querySelector("[aria-hidden] > span");
    expect(shimmer?.className).toContain("via-cream/55");
    expect(shimmer?.className).not.toContain("via-white/55");
  });
});
