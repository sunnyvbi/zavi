import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { AdsPresentation } from "../ads/AdsPresentation";
import { platformFor } from "../platforms";
import type { ActionHandlers, ActionItem } from "../types";
import { makeAction } from "./fixtures";

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })),
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));

afterEach(cleanup);

let writeText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

const COUNTRIES = "[fill in: the countries you want signups from]";
const INDUSTRY = "[Industry: fill in the industries your buyers work in]";
const AUDIENCES = `Audience 1, warm: Locations ${COUNTRIES}. Job function Operations.\nAudience 2, cold: ${INDUSTRY}, company size 51-500.`;

const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });

const audienceCard = (): ActionItem =>
  makeAction("check", {
    channel_slug: "meta_ads",
    title: "Save these two audiences in Campaign Manager",
    body: { step: { title: "Save these two audiences in Campaign Manager", body: "Two audiences to save.", deliverable: { kind: "doc", label: "Audiences", content: AUDIENCES } } },
    card_kind: "task",
    primary_label: "Review audience",
    done_label: "I saved them",
    how_to: ["Open Campaign Manager audiences.", "Save both audiences."],
  } as Partial<ActionItem>);

const renderAds = (action: ActionItem) => {
  const props = { action, handlers: handlers(), platform: platformFor(action.channel_slug) };
  return render(
    <AdsPresentation value={props}>
      <ChannelActionCard {...props} />
    </AdsPresentation>,
  );
};

const copyWithBlanks = async () => {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: /^Copy with blanks/ }));
  await act(async () => {});
};
const line = () => screen.queryByTestId("copy-blanks")?.textContent ?? null;
const shown = () => (screen.queryByTestId("card-copy-text") ?? screen.getByTestId("action-deliverable")).textContent ?? "";

describe("audience card: the Fill before sending line follows the fills", () => {
  it("copy with blanks, fill one at a time: the line shrinks, then goes; clearing a fill brings it back", async () => {
    renderAds(audienceCard());
    await copyWithBlanks();
    expect(writeText).toHaveBeenLastCalledWith(AUDIENCES);
    expect(line()).toBe("Fill before sending: [fill in: the countries you want signup…], [Industry: fill in the industries your…]");

    fireEvent.change(screen.getByLabelText(/countries you want signups from/i), { target: { value: "United States, Canada" } });
    await act(async () => {});
    expect(line()).toBe("Fill before sending: [Industry: fill in the industries your…]");
    expect(shown()).toContain("Locations United States, Canada.");
    expect(shown()).not.toContain(COUNTRIES);
    expect(shown()).toContain(INDUSTRY);

    fireEvent.change(screen.getByLabelText(/industries your buyers work in/i), { target: { value: "Software Development 🚀" } });
    await act(async () => {});
    expect(screen.getByTestId("blanks-fill").textContent).toContain("All filled in");
    expect(line()).toBeNull();
    expect(shown()).toContain("Software Development 🚀, company size 51-500.");
    expect(shown()).not.toMatch(/\[fill in|\[Industry/);

    fireEvent.change(screen.getByLabelText(/countries you want signups from/i), { target: { value: "" } });
    await act(async () => {});
    expect(line()).toBe("Fill before sending: [fill in: the countries you want signup…]");
    expect(shown()).toContain(COUNTRIES);
    expect(shown()).toContain("Software Development 🚀");

    fireEvent.change(screen.getByLabelText(/countries you want signups from/i), { target: { value: "United States, Canada" } });
    await act(async () => {});
    expect(line()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /^Copy(?! with)(?! all)/ }));
    await act(async () => {});
    expect(writeText).toHaveBeenLastCalledWith(
      "Audience 1, warm: Locations United States, Canada. Job function Operations.\nAudience 2, cold: Software Development 🚀, company size 51-500.",
    );
    expect(line()).toBeNull();

    fireEvent.change(screen.getByLabelText(/countries you want signups from/i), { target: { value: "" } });
    await act(async () => {});
    expect(line()).toBeNull();
  });

  it("filled before any copy: no line appears at all", async () => {
    renderAds(audienceCard());
    fireEvent.change(screen.getByLabelText(/countries you want signups from/i), { target: { value: "United States" } });
    fireEvent.change(screen.getByLabelText(/industries your buyers work in/i), { target: { value: "Software Development" } });
    await act(async () => {});
    expect(line()).toBeNull();
  });
});

describe("another channel's card keeps the same live line", () => {
  it("a geo page: copy with blanks names both, filling one drops it, filling both clears the line, the box shows the values", async () => {
    const a = makeAction("page", {
      channel_slug: "geo",
      title: "Publish the page",
      card_kind: "copy_to_site",
      primary_label: "Copy new text",
      done_label: "I updated the page",
      body: { step: { body: "b", deliverable: { kind: "page", label: "Page copy", content: "Serving [city] since [FOUNDER: year]." } } },
    });
    render(<ChannelActionCard action={a} platform={platformFor("geo")} handlers={handlers()} />);
    await copyWithBlanks();
    expect(writeText).toHaveBeenLastCalledWith("Serving [city] since [FOUNDER: year].");
    expect(line()).toBe("Fill before sending: [city], [FOUNDER: year]");
    fireEvent.change(screen.getByLabelText("city"), { target: { value: "Austin" } });
    await act(async () => {});
    expect(line()).toBe("Fill before sending: [FOUNDER: year]");
    fireEvent.change(screen.getByLabelText(/year/i), { target: { value: "2019" } });
    await act(async () => {});
    expect(line()).toBeNull();
    expect(shown()).toContain("Serving Austin since 2019.");
  });
});
