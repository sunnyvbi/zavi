// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ChannelActionCard } from "../ChannelActionCard";
import { clearBlankContextCache } from "../BlanksFill";
import { blankGroup } from "../blanks";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const fail = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });

const FACTS = { facts: [{ key: "company_name", value_text: "Northside Yoga" }, { key: "domain", value_text: "https://www.northside.example" }] };
const SETTINGS = { fields: { esp: [{ item: "mailchimp" }] } };
const TEMPLATE = { template: { postal_address: "12 Elm St, Austin TX 78701" }, fonts: [], can_edit: true };

const EMAIL =
  "Hi [First name],\n\nThanks for choosing [class: the one they chose]. Book [Class they chose] again: [link: timetable page URL, tracked].\n\n" +
  "[Your name]\n--\n" +
  "You're getting this because you signed up at [your domain].\n" +
  "[Studio name], [Postal address: required by US law on every marketing email]\n" +
  "Unsubscribe: [your email tool's unsubscribe link]";

beforeEach(() => {
  clearBlankContextCache();
  apiFetch.mockReset();
  apiFetch.mockImplementation((path: string) =>
    path === "/api/connectors/company-facts" ? ok(FACTS) : path === "/api/channels/email_marketing/settings" ? ok(SETTINGS) : path === "/api/workspace/email-template" ? ok(TEMPLATE) : fail(),
  );
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
});
afterEach(cleanup);

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });

const mount = async () => {
  render(
    <ChannelActionCard
      action={makeAction("send_message", {
        channel_slug: "email_marketing",
        body: { step: { title: "Email", body: "b", deliverable: { kind: "email", label: "Email", content: EMAIL } } },
        card_kind: "message",
        primary_label: "Copy email",
        done_label: "I sent it",
        how_to: ["Press Copy email."],
      })}
      platform={platformFor("email_marketing")}
      handlers={handlers()}
    />,
  );
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return screen.getByTestId("blanks-fill");
};

const field = (root: HTMLElement, label: string | RegExp) =>
  (within(root).getByLabelText(label) as HTMLInputElement).closest("[data-testid=blank-field]") as HTMLElement;

describe("which side of the email a blank belongs to", () => {
  it("sorts per-recipient merge fields from the sender's own details", () => {
    expect(blankGroup("[First name]")).toBe("recipient");
    expect(blankGroup("{{first_name}}")).toBe("recipient");
    expect(blankGroup("{{ city }}")).toBe("recipient");
    expect(blankGroup("[class: the one they chose]")).toBe("recipient");
    expect(blankGroup("[Class they chose]")).toBe("recipient");
    expect(blankGroup("[Your name]")).toBe("sender");
    expect(blankGroup("[your domain]")).toBe("sender");
    expect(blankGroup("[Studio name]")).toBe("sender");
    expect(blankGroup("[Postal address: required by US law on every marketing email]")).toBe("sender");
    expect(blankGroup("[your email tool's unsubscribe link]")).toBe("sender");
    expect(blankGroup("[link: timetable page URL, tracked]")).toBe("sender");
    expect(blankGroup("[your customer's first name]")).toBe("recipient");
    expect(blankGroup("[your city]")).toBe("sender");
  });
});

