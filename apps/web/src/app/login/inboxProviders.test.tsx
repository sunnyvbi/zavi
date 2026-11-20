// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { InboxLinks } from "./InboxLinks";
import { inboxLinks } from "./inboxProviders";

afterEach(cleanup);

const hrefOf = (email: string, id: string) => inboxLinks(email).find((link) => link.id === id)!.href;

describe("inbox links on the code screen", () => {
  it("opens Gmail on the signed-up account, searching for the Zavi email", () => {
    const url = new URL(hrefOf("  Founder+Zavi@Gmail.com ", "gmail"));
    expect(url.origin).toBe("https://mail.google.com");
    expect(url.searchParams.get("authuser")).toBe("founder+zavi@gmail.com");
    expect(decodeURIComponent(url.hash)).toBe("#search/from:support@zaviagent.com in:anywhere newer_than:1d");
  });
  it("sends personal Microsoft addresses to outlook.live.com and everyone else to the work inbox", () => {
    expect(hrefOf("a@hotmail.com", "outlook")).toBe("https://outlook.live.com/mail/0/");
    expect(hrefOf("a@acme.co", "outlook")).toBe("https://outlook.office.com/mail/");
  });
  it("renders three links that open in a new tab without handing over the opener", () => {
    render(<InboxLinks email="a@acme.co" />);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("title"))).toEqual(["Open Gmail", "Open Outlook", "Open Proton"]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
    expect(screen.getByRole("link", { name: "Open Proton in a new tab" }).getAttribute("href")).toContain("mail.proton.me");
  });
});
