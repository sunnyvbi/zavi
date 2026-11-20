// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";

const h = vi.hoisted(() => ({ posts: [] as unknown[], status: 200 }));
vi.mock("@/lib/api", () => ({
  apiFetch: async (_url: string, init: { body: string }) => {
    h.posts.push(JSON.parse(init.body));
    return new Response("{}", { status: h.status });
  },
}));
import { saveSetupAnswers, SetupQuestionsStep, type SetupAnswers } from "./SetupQuestionsStep";

function Step(props: Omit<ComponentProps<typeof SetupQuestionsStep>, "answers" | "onChange">) {
  const [answers, setAnswers] = useState<SetupAnswers>({});
  return <SetupQuestionsStep {...props} answers={answers} onChange={setAnswers} />;
}

afterEach(() => { cleanup(); h.posts = []; h.status = 200; });

describe("SetupQuestionsStep", () => {
  it("shows Build my strategy only once something is answered, and hands over the picks", async () => {
    const onFinish = vi.fn(async () => {});
    render(<Step onBack={() => {}} onSkip={async () => {}} onFinish={onFinish} />);
    expect(screen.queryByRole("button", { name: /Build my strategy/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "They look, but don't buy" }));
    fireEvent.click(screen.getByRole("button", { name: "Word of mouth from a customer" }));
    fireEvent.click(screen.getByRole("button", { name: "We paid for ads" }));
    expect(screen.queryByRole("button", { name: "6-20" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Build my strategy/ }));
    await waitFor(() => expect(onFinish).toHaveBeenCalledWith({
      constraint: ["They look, but don't buy"],
      channels: ["Word of mouth from a customer", "We paid for ads"],
    }));
  });
  it("Build my strategy is a filled button: bg-cream would beat its fill inside the workspace shell", () => {
    render(<Step onBack={() => {}} onSkip={async () => {}} onFinish={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Customers worth more" }));
    const classes = screen.getByRole("button", { name: /Build my strategy/ }).className.split(/\s+/);
    expect(classes).toContain("bg-ink");
    expect(classes).not.toContain("bg-cream");
  });
  it("lists the three questions as steps at the top and ticks one off when it is answered", () => {
    render(<Step onBack={() => {}} onSkip={async () => {}} onFinish={async () => {}} />);
    const steps = within(screen.getByRole("navigation", { name: "Questions" }));
    expect(steps.getAllByRole("button")).toHaveLength(3);
    expect(steps.getByRole("button", { name: "Question 3 of 3: Start with" })).toBeTruthy();
    expect(screen.getByText("Pick any")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Customers worth more" }));
    expect(steps.getByRole("button", { name: "Question 1 of 3: Goal, answered" })).toBeTruthy();
    expect(steps.getByRole("button", { name: "Question 2 of 3: Holding you back" })).toBeTruthy();
  });
  it("brings the next question into view after a pick, and a step jumps to its question", () => {
    const scrolled: Array<{ legend: string; block?: string }> = [];
    Element.prototype.scrollIntoView = function (this: Element, opts?: boolean | ScrollIntoViewOptions) {
      scrolled.push({ legend: this.querySelector("legend")?.textContent ?? "", block: typeof opts === "object" ? opts.block : undefined });
    };
    render(<Step onBack={() => {}} onSkip={async () => {}} onFinish={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Customers worth more" }));
    expect(scrolled).toHaveLength(1);
    expect(scrolled[0].legend).toContain("Where do you lose people?");
    expect(scrolled[0].block).toBe("nearest");
    fireEvent.click(screen.getByRole("button", { name: "Customers worth more" }));
    fireEvent.click(screen.getByRole("button", { name: "We paid for ads" }));
    expect(scrolled).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Question 3 of 3: Start with, answered" }));
    expect(scrolled[1].legend).toContain("How did they find you?");
    expect(scrolled[1].block).toBe("start");
  });
  it("tapping a picked chip again clears it", () => {
    render(<Step onBack={() => {}} onSkip={async () => {}} onFinish={async () => {}} />);
    const chip = screen.getByRole("button", { name: "Customers worth more" });
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByRole("button", { name: /Build my strategy/ })).toBeNull();
  });
  it("each pick writes its row on the strategy card, and the bar fills a third per answer", () => {
    render(<Step onBack={() => {}} onSkip={async () => {}} onFinish={async () => {}} />);
    const bar = () => screen.getByRole("progressbar", { name: "Strategy written" });
    expect(screen.getByText("Your answers write the plan")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "Not answered yet" })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "More people finding us" }));
    expect(screen.getByText("More people finding you")).toBeTruthy();
    expect(screen.getByText("Measured by new visitors a month")).toBeTruthy();
    expect(screen.getByText("Zavi is writing it with you…")).toBeTruthy();
    expect(bar().getAttribute("aria-valuenow")).toBe("1");
    fireEvent.click(screen.getByRole("button", { name: "They sign up, then never get going" }));
    expect(screen.getByText("Zavi starts with nudges that get them to their first win.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Saw us on social" }));
    expect(screen.getByText("Social posts and Reels, 3 a week")).toBeTruthy();
    expect(screen.getByText("Ready to build")).toBeTruthy();
    expect(bar().getAttribute("aria-valuenow")).toBe("3");
  });
  it("Nothing repeatable yet clears the other channel picks, and another pick clears it", () => {
    render(<Step onBack={() => {}} onSkip={async () => {}} onFinish={async () => {}} />);
    const chip = (name: string) => screen.getByRole("button", { name });
    fireEvent.click(chip("We paid for ads"));
    fireEvent.click(chip("Nothing repeatable yet"));
    expect(chip("We paid for ads").getAttribute("aria-pressed")).toBe("false");
    expect(chip("Nothing repeatable yet").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip("Saw us on social"));
    expect(chip("Nothing repeatable yet").getAttribute("aria-pressed")).toBe("false");
    expect(chip("Saw us on social").getAttribute("aria-pressed")).toBe("true");
  });
  it("saves each answered question once, joining multi picks, and keeps going past a failed save", async () => {
    h.status = 500;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await saveSetupAnswers({ metric: ["More of them actually buying"], channels: ["Saw us on social", "We paid for ads"], constraint: [] })).toBe(false);
    expect(h.posts).toEqual([
      { key: "metric", answer: "More of them actually buying" },
      { key: "channels", answer: "Saw us on social, We paid for ads" },
    ]);
  });
});