describe("the blanks form", () => {
  it("sits inside the draft box, on a hairline with no box of its own and no amber wash", async () => {
    const box = await mount();
    const classes = [box, ...Array.from(box.querySelectorAll("*"))].map((e) => e.getAttribute("class") ?? "").join(" ");
    expect(classes).not.toMatch(/amber|orange|yellow/);
    expect(screen.getByTestId("email-code-box").contains(box)).toBe(true);
    expect(box.className).toContain("border-t");
    expect(box.className).toContain("border-ca-border");
    expect(box.className).toContain("py-3");
    expect(box.className).not.toMatch(/\brounded|\bbg-white|(?<![\w-])border(?![\w-])/);
  });

  it("lists personalisation first, then your details, each field once, with no group headings", async () => {
    const box = await mount();
    expect(within(box).queryByText("Personalisation")).toBeNull();
    expect(within(box).queryByText("Your details")).toBeNull();
    expect(Array.from(box.querySelectorAll("input")).map((i) => i.getAttribute("aria-label"))).toEqual([
      "First name",
      "class: the one they chose",
      "Class they chose",
      "link: timetable page URL, tracked",
      "Your name",
      "your domain",
      "Studio name",
    ]);
    expect(within(box).queryByTestId("blanks-footer")).toBeNull();
  });

  it("lays the fields out in a fixed two-column grid (one on a phone), with no footer field in it", async () => {
    const box = await mount();
    const grid = box.querySelector("div.grid") as HTMLElement;
    expect(grid.className).toContain("grid-cols-1");
    expect(grid.className).toContain("sm:grid-cols-2");
    expect(grid.className).toContain("items-start");
    expect(within(box).queryByLabelText(/^Postal address/)).toBeNull();
    expect(within(box).queryByLabelText("your email tool's unsubscribe link")).toBeNull();
    expect(field(box, "Your name").className).not.toContain("col-span-full");
  });

  it("uses the Settings input style and says where a filled-in value came from, with no Auto-filled chip", async () => {
    const box = await mount();
    for (const input of Array.from(box.querySelectorAll("input"))) {
      expect(input.className).toContain("h-9");
      expect(input.className).toContain("rounded-[10px]");
      expect(input.className).toContain("text-[16px]");
    }
    const studio = field(box, "Studio name");
    expect(studio.dataset.state).toBe("auto");
    expect(within(box).queryByTestId("blank-auto")).toBeNull();
    expect(box.textContent).not.toContain("Auto-filled");
    expect(within(studio).getByTestId("blank-from").textContent).toBe("From your company details");
    const input = within(studio).getByLabelText("Studio name") as HTMLInputElement;
    expect(input.getAttribute("aria-describedby")).toBe(within(studio).getByTestId("blank-from").id);

    const name = field(box, "Your name");
    expect(name.dataset.state).toBe("empty");
    expect(within(name).queryByTestId("blank-auto")).toBeNull();

    fireEvent.change(input, { target: { value: "Northside Studio" } });
    expect(field(box, "Studio name").dataset.state).toBe("typed");
    expect(within(field(box, "Studio name")).queryByTestId("blank-auto")).toBeNull();
    expect(within(field(box, "Studio name")).queryByTestId("blank-from")).toBeNull();
  });

  it("shows a hint once, as the placeholder only, with no second line under the field", async () => {
    const box = await mount();
    const link = field(box, "link: timetable page URL, tracked");
    expect(within(link).getByText("Link")).toBeTruthy();
    const input = within(link).getByLabelText("link: timetable page URL, tracked") as HTMLInputElement;
    expect(input.placeholder).toBe("timetable page URL, tracked");
    expect(within(link).queryByText("timetable page URL, tracked")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBeNull();
  });

  it("says how many blanks are left in one muted line, with no progress bar and no pill, then collapses to Blanks filled and Change reopens the fields", async () => {
    const box = await mount();
    const left = within(box).getByTestId("blanks-left");
    expect(left.textContent).toBe("4 blanks to fill");
    expect(left.className).toContain("text-[13px]");
    expect(left.className).toContain("text-ca-secondary");
    expect(left.className).not.toMatch(/rounded|bg-/);
    expect(within(box).queryByTestId("blanks-progress")).toBeNull();
    expect(box.textContent).not.toMatch(/of \d+ left|Fill these in first/);
    const labels = ["class: the one they chose", "Class they chose", "link: timetable page URL, tracked", "Your name"];
    fireEvent.focus(within(box).getByLabelText(labels[0]!));
    for (const label of labels) fireEvent.change(within(box).getByLabelText(label), { target: { value: label.startsWith("link") ? "https://x.example.com/t" : "x" } });
    expect(box.dataset.state).toBe("open");
    expect(within(box).getByLabelText("Your name")).toBeTruthy();
    fireEvent.blur(within(box).getByLabelText(labels[0]!), { relatedTarget: document.body });
    expect(box.dataset.state).toBe("filled");
    expect(within(box).getByTestId("blanks-left").textContent).toBe("Blanks filled");
    expect(box.querySelectorAll("input")).toHaveLength(0);
    fireEvent.click(within(box).getByRole("button", { name: "Change" }));
    expect(box.querySelectorAll("input")).toHaveLength(7);
    expect((within(box).getByLabelText("Your name") as HTMLInputElement).value).toBe("x");
    expect(document.activeElement).toBe(box.querySelector("input"));
  });

  it("a card whose blanks are all one kind shows no group headings", async () => {
    cleanup();
    render(
      <ChannelActionCard
        action={makeAction("send_message", {
          channel_slug: "email_marketing",
          body: { step: { title: "Email", body: "b", deliverable: { kind: "email", label: "Email", content: "Hi [First name], see you at [class: the one they chose]." } } },
          card_kind: "message",
          primary_label: "Copy email",
          done_label: "I sent it",
          how_to: ["Press Copy email."],
        })}
        platform={platformFor("email_marketing")}
        handlers={handlers()}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    const box = screen.getByTestId("blanks-fill");
    expect(within(box).queryByText("Personalisation")).toBeNull();
    expect(within(box).queryByText("Your details")).toBeNull();
    expect(box.querySelectorAll("input")).toHaveLength(2);
  });
});
