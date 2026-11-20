// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { GrowthDownloadApp } from "./GrowthDownloadApp";

afterEach(cleanup);

const appleLinks = () =>
  screen.queryAllByRole("link").filter((a) => a.getAttribute("href")?.includes("apps.apple.com"));

describe("GrowthDownloadApp", () => {
  it("locks the App Store badge as coming soon while iOS is not live", () => {
    render(<GrowthDownloadApp />);
    expect(screen.getByLabelText("App Store, coming soon")).toBeTruthy();
    expect(appleLinks()).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Get it on Google Play" })).toBeTruthy();
  });

  it("links to the App Store once iOS is live", () => {
    render(<GrowthDownloadApp iosLive />);
    expect(screen.queryByLabelText("App Store, coming soon")).toBeNull();
    expect(appleLinks()).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Get it on Google Play" })).toBeTruthy();
  });
});
