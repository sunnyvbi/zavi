// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/workspace/channelActionsApi";

const api = vi.hoisted(() => ({ start: vi.fn(), run: vi.fn(), context: vi.fn() }));
vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  startTopAction: api.start,
  readTopActionRun: api.run,
  readTopActionContext: api.context,
}));

import { CreateAdModal, POLL_MS } from "../CreateAdModal";
import { makeAction } from "../../__tests__/fixtures";
import { GOOGLE_ADD_KEYWORDS, META_CREATE } from "./createAdSpecs";
import { reddit_ads } from "../../platforms/reddit_ads";

beforeEach(() => {
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  api.start.mockReset().mockResolvedValue({ run_id: "run-1" });
  api.context.mockReset().mockResolvedValue({ currency: "INR" });
  api.run.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fill() {
  fireEvent.change(screen.getByLabelText("What is the ad about?"), { target: { value: "Halloween Teslas" } });
  fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://upcar.ai/halloween" } });
  fireEvent.click(screen.getByRole("radio", { name: /Buy or sign up/ }));
  fireEvent.click(screen.getByRole("radio", { name: /Instagram only/ }));
  fireEvent.change(screen.getByLabelText("Daily budget"), { target: { value: "500" } });
}

describe("CreateAdModal", () => {
  it("offers only Visit my site and Buy or sign up, and shows the account currency", async () => {
    render(<CreateAdModal slug="meta_ads" channelName="Meta Ads" action={META_CREATE} onClose={() => {}} onChanged={() => {}} />);
    await act(async () => {});
    expect(screen.queryByRole("radio", { name: /Message me/ })).toBeNull();
    expect(screen.getByText("₹")).toBeTruthy();
  });

  it("posts the inputs, polls the run and approves a filed card", async () => {
    const card = makeAction("ads_change" as never, { title: "Add 3 new ads to Halloween", status: "pending" });
    api.run.mockResolvedValueOnce({ status: "running", actions: [] }).mockResolvedValueOnce({ status: "success", actions: [card] });
    const onApprove = vi.fn(async () => true);
    const onStarted = vi.fn();
    render(<CreateAdModal slug="meta_ads" channelName="Meta Ads" action={META_CREATE} onClose={() => {}} onChanged={() => {}} onApprove={onApprove} onStarted={onStarted} />);
    fill();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
    });
    expect(api.start).toHaveBeenCalledWith("meta_ads", "create_new_ad", expect.any(String), {
      about: "Halloween Teslas",
      link: "https://upcar.ai/halloween",
      goal: "buy",
      placement: "ig",
      daily_budget: 500,
    });
    expect(onStarted).toHaveBeenCalled();
    expect(screen.getByText(/Making a plan/)).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    expect(screen.getByText("Add 3 new ads to Halloween")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    });
    expect(onApprove).toHaveBeenCalledWith(card);
    expect(screen.getByText("Approved. Zavi is making the change now.")).toBeTruthy();
  });

  it("out of credits shows the server's top-up sentence once, not a second Top up after it", async () => {
    const SERVER = "You're out of credits. Top up in Billing to keep your agents running.";
    api.start.mockRejectedValue(new ApiError(SERVER, 402, { error: { code: "insufficient_credits", message: SERVER, action: "top_up" } }));
    render(<CreateAdModal slug="meta_ads" channelName="Meta Ads" action={META_CREATE} onClose={() => {}} onChanged={() => {}} />);
    fill();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(SERVER);
    expect(document.body.textContent!.match(/top up/gi)).toHaveLength(1);
    expect(api.run).not.toHaveBeenCalled();
  });

  it("out of credits with no server sentence still says to top up, once", async () => {
    api.start.mockRejectedValue(new ApiError("", 402));
    render(<CreateAdModal slug="meta_ads" channelName="Meta Ads" action={META_CREATE} onClose={() => {}} onChanged={() => {}} />);
    fill();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("You are out of credits for this. Top up, then try again.");
    expect(document.body.textContent!.match(/top up/gi)).toHaveLength(1);
  });

  async function runTo(result: { status: string; actions: unknown[]; summary?: string | null }) {
    api.run.mockResolvedValue(result);
    const onChanged = vi.fn();
    render(<CreateAdModal slug="meta_ads" channelName="Meta Ads" action={META_CREATE} onClose={() => {}} onChanged={onChanged} />);
    fill();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });
    return onChanged;
  }

  it("a finished run with no new card shows its summary, not a failure, and refreshes the list", async () => {
    const onChanged = await runTo({ status: "success", actions: [], summary: "A matching ad is already waiting for approval." });
    expect(screen.getByText("A matching ad is already waiting for approval.")).toBeTruthy();
    expect(screen.getByText(/It may already be waiting in your list/)).toBeTruthy();
    expect(screen.queryByText(/could not make a plan/)).toBeNull();
    expect(onChanged).toHaveBeenCalled();
  });

  it("a run that actually failed shows the failure copy", async () => {
    await runTo({ status: "parse_failed", actions: [] });
    expect(screen.getByText(/could not make a plan/)).toBeTruthy();
    expect(screen.queryByTestId("top-action-nothing-new")).toBeNull();
  });

  it("says what is wrong under each field once it is left, and keeps Make a plan disabled", () => {
    render(<CreateAdModal slug="meta_ads" channelName="Meta Ads" action={META_CREATE} onClose={() => {}} onChanged={() => {}} />);
    const link = screen.getByLabelText("Link");
    fireEvent.change(link, { target: { value: "https://upcar" } });
    expect(screen.queryByText(/starts with https:\/\//)).toBeNull();
    fireEvent.blur(link);
    expect(screen.getByText(/Enter a full link that starts with https:\/\//)).toBeTruthy();
    expect(link.getAttribute("aria-invalid")).toBe("true");
    const about = screen.getByLabelText("What is the ad about?");
    fireEvent.change(about, { target: { value: "x" } });
    fireEvent.change(about, { target: { value: "  " } });
    fireEvent.blur(about);
    expect(screen.getByText("Say what the ad is about.")).toBeTruthy();
    const budget = screen.getByLabelText("Daily budget");
    fireEvent.change(budget, { target: { value: "abc" } });
    fireEvent.blur(budget);
    expect(screen.getByText("Enter a daily budget above 0.")).toBeTruthy();
    fireEvent.change(budget, { target: { value: "0" } });
    expect(screen.getByText("Enter a daily budget above 0.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Make a plan" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(link, { target: { value: "https://upcar.ai/h" } });
    expect(screen.queryByText(/Enter a full link/)).toBeNull();
  });

  it("lays the two goal tiles out in two columns", () => {
    render(<CreateAdModal slug="meta_ads" channelName="Meta Ads" action={META_CREATE} onClose={() => {}} onChanged={() => {}} />);
    expect(screen.getByRole("radiogroup", { name: "What should people do?" }).className).toContain("sm:grid-cols-2");
    expect(screen.getByRole("radiogroup", { name: "Shows on" }).className).toContain("sm:grid-cols-3");
  });

  it("will not submit without an https link", () => {
    render(<CreateAdModal slug="meta_ads" channelName="Meta Ads" action={META_CREATE} onClose={() => {}} onChanged={() => {}} />);
    fireEvent.change(screen.getByLabelText("What is the ad about?"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "http://upcar.ai" } });
    expect((screen.getByRole("button", { name: "Make a plan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("is driven by the row: Google's Add keywords picks an ad group from the account and posts its id", async () => {
    api.context.mockResolvedValue({ ad_groups: [{ id: "111", label: "Car rental LA (Search LA)" }] });
    api.run.mockResolvedValue({ status: "running", actions: [] });
    render(<CreateAdModal slug="google_ads" channelName="Google Ads" action={GOOGLE_ADD_KEYWORDS} onClose={() => {}} onChanged={() => {}} />);
    await act(async () => {});
    expect(api.context).toHaveBeenCalledWith("google_ads", "add_keywords");
    expect(screen.getByRole("dialog", { name: "Add keywords" })).toBeTruthy();
    const find = screen.getByRole("button", { name: "Find keywords" }) as HTMLButtonElement;
    expect(find.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Ad group"), { target: { value: "111" } });
    fireEvent.change(screen.getByLabelText("Ideas to start from (optional)"), { target: { value: "tesla rental" } });
    await act(async () => {
      fireEvent.click(find);
    });
    expect(api.start).toHaveBeenCalledWith("google_ads", "add_keywords", expect.any(String), { ad_group_id: "111", ideas: "tesla rental" });
  });

});

describe("CreateAdModal: Reddit countries", () => {
  const REDDIT_CREATE = reddit_ads.topActions![0];
  function fillReddit() {
    fireEvent.change(screen.getByLabelText("What is the ad about?"), { target: { value: "Road trip rentals" } });
    fireEvent.change(screen.getByLabelText("Link"), { target: { value: "https://upcar.ai/trips" } });
  }
  const plan = () => screen.getByRole("button", { name: "Make a plan" }) as HTMLButtonElement;
  const open = async () => {
    render(<CreateAdModal slug="reddit_ads" channelName="Reddit Ads" action={REDDIT_CREATE} onClose={() => {}} onChanged={() => {}} />);
    await act(async () => {});
    fillReddit();
  };
  function pick(field: string, search: string, name: string) {
    const box = screen.getByLabelText(field);
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: search } });
    fireEvent.click(screen.getByRole("option", { name: new RegExp(`^${name}\\b`) }));
    fireEvent.blur(box);
  }

  it("leaves both lists out when nothing is picked", async () => {
    await open();
    await act(async () => {
      fireEvent.click(plan());
    });
    expect(api.start).toHaveBeenLastCalledWith("reddit_ads", "create_new_ad", expect.any(String), { about: "Road trip rentals", link: "https://upcar.ai/trips", daily_budget: 20 });
  });

  it("searches by name or code and sends the picked countries as codes", async () => {
    await open();
    pick("Target countries", "united st", "United States");
    pick("Target countries", "ca", "Canada");
    pick("Exclude countries", "united k", "United Kingdom");
    expect(screen.getByRole("button", { name: "Remove Canada" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(plan());
    });
    expect(api.start).toHaveBeenLastCalledWith("reddit_ads", "create_new_ad", expect.any(String), { about: "Road trip rentals", link: "https://upcar.ai/trips", daily_budget: 20, countries: "US, CA", excluded_countries: "GB" });
  });

  it("a targeted country cannot be excluded, and removing a chip frees it", async () => {
    await open();
    pick("Target countries", "india", "India");
    const exclude = screen.getByLabelText("Exclude countries");
    fireEvent.focus(exclude);
    fireEvent.change(exclude, { target: { value: "india" } });
    const india = screen.getByRole("option", { name: /^India\b/ });
    expect(india.getAttribute("aria-disabled")).toBe("true");
    expect(india.textContent).toContain("Targeted");
    fireEvent.click(india);
    expect(screen.queryByRole("button", { name: "Remove India" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Remove India" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove India" }));
    fireEvent.change(exclude, { target: { value: "india" } });
    expect(screen.getByRole("option", { name: /^India\b/ }).getAttribute("aria-disabled")).toBeNull();
  });

  it("picks with the keyboard and removes the last chip with Backspace", async () => {
    await open();
    const box = screen.getByLabelText("Target countries");
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: "japan" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByRole("button", { name: "Remove Japan" })).toBeTruthy();
    fireEvent.keyDown(box, { key: "Backspace" });
    expect(screen.queryByRole("button", { name: "Remove Japan" })).toBeNull();
    fireEvent.change(box, { target: { value: "zzzz" } });
    expect(screen.getByText(/No country matches/)).toBeTruthy();
  });
});

describe("CreateAdModal never starts a second paid plan for one ask", () => {
  const ids = () => api.start.mock.calls.map((c) => c[2] as string);

  async function press() {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Make a plan" }));
    });
  }

  function open() {
    api.run.mockResolvedValue({ status: "running", actions: [] });
    render(<CreateAdModal slug="meta_ads" channelName="Meta Ads" action={META_CREATE} onClose={() => {}} onChanged={() => {}} />);
    fill();
  }

  it("a timed-out start that the server admitted, then a retry, sends the same request id", async () => {
    api.start.mockRejectedValueOnce(new ApiError("Zavi took too long to answer. Try again.", 0)).mockResolvedValue({ run_id: "run-1" });
    open();
    await press();
    expect(screen.getByRole("alert")).toBeTruthy();
    await press();
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(new Set(ids()).size).toBe(1);
  });

  it("a dropped connection, then a retry, sends the same request id", async () => {
    api.start.mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue({ run_id: "run-1" });
    open();
    await press();
    await press();
    expect(new Set(ids()).size).toBe(1);
  });

  it("a 5xx with no reason keeps the request id", async () => {
    api.start.mockRejectedValueOnce(new ApiError("", 503)).mockResolvedValue({ run_id: "run-1" });
    open();
    await press();
    await press();
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(new Set(ids()).size).toBe(1);
  });

  it("a 4xx refusal rotates the request id, so the fixed form is a new ask", async () => {
    api.start.mockRejectedValueOnce(new ApiError("Check the form and try again.", 400)).mockResolvedValue({ run_id: "run-1" });
    open();
    await press();
    await press();
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(new Set(ids()).size).toBe(2);
  });

  it("a changed form after a timeout is a new ask with a new request id", async () => {
    api.start.mockRejectedValueOnce(new ApiError("Zavi took too long to answer. Try again.", 0)).mockResolvedValue({ run_id: "run-1" });
    open();
    await press();
    fireEvent.change(screen.getByLabelText("Daily budget"), { target: { value: "900" } });
    await press();
    expect(api.start).toHaveBeenCalledTimes(2);
    expect(api.start.mock.calls[1][3]).toMatchObject({ daily_budget: 900 });
    expect(new Set(ids()).size).toBe(2);
  });
});
