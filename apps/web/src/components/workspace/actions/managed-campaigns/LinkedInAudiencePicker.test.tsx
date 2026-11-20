// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { emptyAudienceChoices, forgetLinkedInAudienceOptions, LinkedInAudiencePicker } from "./LinkedInAudiencePicker";
const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
const CEO = { urn: "urn:li:title:1", name: "Chief Executive Officer" };
const VP = { urn: "urn:li:seniority:9", name: "VP" };
const facet = (f: string) => api.mock.calls.filter(([p]) => String(p).includes(`facet=${f}`)).length;
const replies: Record<string, Array<unknown[]>> = {};
const show = () => render(<LinkedInAudiencePicker base="/api/x" accountId="11" value={emptyAudienceChoices()} disabled={false} onChange={vi.fn()} />);
const type = (value: string) => {
  const box = screen.getByRole("combobox", { name: "Job titles" });
  fireEvent.focus(box);
  fireEvent.change(box, { target: { value } });
};
beforeEach(() => {
  forgetLinkedInAudienceOptions();
  api.mockReset();
  for (const k of Object.keys(replies)) delete replies[k];
  api.mockImplementation(async (path: string) => {
    const name = /facet=(\w+)/.exec(path)![1];
    return { options: replies[name]?.shift() ?? [] };
  });
});
afterEach(cleanup);

it("an empty job title lookup is asked again when the founder retypes it, and shows what LinkedIn now has", async () => {
  replies.titles = [[], [CEO]];
  show();
  type("Chief");
  await screen.findByText("No matching LinkedIn options. Try another word.");
  type("Chie");
  type("Chief");
  await screen.findByRole("option", { name: CEO.name });
  expect(facet("titles")).toBe(2);
});

it("a reopened sheet asks again after an empty lookup, across the module cache", async () => {
  replies.titles = [[], [CEO]];
  const first = show();
  type("Chief");
  await screen.findByText("No matching LinkedIn options. Try another word.");
  first.unmount();
  show();
  type("Chief");
  await screen.findByRole("option", { name: CEO.name });
});

it("an empty seniority list offers Try again, and that asks LinkedIn again", async () => {
  replies.seniorities = [[], [VP]];
  replies.staffCountRanges = [[{ urn: "urn:li:staffCountRange:(1,10)", name: "1-10" }]];
  show();
  await screen.findByText(/LinkedIn offers no options here/);
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("button", { name: VP.name });
  expect(facet("seniorities")).toBe(2);
});

it("a lookup with answers is still served from the cache", async () => {
  replies.seniorities = [[VP]];
  const first = show();
  await screen.findByRole("button", { name: VP.name });
  first.unmount();
  show();
  await screen.findByRole("button", { name: VP.name });
  await waitFor(() => expect(facet("seniorities")).toBe(1));
});

it("clicking a Zavi-suggested job title opens LinkedIn's matches without touching the box, and a double click still asks LinkedIn once", async () => {
  replies.titles = [[CEO], [CEO]];
  render(<LinkedInAudiencePicker base="/api/x" accountId="11" value={emptyAudienceChoices()} suggestions={{ titles: ["Chief Executive"] } as never} disabled={false} onChange={vi.fn()} />);
  const term = screen.getByRole("button", { name: "Chief Executive" });
  fireEvent.click(term);
  fireEvent.click(term);
  const box = screen.getByRole("combobox", { name: "Job titles" });
  expect((box as HTMLInputElement).value).toBe("Chief Executive");
  await screen.findByRole("option", { name: CEO.name });
  expect(document.activeElement).toBe(box);
  expect(box.getAttribute("aria-expanded")).toBe("true");
  await new Promise(r => setTimeout(r, 400));
  expect(facet("titles")).toBe(1);
  expect(api.mock.calls.filter(([p]) => String(p).includes("facet=titles"))[0][0]).toContain("query=Chief+Executive");
});
