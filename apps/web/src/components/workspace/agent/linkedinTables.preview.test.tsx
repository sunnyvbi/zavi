// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ExtraTable } from "../actions/ExtraTable";
import { linkedinTables } from "./linkedinTables";

afterEach(cleanup);

const post = (id: string, text: string, url: string | null = "https://www.linkedin.com/posts/example") => ({
  id, text, url, posted_at: null, reactions: 12, comments: 1, reposts: 2,
});
const longText = "A new chapter for our community. ".repeat(10) + "\n\nThe full ending stays available. 🚀";

it("keeps long posts compact and expands the exact original without changing metrics or the destination", () => {
  const [data] = linkedinTables({ top_posts: [post("long", longText)] });
  const { container } = render(<ExtraTable data={data} />);
  const cells = container.querySelectorAll("tbody tr:first-child td");
  expect(Array.from(cells[0].textContent ?? "").length).toBeLessThanOrEqual(181);
  expect(cells[0].textContent).toMatch(/…$/);
  expect(cells[0].querySelector("a")).toBeNull();
  expect(Array.from(cells).slice(1, 4).map(c => c.textContent)).toEqual(["12", "1", "2"]);
  const link = screen.getByRole("link", { name: "Open on LinkedIn" });
  expect(link.getAttribute("href")).toBe("https://www.linkedin.com/posts/example");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(screen.queryByRole("region", { name: "Full post" })).toBeNull();
  const toggle = screen.getByRole("button", { name: "Read full post" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  const full = screen.getByRole("region", { name: "Full post" });
  expect(full.querySelector("p:last-child")?.textContent).toBe(longText);
  expect(toggle.getAttribute("aria-controls")).toBe(full.id);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Show less" }));
  expect(screen.queryByRole("region", { name: "Full post" })).toBeNull();
});

it("short and empty posts need no disclosure; missing links do not hide readable text", () => {
  const [data] = linkedinTables({ top_posts: [post("short", "A short update.", null), post("empty", "  \n ", null)] });
  render(<ExtraTable data={data} />);
  expect(screen.getByText("A short update.")).toBeTruthy();
  expect(screen.getByText("(no text)")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Read full post" })).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});

it("expands posts independently and keeps emoji intact at the preview boundary", () => {
  const emoji = "🚀".repeat(181);
  const [data] = linkedinTables({ top_posts: [post("emoji", emoji, null), post("long", longText, null)] });
  expect(data.rows[0].cells[0].text).toBe("🚀".repeat(180) + "…");
  render(<ExtraTable data={data} />);
  const buttons = screen.getAllByRole("button", { name: "Read full post" });
  fireEvent.click(buttons[1]);
  expect(buttons[0].getAttribute("aria-expanded")).toBe("false");
  expect(screen.getAllByRole("region", { name: "Full post" })).toHaveLength(1);
  expect(within(screen.getByRole("region", { name: "Full post" })).getByText(/The full ending/)).toBeTruthy();
});
