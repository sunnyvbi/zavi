// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TemplateGallery, TEMPLATES_USE, type UsedTemplate } from "./TemplateGallery";
import { blankQuestion, fillTemplateIdea, resetSiteTemplatesCache, templateBlanks } from "@/lib/workspace/siteTemplates";

const THEME = ":root { --background: 255 255 255; }";
const PREVIEW = { name: "Your business", headline: "Hello", hero_variant: "split", sections: [{ title: "Services", body: "What we offer", kind: "Features", variant: "cards" }] };
const card = (id: string, label: string, idea: string) => ({
  id,
  label,
  blurb: `${label} blurb`,
  good_for: "Anyone",
  idea,
  layout: "split",
  fonts: { display: "DM Sans", body: "Inter" },
  theme_css: THEME,
  preview: PREVIEW,
});
const CAFE_IDEA = "A website for my [café, restaurant or bakery] called [name] in [town]. People in [town] can order ahead.";
const CATALOG = {
  templates: [
    card("menu-and-hours", "Menu and opening hours", CAFE_IDEA),
    card("plain-page", "Plain page", "A simple one-page site that says what we do and how to reach us."),
  ],
};

function dialogBox() {
  return screen.getByRole("dialog");
}
function answerBox() {
  return within(dialogBox()).getByRole("textbox") as HTMLInputElement;
}
function nextButton() {
  return within(dialogBox()).getByRole("button", { name: "Next" }) as HTMLButtonElement;
}

async function openAndPick(id: string) {
  const onUse = vi.fn<[UsedTemplate], void>();
  render(<TemplateGallery selectedId={null} onUse={onUse} />);
  const trigger = screen.getByTestId("templates-open");
  trigger.focus();
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByTestId(`template-${id}`));
  return { onUse, trigger };
}

beforeEach(() => {
  resetSiteTemplatesCache();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => CATALOG })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("blank questions", () => {
  it("turns every catalog blank into a question, and fills each repeated blank everywhere", () => {
    expect(
      [
        "[type of business]",
        "[town or area]",
        "[services and their prices]",
        "[café, restaurant or bakery]",
        "[name]",
        "[opening hours]",
        "[address]",
        "[product name]",
        "[what it is]",
        "[who it is for]",
        "[who you help]",
        "[what you help with]",
        "[name of the group]",
      ].map(blankQuestion),
    ).toEqual([
      "What type of business is it?",
      "Which town or area is it in?",
      "What are your services and their prices?",
      "Which is it: café, restaurant or bakery?",
      "What is the name?",
      "What are your opening hours?",
      "What is the address?",
      "What is the product name?",
      "What is it?",
      "Who is it for?",
      "Who do you help?",
      "What do you help with?",
      "What is the name of the group?",
    ]);
    expect(templateBlanks(CAFE_IDEA)).toEqual(["[café, restaurant or bakery]", "[name]", "[town]"]);
    expect(fillTemplateIdea(CAFE_IDEA, { "[café, restaurant or bakery]": " bakery ", "[name]": "Crumb [x]", "[town]": "Leeds" })).toBe(
      "A website for my bakery called Crumb x in Leeds. People in Leeds can order ahead.",
    );
  });
});

