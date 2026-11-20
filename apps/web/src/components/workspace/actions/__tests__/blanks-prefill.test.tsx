// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { ChannelActionCard } from "../ChannelActionCard";
import { clearBlankContextCache } from "../BlanksFill";
import { ESP_TAGS, blankLabel, blankSource, fillBlanks, findBlanks, knownBlankValues, siteDomain } from "../blanks";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { makeAction } from "./fixtures";

const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
const fail = () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) });

const FACTS = { facts: [{ key: "company_name", value_text: "Northside Yoga" }, { key: "domain", value_text: "https://www.northside.example" }] };
const SETTINGS = { fields: { esp: [{ item: "mailchimp" }] } };
const TEMPLATE = { template: { postal_address: "12 Elm St, Austin TX 78701" }, fonts: [], can_edit: true };

const EMAIL =
  "Hi [first name],\n\nThanks for choosing [class: the one they chose].\n\n--\n" +
  "You're getting this because you signed up at [your domain].\n" +
  "[Studio name], [Postal address: required by US law on every marketing email]\n" +
  "Unsubscribe: [your email tool's unsubscribe link]";

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  clearBlankContextCache();
  apiFetch.mockReset();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});
afterEach(cleanup);

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });

const emailCard = (content = EMAIL) =>
  makeAction("send_message", {
    channel_slug: "email_marketing",
    body: { step: { title: "Email", body: "b", deliverable: { kind: "email", label: "Email", content } } },
    card_kind: "message",
    primary_label: "Copy email",
    done_label: "I sent it",
    how_to: ["Press Copy email."],
  });

const routes = (map: Record<string, () => Promise<unknown>>) =>
  apiFetch.mockImplementation((path: string) => (map[path] ? map[path]() : fail()));

const flush = () => act(async () => {
  await new Promise((r) => setTimeout(r, 0));
});

const input = (label: string | RegExp) => screen.getByLabelText(label) as HTMLInputElement;

describe("which blank a saved value answers", () => {
  it("names the blanks a draft leaves", () => {
    expect(blankSource("[Postal address: required by US law on every marketing email]")).toBe("postal_address");
    expect(blankSource("[your email tool's unsubscribe link]")).toBe("unsubscribe");
    expect(blankSource("[your domain]")).toBe("domain");
    expect(blankSource("[Studio name]")).toBe("company_name");
    expect(blankSource("{{first_name}}")).toBe("first_name");
    expect(blankSource("[first name]")).toBe("first_name");
  });

  it("leaves blanks no setting can answer", () => {
    expect(blankSource("[class: the one they chose]")).toBeNull();
    expect(blankSource("[link: timetable page URL, tracked, operator to confirm]")).toBeNull();
    expect(blankSource("[Your name]")).toBeNull();
    expect(blankSource("[city]")).toBeNull();
    expect(blankSource("[domain authority score]")).toBeNull();
  });

  it("an email tool nobody picked gives no tag, so the unsubscribe blank stays for the founder", () => {
    const k = knownBlankValues(["[your email tool's unsubscribe link]", "[first name]"], { esp: "other" });
    expect(k).toEqual({});
  });

  it("SendGrid fills its own first-name and unsubscribe tags, and the filled email has no blanks left", () => {
    const draft = "Hi [first name],\n\nUnsubscribe: [your email tool's unsubscribe link]";
    const blanks = findBlanks(draft);
    const k = knownBlankValues(blanks, { esp: "sendgrid", unsubscribeLink: "https://ignored.example/u" });
    expect(k["[first name]"]).toEqual({ value: '{{insert first_name "default=there"}}', from: "SendGrid's first-name tag. Each person sees their own name." });
    expect(k["[your email tool's unsubscribe link]"]?.value).toBe("{{{unsubscribe}}}");
    expect(k["[your email tool's unsubscribe link]"]?.from).toContain("SendGrid");
    const filled = fillBlanks(draft, Object.fromEntries(Object.entries(k).map(([b, v]) => [b, v.value])));
    expect(filled).toBe('Hi {{insert first_name "default=there"}},\n\nUnsubscribe: {{{unsubscribe}}}');
    expect(findBlanks(filled)).toEqual([]);
    expect(findBlanks("Hi {{first_name}}, {{{promo_code}}}")).toEqual(["{{first_name}}", "{{promo_code}}"]);
  });

  it("reads the site's bare domain from the company website", () => {
    expect(siteDomain("https://www.northside.example/pricing")).toBe("northside.example");
    expect(siteDomain("northside.example")).toBe("northside.example");
    expect(siteDomain("not a site")).toBeNull();
  });

  it("splits a hinted blank into a label and its hint", () => {
    expect(blankLabel("[link: timetable page URL, tracked, operator to confirm]")).toEqual({ title: "Link", hint: "timetable page URL, tracked, operator to confirm" });
    expect(blankLabel("[first name]")).toEqual({ title: "First name", hint: null });
    expect(blankLabel("[BRACKET: make/model/year]")).toEqual({ title: "Make/model/year", hint: null });
    expect(blankLabel("[FOUNDER: $____]")).toEqual({ title: "Founder", hint: "$____" });
  });
});

