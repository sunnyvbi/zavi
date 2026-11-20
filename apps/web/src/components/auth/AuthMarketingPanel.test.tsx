// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthMarketingPanel } from "./AuthMarketingPanel";

vi.mock("@/components/ZaviMascot", () => ({ ZaviMascot: () => <span data-testid="mascot" /> }));

afterEach(cleanup);

describe("the login marketing panel", () => {
  it("shows the mascot and a still row of four logos for a founder coming from /start with a website", () => {
    render(<AuthMarketingPanel fromWebsite />);
    expect(screen.getByTestId("mascot")).toBeTruthy();
    expect(screen.getByText("Meet Zavi, your AI teammate for growing your business.")).toBeTruthy();
    const logos = screen.getByText("Built by operators from").nextElementSibling!;
    expect(Array.from(logos.querySelectorAll("img")).map((img) => img.getAttribute("alt"))).toEqual(["Upwork", "Amazon", "Airbnb", "Meta"]);
  });

  it("replaces the website proof panel with the OTP delivery animation after the code is sent", () => {
    render(<AuthMarketingPanel fromWebsite otpSent />);
    expect(screen.getByText("Your code is on its way.")).toBeTruthy();
    expect(screen.getByTestId("auth-otp-animation")).toBeTruthy();
    expect(screen.getAllByTestId("mascot")).toHaveLength(2);
    expect(screen.getByText("Your mail app")).toBeTruthy();
    expect(screen.queryByText("Meet Zavi, your AI teammate for growing your business.")).toBeNull();
  });

  it("keeps the plain panel without the mascot", () => {
    render(<AuthMarketingPanel />);
    expect(screen.queryByTestId("mascot")).toBeNull();
  });

  it("introduces Zavi as a teammate for growing a business, not a marketplace agent", () => {
    render(<AuthMarketingPanel />);
    expect(
      screen.getByText("Meet Zavi, your AI teammate for growing your business."),
    ).toBeTruthy();
    expect(screen.queryByText(/marketplace/i)).toBeNull();
    expect(screen.queryByText(/super agent/i)).toBeNull();
  });

  it("tells a visitor from a live run what happens after they sign up", () => {
    const { container } = render(<AuthMarketingPanel variant="live" />);
    expect(screen.getByText("Your growth card is on its way.")).toBeTruthy();
    const rows = Array.from(container.querySelector("ul")!.querySelectorAll(":scope > li")).map((li) => li.textContent?.trim());
    expect(rows).toEqual([
      "Your growth card lands in your inbox.",
      "Zavi opens on your goal, with your score and #1 constraint.",
      "You approve before anything goes out.",
    ]);
  });

  it("lists the three things Zavi does, in order, with nothing else in the list", () => {
    const { container } = render(<AuthMarketingPanel />);
    const rows = Array.from(container.querySelector("ul")!.querySelectorAll(":scope > li")).map((li) =>
      li.textContent?.trim(),
    );
    expect(rows).toEqual([
      "Learns how your business works.",
      "Finds what is slowing growth.",
      "Makes a clear plan and puts it to work.",
    ]);
  });

  it("sets the operator line as a centred proof label over a grey logo strip, like the home hero", () => {
    const { container } = render(<AuthMarketingPanel />);
    const label = screen.getByText("Built by operators from");
    expect(label.tagName).toBe("P");
    expect(label.className).toContain("text-[#595959]");
    expect(label.parentElement?.className).toContain("items-center");
    const strip = container.querySelector(".zavi-logo-marquee");
    expect(strip).toBeTruthy();
    expect(label.compareDocumentPosition(strip!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const marks = Array.from(strip!.querySelectorAll("img"));
    expect(marks.filter((img) => img.getAttribute("alt")).map((img) => img.getAttribute("alt"))).toEqual([
      "Upwork",
      "Amazon",
      "Upcar",
      "Airbnb",
      "Meta",
    ]);
    for (const img of marks) expect(img.className).toContain("grayscale");
    expect(screen.queryByRole("listitem", { name: /built by/i })).toBeNull();
  });
});
