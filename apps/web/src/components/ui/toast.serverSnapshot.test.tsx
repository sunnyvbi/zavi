// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";

import { Toaster } from "./toast";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the toast store's server snapshot", () => {
  it("is the same reference every call, so hydration does not loop on it", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    const host = document.createElement("div");
    host.innerHTML = renderToString(<Toaster />);
    document.body.appendChild(host);

    await act(async () => {
      hydrateRoot(host, <Toaster />);
    });

    expect(errors.filter((e) => /getServerSnapshot/.test(e))).toEqual([]);
  });
});