describe("on an email card", () => {
  it("fills what the workspace already knows, and Copy takes it", async () => {
    routes({ "/api/connectors/company-facts": () => ok(FACTS), "/api/channels/email_marketing/settings": () => ok(SETTINGS), "/api/workspace/email-template": () => ok(TEMPLATE) });
    render(<ChannelActionCard action={emailCard()} platform={platformFor("email_marketing")} handlers={handlers()} />);
    expect(screen.getByRole("button", { name: "Copy email (6 blanks to fill)" })).toBeTruthy();
    await flush();

    expect(screen.queryByLabelText(/^Postal address/)).toBeNull();
    expect(screen.queryByLabelText("your email tool's unsubscribe link")).toBeNull();
    expect(screen.queryByTestId("blanks-footer")).toBeNull();
    expect(input("your domain").value).toBe("northside.example");
    expect(input("Studio name").value).toBe("Northside Yoga");
    expect(input("first name").value).toBe("*|FNAME|*");
    expect(input(/^class/).value).toBe("");
    expect(screen.getByTestId("blanks-left").textContent).toBe("1 blank to fill");
    expect(screen.queryByText(/Email campaigns settings/)).toBeNull();

    fireEvent.change(input(/^class/), { target: { value: "Sunrise Flow" } });
    expect(screen.getByTestId("blanks-left").textContent).toBe("Blanks filled");
    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(
      "Hi *|FNAME|*,\n\nThanks for choosing Sunrise Flow.\n\n--\n" +
        "You're getting this because you signed up at northside.example.\n" +
        "Northside Yoga, 12 Elm St, Austin TX 78701\n" +
        "Unsubscribe: *|UNSUB|*",
    );
  });

  it.each(Object.keys(ESP_TAGS))("%s: the tags auto-fill puts in are not blanks, so Copy goes out with no blank count and no warning", async (esp) => {
    const tags = ESP_TAGS[esp]!;
    routes({
      "/api/connectors/company-facts": () => ok(FACTS),
      "/api/channels/email_marketing/settings": () => ok({ fields: { postal_address: [{ item: "12 Elm St" }], esp: [{ item: esp }] } }),
    });
    const content = "Hi [first name],\n\nSee you, {{ first_name }}.\n\nUnsubscribe: [your email tool's unsubscribe link]";
    render(<ChannelActionCard action={emailCard(content)} platform={platformFor("email_marketing")} handlers={handlers()} />);
    expect(screen.getByRole("button", { name: "Copy email (3 blanks to fill)" })).toBeTruthy();
    await flush();
    expect(screen.getByTestId("blanks-left").textContent).toBe("Blanks filled");
    expect(screen.queryByRole("button", { name: /blanks? to fill/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(`Hi ${tags.first_name},\n\nSee you, ${tags.first_name}.\n\nUnsubscribe: ${tags.unsubscribe}`);
    expect(document.body.textContent).not.toContain("Fill before sending");
  });

  it.each(Object.keys(ESP_TAGS))("%s: every draft blank auto-fill answers leaves findBlanks empty", (esp) => {
    const draft = [
      "Hi [first name], hey [First Name], {{first_name}} and {{ first_name }} and [FIRST_NAME] and [fname]",
      "[your email tool's unsubscribe link] / [Unsubscribe link] / {{ unsubscribe_link }}",
    ].join("\n");
    const blanks = findBlanks(draft);
    expect(blanks.length).toBe(9);
    const known = knownBlankValues(blanks, { esp });
    expect(Object.keys(known).sort()).toEqual([...blanks].sort());
    const values = Object.fromEntries(Object.entries(known).map(([b, k]) => [b, k.value]));
    const filled = fillBlanks(draft, values);
    expect(filled).toContain(ESP_TAGS[esp]!.first_name);
    expect(filled).toContain(ESP_TAGS[esp]!.unsubscribe);
    expect(findBlanks(filled)).toEqual([]);
    expect(findBlanks(`${filled}\nCode: {{ promo_code }}`)).toEqual(["{{ promo_code }}"]);
  });

  it("what the founder types wins, and a cleared box is not refilled", async () => {
    routes({ "/api/connectors/company-facts": () => ok(FACTS), "/api/channels/email_marketing/settings": () => ok(SETTINGS), "/api/workspace/email-template": () => ok(TEMPLATE) });
    render(<ChannelActionCard action={emailCard()} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
    fireEvent.change(input("Studio name"), { target: { value: "Northside Studio" } });
    fireEvent.change(input("your domain"), { target: { value: "" } });
    await flush();
    expect(input("Studio name").value).toBe("Northside Studio");
    expect(input("your domain").value).toBe("");
    expect(screen.getByRole("button", { name: "Copy email (2 blanks to fill)" })).toBeTruthy();
    expect(screen.queryByText(/Email campaigns settings/)).toBeNull();
  });

  it("one endpoint failing still fills from the other", async () => {
    routes({ "/api/connectors/company-facts": () => Promise.reject(new Error("offline")), "/api/channels/email_marketing/settings": () => ok(SETTINGS), "/api/workspace/email-template": () => ok(TEMPLATE) });
    render(<ChannelActionCard action={emailCard()} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
    expect(screen.queryByLabelText(/^Postal address/)).toBeNull();
    expect(screen.queryByTestId("blanks-footer")).toBeNull();
    expect(input("Studio name").value).toBe("");
    expect(input("your domain").value).toBe("");
  });

  it("a slow answer arriving after the card closed changes nothing and does not throw", async () => {
    let release: (v: unknown) => void = () => {};
    routes({
      "/api/connectors/company-facts": () => new Promise((r) => (release = r)),
      "/api/channels/email_marketing/settings": () => ok(SETTINGS), "/api/workspace/email-template": () => ok(TEMPLATE),
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<ChannelActionCard action={emailCard()} platform={platformFor("email_marketing")} handlers={handlers()} />);
    unmount();
    release({ ok: true, json: () => Promise.resolve(FACTS) });
    await flush();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("many cards on one page read each source once", async () => {
    routes({ "/api/connectors/company-facts": () => ok(FACTS), "/api/channels/email_marketing/settings": () => ok(SETTINGS), "/api/workspace/email-template": () => ok(TEMPLATE) });
    render(
      <>
        <ChannelActionCard action={emailCard()} platform={platformFor("email_marketing")} handlers={handlers()} />
        <ChannelActionCard action={{ ...emailCard(), id: "second" }} platform={platformFor("email_marketing")} handlers={handlers()} />
      </>,
    );
    await flush();
    expect(apiFetch.mock.calls.map((c) => c[0]).sort()).toEqual(["/api/channels/email_marketing/settings", "/api/connectors/company-facts", "/api/workspace/email-template"]);
  });

  it("a draft with no blank a setting answers reads nothing", async () => {
    routes({});
    render(<ChannelActionCard action={emailCard("Thanks for joining [class: the one they chose].")} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("the browser is told not to autofill the boxes", async () => {
    routes({});
    render(<ChannelActionCard action={emailCard()} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
    for (const box of screen.getByTestId("blanks-fill").querySelectorAll("input")) {
      expect(box.getAttribute("autocomplete")).toBe("off");
      expect(box.getAttribute("name")).toMatch(/^zavi-blank-\d+$/);
    }
  });
});

describe("the email draft fills in as the founder types", () => {
  const DRAFT = "Subject: A spot for [first name]\nPreview: Your [class: the one they chose] is booked\n\nHi [first name],\n\nSee you at [class: the one they chose].";
  const slots = () => screen.getAllByTestId("email-slot");

  it("shows each typed value in place, marks the slot of the focused field, and keeps the brackets for empty ones", async () => {
    routes({});
    render(<ChannelActionCard action={emailCard(DRAFT)} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
    expect(screen.getByTestId("email-box")).toBeTruthy();
    expect(slots().map((m) => m.textContent)).toEqual(["[first name]", "[class: the one they chose]", "[first name]", "[class: the one they chose]"]);
    expect(slots().some((m) => m.dataset.filled)).toBe(false);

    fireEvent.change(input("first name"), { target: { value: "Ada" } });
    expect(screen.getByTestId("email-box-subject").textContent).toBe("A spot for Ada");
    const filled = slots().filter((m) => m.dataset.filled === "true");
    expect(filled.map((m) => m.textContent)).toEqual(["Ada", "Ada"]);

    fireEvent.focus(input(/^class/));
    const active = slots().filter((m) => m.dataset.active === "true");
    expect(active.map((m) => m.textContent)).toEqual(["[class: the one they chose]", "[class: the one they chose]"]);
    fireEvent.change(input(/^class/), { target: { value: "Morning flow" } });
    expect(screen.getByTestId("email-box-preview").textContent).toBe("Your Morning flow is booked");
    expect(slots().filter((m) => m.dataset.active === "true").map((m) => m.textContent)).toEqual(["Morning flow", "Morning flow"]);
    fireEvent.blur(input(/^class/));
    expect(slots().some((m) => m.dataset.active)).toBe(false);
    expect(screen.getByTestId("blanks-fill").dataset.state).toBe("filled");
    expect(screen.queryByLabelText("first name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(document.activeElement).toBe(input("first name"));

    fireEvent.change(input("first name"), { target: { value: "  " } });
    expect(screen.getByTestId("email-box-subject").textContent).toBe("A spot for [first name]");

    fireEvent.focus(input("first name"));
    act(() => {
      fireEvent.blur(input("first name"));
      fireEvent.focus(input(/^class/));
    });
    expect(slots().filter((m) => m.dataset.active === "true").map((m) => m.textContent)).toEqual(["Morning flow", "Morning flow"]);

    const marks = () => slots().filter((m) => m.dataset.filled === "true" && m.textContent?.startsWith("Morning"));
    const before = marks()[0]!;
    fireEvent.change(input(/^class/), { target: { value: "Morning flow 2" } });
    expect(marks()[0]).toBe(before);
  });

  it("highlights a long blank in place once it is filled", async () => {
    const long = "[class name, as it appears on the timetable for that week]";
    routes({});
    render(<ChannelActionCard action={emailCard(`Subject: Hi\n\nSee you at ${long}.`)} platform={platformFor("email_marketing")} handlers={handlers()} />);
    await flush();
    expect(screen.getAllByTestId("email-slot").map((m) => m.textContent)).toEqual([long]);
  });
});

describe("the postal address and unsubscribe link come from Settings > Footer", () => {
  const POSTAL_ONLY = "Hi [first name],\n\nSee you soon.\n\n--\n[Postal address: required by US law on every marketing email]";
  const UNSUB_ONLY = "Hi there,\n\nSee you soon.\n\nUnsubscribe: [your email tool's unsubscribe link]";
  const mount = (content: string) => render(<ChannelActionCard action={emailCard(content)} platform={platformFor("email_marketing")} handlers={handlers()} />);

  it("says nothing is missing while the saved footer is still loading, and Copy stays gated meanwhile", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    routes({
      "/api/channels/email_marketing/settings": async () => {
        await held;
        return ok({ fields: {} });
      },
      "/api/workspace/email-template": async () => {
        await held;
        return ok({ template: { postal_address: "1 Main St, Springfield" }, fonts: [], can_edit: true });
      },
    });
    mount(POSTAL_ONLY);
    await act(async () => {});
    expect(screen.queryByTestId("footer-slot")?.dataset.state).not.toBe("missing");
    expect(screen.getByRole("button", { name: /Copy email \(\d blanks? to fill\)/ }).getAttribute("aria-disabled")).toBe("true");
    await act(async () => release());
    await flush();
    expect(screen.queryByTestId("footer-slot")?.dataset.state).not.toBe("missing");
  });

  it("no saved address: a footer slot instead of a postal input, Copy is replaced by Add, and Add opens the footer form", async () => {
    routes({
      "/api/channels/email_marketing/settings": () => ok({ fields: { esp: [{ item: "mailchimp" }] } }),
      "/api/workspace/email-template": () => ok({ template: null, fonts: [], can_edit: true }),
    });
    mount(POSTAL_ONLY);
    await flush();
    expect(screen.queryByLabelText(/^Postal address/)).toBeNull();
    expect(screen.getByTestId("footer-slot").textContent).toContain("Postal address missing");
    expect(input("first name").value).toBe("*|FNAME|*");
    expect(screen.queryByRole("button", { name: /^Copy email/ })).toBeNull();
    const goto = vi.fn();
    window.addEventListener("zavi:email-settings-goto", goto);
    fireEvent.click(screen.getByRole("button", { name: "Add postal address" }));
    window.removeEventListener("zavi:email-settings-goto", goto);
    expect(goto).toHaveBeenCalledTimes(1);
    await flush();
    expect(writeText).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an address saved in the template fills the blank, beats the old setting, and shows no line", async () => {
    routes({
      "/api/channels/email_marketing/settings": () => ok({ fields: { postal_address: [{ item: "OLD 1 Old Rd" }], esp: [{ item: "mailchimp" }] } }),
      "/api/workspace/email-template": () => ok({ template: { postal_address: "12 Elm St, Austin TX 78701" }, fonts: [], can_edit: true }),
    });
    mount(POSTAL_ONLY);
    await flush();
    expect(screen.queryByTestId("footer-slot")?.dataset.state).not.toBe("missing");
    expect(screen.getByTestId("blanks-left").textContent).toBe("Blanks filled");
    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("Hi *|FNAME|*,\n\nSee you soon.\n\n--\n12 Elm St, Austin TX 78701");
  });

  it("an address only in the old channel setting does not fill the blank: the card points to Settings > Footer and Copy stays gated", async () => {
    routes({
      "/api/channels/email_marketing/settings": () => ok({ fields: { postal_address: [{ item: "12 Elm St, Austin TX 78701" }], esp: [{ item: "mailchimp" }] } }),
      "/api/workspace/email-template": () => ok({ template: { postal_address: "  " }, fonts: [], can_edit: true }),
    });
    mount(POSTAL_ONLY);
    await flush();
    expect(screen.getByTestId("footer-slot").textContent).toContain("Postal address missing");
    expect(screen.queryByRole("button", { name: /^Copy email/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Add postal address" })).toBeTruthy();
    expect(writeText).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("12 Elm St");
  });

  it("no template row yet: the old channel setting fills the blank, skipping a paused or dismissed row", async () => {
    routes({
      "/api/channels/email_marketing/settings": () =>
        ok({
          fields: {
            postal_address: [
              { item: "OLD 1 Old Rd, Reno NV 89501", status: "paused" },
              { item: "OLD 2 Gone Rd, Reno NV 89501", status: "dismissed" },
              { item: "12 Elm St, Austin TX 78701", status: "active" },
            ],
            esp: [{ item: "mailchimp" }],
          },
        }),
      "/api/workspace/email-template": () => ok({ template: null, fonts: [], can_edit: true }),
    });
    mount(POSTAL_ONLY);
    await flush();
    expect(screen.queryByTestId("footer-slot")?.dataset.state).not.toBe("missing");
    expect(screen.getByTestId("blanks-left").textContent).toBe("Blanks filled");
    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("Hi *|FNAME|*,\n\nSee you soon.\n\n--\n12 Elm St, Austin TX 78701");
    expect(writeText.mock.calls[0]![0]).not.toContain("OLD");
  });

  it.each([
    ["only a paused old setting and no template row", () => ok({ template: null, fonts: [], can_edit: true }), [{ item: "OLD 1 Old Rd, Reno NV 89501", status: "paused" }], false],
    ["the template could not be read", () => fail(), [{ item: "12 Elm St, Austin TX 78701" }], true],
  ])("%s: the blank stays unfilled and Copy stays gated", async (_name, template, rows, unread) => {
    routes({
      "/api/channels/email_marketing/settings": () => ok({ fields: { postal_address: rows, esp: [{ item: "mailchimp" }] } }),
      "/api/workspace/email-template": template,
    });
    mount(POSTAL_ONLY);
    await flush();
    if (unread) {
      expect(screen.queryByTestId("footer-slot")).toBeNull();
      expect(screen.getByTestId("blank-footer-unread").textContent).toBe("Could not read your footer settings. Trying again.");
      expect(screen.queryByRole("button", { name: "Add postal address" })).toBeNull();
      const copy = screen.getByRole("button", { name: "Copy email (1 blank to fill)" });
      expect(copy.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(copy);
      await act(async () => {});
    } else {
      expect(screen.getAllByTestId("footer-slot")).toHaveLength(1);
      expect(screen.queryByRole("button", { name: /^Copy email/ })).toBeNull();
      expect(screen.getByRole("button", { name: "Add postal address" })).toBeTruthy();
    }
    expect(writeText).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/Old Rd|Elm St/);
  });

  it("a footer save makes an open card read again and fill, inside the 30s cache window", async () => {
    let template: unknown = { template: null, fonts: [], can_edit: true };
    routes({
      "/api/channels/email_marketing/settings": () => ok({ fields: { esp: [{ item: "mailchimp" }] } }),
      "/api/workspace/email-template": () => ok(template),
    });
    mount(POSTAL_ONLY);
    await flush();
    expect(screen.getByTestId("footer-slot").dataset.state).toBe("missing");
    template = { template: { postal_address: "9 Pine Rd, Reno NV 89501" }, fonts: [], can_edit: true };
    await flush();
    expect(screen.getByTestId("footer-slot").dataset.state).toBe("missing");
    await act(async () => {
      window.dispatchEvent(new CustomEvent("zavi:email-footer-saved"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("footer-slot").dataset.state).toBe("filled");
    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("Hi *|FNAME|*,\n\nSee you soon.\n\n--\n9 Pine Rd, Reno NV 89501");
  });

  it.each([
    ["the email tool's tag", { esp: [{ item: "klaviyo" }], unsubscribe_link: [{ item: "https://ignored.example/u" }] }, "{% unsubscribe_link %}"],
    ["the Footer setting", { unsubscribe_link: [{ item: "https://northside.example/unsubscribe" }] }, "https://northside.example/unsubscribe"],
  ])("the unsubscribe blank fills from %s, with no input on the card", async (_name, fields, expected) => {
    routes({ "/api/channels/email_marketing/settings": () => ok({ fields }) });
    mount(UNSUB_ONLY);
    await flush();
    expect(screen.queryByLabelText("your email tool's unsubscribe link")).toBeNull();
    expect(screen.queryByTestId("blanks-fill")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(`Hi there,\n\nSee you soon.\n\nUnsubscribe: ${expected}`);
  });

  it.each([
    ["mailchimp", "*|UNSUB|*"],
    ["klaviyo", "{% unsubscribe_link %}"],
  ])("%s connected with no esp setting: Copy is not blocked and the tool's own tag goes in", async (tool, tag) => {
    routes({ "/api/channels/email_marketing/settings": () => ok({ fields: {}, email_tool: tool }) });
    mount(UNSUB_ONLY);
    await flush();
    expect(screen.queryByText(/Unsubscribe link missing/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add unsubscribe link" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith(`Hi there,\n\nSee you soon.\n\nUnsubscribe: ${tag}`);
  });

  it("the saved esp setting still wins over the connected tool", async () => {
    routes({ "/api/channels/email_marketing/settings": () => ok({ fields: { esp: [{ item: "klaviyo" }] }, email_tool: "mailchimp" }) });
    mount(UNSUB_ONLY);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Copy email" }));
    await act(async () => {});
    expect(writeText).toHaveBeenCalledWith("Hi there,\n\nSee you soon.\n\nUnsubscribe: {% unsubscribe_link %}");
  });

  it("no single tool known: the SendGrid sender fallback and the gate both stay", async () => {
    routes({ "/api/channels/email_marketing/settings": () => ok({ fields: {}, email_tool: null }) });
    mount(UNSUB_ONLY);
    await flush();
    expect(screen.getByTestId("footer-slot").textContent).toContain("Unsubscribe link missing");
    expect(screen.queryByRole("button", { name: /^Copy email/ })).toBeNull();
  });

  it("a paused or dismissed saved unsubscribe link is never used to fill the blank", async () => {
    routes({
      "/api/channels/email_marketing/settings": () =>
        ok({ fields: { unsubscribe_link: [{ item: "https://old.example/u", status: "paused" }, { item: "https://gone.example/u", status: "dismissed" }] } }),
    });
    mount(UNSUB_ONLY);
    await flush();
    expect(screen.getByTestId("footer-slot").textContent).toContain("Unsubscribe link missing");
    expect(screen.queryByRole("button", { name: /^Copy email/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Add unsubscribe link" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("old.example");
  });

  it("no tool and no saved link: the card asks for it in Settings and Copy stays gated", async () => {
    routes({ "/api/channels/email_marketing/settings": () => ok({ fields: {} }) });
    mount(UNSUB_ONLY);
    await flush();
    expect(screen.getByTestId("footer-slot").textContent).toContain("Unsubscribe link missing");
    expect(screen.getByRole("button", { name: "Add unsubscribe link" })).toBeTruthy();
  });
});