describe("TemplateGallery dialog", () => {
  it("opens as a labelled modal and moves focus into it", async () => {
    render(<TemplateGallery selectedId={null} onUse={vi.fn()} />);
    fireEvent.click(screen.getByTestId("templates-open"));
    const dialog = screen.getByRole("dialog", { name: "Start from a template" });
    expect(dialog.hasAttribute("open")).toBe(true);
    const first = await screen.findByTestId("template-menu-and-hours");
    expect(document.activeElement).toBe(first);
  });

  it("asks one blank at a time: Enter and Next both advance, an empty answer cannot, Back keeps answers, and Use fills every bracket", async () => {
    const { onUse } = await openAndPick("menu-and-hours");
    expect(screen.getByRole("dialog", { name: "Menu and opening hours" })).toBeTruthy();
    expect(screen.getByTestId("template-step-progress").textContent).toBe("1 of 3");
    expect(within(dialogBox()).getByLabelText("Which is it: café, restaurant or bakery?")).toBe(answerBox());
    expect(document.activeElement).toBe(answerBox());

    expect(nextButton().disabled).toBe(true);
    fireEvent.change(answerBox(), { target: { value: "   " } });
    fireEvent.keyDown(answerBox(), { key: "Enter" });
    expect(nextButton().disabled).toBe(true);
    expect(screen.getByTestId("template-step-progress").textContent).toBe("1 of 3");

    fireEvent.change(answerBox(), { target: { value: "bakery" } });
    fireEvent.keyDown(answerBox(), { key: "Enter" });
    expect(screen.getByTestId("template-step-progress").textContent).toBe("2 of 3");
    expect(answerBox().value).toBe("");
    expect(screen.getByTestId("template-idea-preview").textContent).toBe(
      "A website for my bakery called [name] in [town]. People in [town] can order ahead.",
    );

    fireEvent.change(answerBox(), { target: { value: "Crumb" } });
    fireEvent.click(nextButton());
    expect(screen.getByTestId("template-step-progress").textContent).toBe("3 of 3");
    expect(within(dialogBox()).getByLabelText("Which town is it in?")).toBeTruthy();

    fireEvent.click(within(dialogBox()).getByRole("button", { name: "Back" }));
    expect(screen.getByTestId("template-step-progress").textContent).toBe("2 of 3");
    expect(answerBox().value).toBe("Crumb");
    fireEvent.click(within(dialogBox()).getByRole("button", { name: "Back" }));
    expect(answerBox().value).toBe("bakery");
    fireEvent.keyDown(answerBox(), { key: "Enter" });
    fireEvent.keyDown(answerBox(), { key: "Enter" });

    fireEvent.change(answerBox(), { target: { value: "Leeds" } });
    fireEvent.click(nextButton());
    const filled = "A website for my bakery called Crumb in Leeds. People in Leeds can order ahead.";
    expect(screen.getByTestId("template-filled-idea").textContent).toBe(filled);
    const use = within(dialogBox()).getByRole("button", { name: TEMPLATES_USE });
    expect(document.activeElement).toBe(use);
    expect(onUse).not.toHaveBeenCalled();
    fireEvent.click(use);
    expect(onUse).toHaveBeenCalledTimes(1);
    expect(onUse).toHaveBeenCalledWith({ template: { id: "menu-and-hours", label: "Menu and opening hours", idea: CAFE_IDEA }, idea: filled });
    expect(filled).not.toMatch(/[[\]]/);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a template with no blanks goes straight to the confirm step", async () => {
    const { onUse } = await openAndPick("plain-page");
    expect(within(dialogBox()).queryByRole("textbox")).toBeNull();
    expect(screen.queryByTestId("template-step-progress")).toBeNull();
    fireEvent.click(within(dialogBox()).getByRole("button", { name: TEMPLATES_USE }));
    expect(onUse).toHaveBeenCalledWith({
      template: { id: "plain-page", label: "Plain page", idea: CATALOG.templates[1]!.idea },
      idea: CATALOG.templates[1]!.idea,
    });
  });

  it("All templates goes back to the list, and a new pick starts with empty answers", async () => {
    await openAndPick("menu-and-hours");
    fireEvent.change(answerBox(), { target: { value: "café" } });
    fireEvent.click(within(dialogBox()).getByRole("button", { name: "All templates" }));
    expect(screen.getByRole("dialog", { name: "Start from a template" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByTestId("template-menu-and-hours"));
    fireEvent.click(screen.getByTestId("template-menu-and-hours"));
    expect(answerBox().value).toBe("");
  });

  it("Escape closes without using the template and returns focus to the trigger", async () => {
    const { onUse, trigger } = await openAndPick("menu-and-hours");
    fireEvent.change(answerBox(), { target: { value: "bakery" } });
    fireEvent.keyDown(answerBox(), { key: "Enter" });
    const e = new Event("cancel", { cancelable: true });
    fireEvent(dialogBox(), e);
    expect(e.defaultPrevented).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onUse).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("the close button and a scrim click cancel too", async () => {
    const { onUse, trigger } = await openAndPick("plain-page");
    fireEvent.click(within(dialogBox()).getByRole("button", { name: "Close templates" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    const dialog = dialogBox();
    dialog.getBoundingClientRect = () => ({ left: 100, top: 100, right: 500, bottom: 400, width: 400, height: 300, x: 100, y: 100, toJSON() {} }) as DOMRect;
    fireEvent.mouseDown(dialog, { clientX: 10, clientY: 10 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onUse).not.toHaveBeenCalled();
  });
});
