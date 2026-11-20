// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const calls: Array<{ path: string; method?: string; body?: Record<string, unknown> }> = [];
let saveReply: Record<string, unknown> = { ok: true };
vi.mock("@/lib/api", () => ({
  apiFetch: async (path: string, opts?: { method?: string; body?: string }) => {
    calls.push({ path, method: opts?.method, body: opts?.body ? JSON.parse(opts.body) : undefined });
    const body = path.includes("current-value")
      ? { measured: true, value: 994, source_label: "Stripe" }
      : saveReply;
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  },
}));

import { GoalEditor, type Goal } from "./AutopilotGoalsPanel";

const mrr: Goal = {
  id: "goal-1",
  objective: "Grow monthly recurring revenue",
  target_metric: "mrr",
  target_value: 100000,
  baseline_value: 500,
  current_value: 900,
  due_date: "2026-12-31",
  status: "active",
  priority: 50,
  source: "founder",
  created_at: "",
  updated_at: "",
  measurement_mode: "manual_reported",
};

beforeEach(() => {
  calls.length = 0;
  saveReply = { ok: true };
});
afterEach(cleanup);

const box = () => screen.getByLabelText("Current value") as HTMLInputElement;
const saved = () => calls.find((c) => c.method === "PATCH" || c.method === "POST")!;

async function openEditor(goal: Goal | null = mrr) {
  const onSaved = vi.fn(async () => {});
  render(<GoalEditor goal={goal} onClose={() => {}} onSaved={onSaved} />);
  await screen.findByText(/Stripe reads \$994\./, undefined, { timeout: 2000 });
  return onSaved;
}

describe("the current value is always the founder's", () => {
  it("is editable for an MRR goal a source can read", async () => {
    await openEditor();
    expect(box().readOnly).toBe(false);
    expect(box().value).toBe("900");
    fireEvent.change(box(), { target: { value: "950" } });
    expect(box().value).toBe("950");
  });

  it("'Use it' fills the box, and saving it makes the goal measured by the source", async () => {
    const onSaved = await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    expect(box().value).toBe("994");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved().body).toMatchObject({ current_value: 994, measurement_mode: "auto" });
  });

  it("a number the founder types instead is theirs: manual_reported", async () => {
    const onSaved = await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    fireEvent.change(box(), { target: { value: "1000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved().body).toMatchObject({ current_value: 1000, measurement_mode: "manual_reported" });
  });

  it("an edit that leaves the box alone keeps the goal's mode and sends no number", async () => {
    const onSaved = await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved().body).not.toHaveProperty("measurement_mode");
    expect(saved().body).not.toHaveProperty("current_value");
  });
});

describe("review fixes", () => {
  it("forgets 'Use it' when the metric changes: the number is then the founder's", async () => {
    const onSaved = await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "arr" } });
    await screen.findByText(/Stripe reads \$994\./, undefined, { timeout: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved().body).toMatchObject({ current_value: 994, measurement_mode: "manual_reported" });
  });

  it("shows a create warning instead of closing, and closes on Done without saving twice", async () => {
    saveReply = { ok: true, id: "g-new", warnings: ["The goal was saved, but its current value was not. Add it again from Edit."] };
    const saved2 = vi.fn(async () => {});
    render(<GoalEditor goal={null} initialObjective="Grow monthly recurring revenue" onClose={() => {}} onSaved={saved2} />);
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "mrr" } });
    fireEvent.change(screen.getByLabelText("Target value"), { target: { value: "100000" } });
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-12-31" } });
    fireEvent.change(box(), { target: { value: "1200" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/current value was not/)).toBeTruthy();
    expect(saved2).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(saved2).toHaveBeenCalled());
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });
});

describe("last review round", () => {
  it("an auto MRR goal moved to ARR without 'Use it' becomes the founder's number", async () => {
    const onSaved = await openEditor({ ...mrr, measurement_mode: "auto" });
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "arr" } });
    await screen.findByText(/Stripe reads \$994\./, undefined, { timeout: 2000 });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved().body).toMatchObject({ target_metric: "arr", current_value: 900, measurement_mode: "manual_reported" });
  });

  async function createWithWarning() {
    saveReply = { ok: true, id: "g-new", warnings: ["The goal was saved, but its current value was not. Add it again from Edit."] };
    const onSaved = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<GoalEditor goal={null} initialObjective="Grow monthly recurring revenue" onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "mrr" } });
    fireEvent.change(screen.getByLabelText("Target value"), { target: { value: "100000" } });
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-12-31" } });
    fireEvent.change(box(), { target: { value: "1200" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText(/current value was not/);
    return { onSaved, onClose };
  }

  it("X after a create warning refreshes the list instead of a plain close", async () => {
    const { onSaved, onClose } = await createWithWarning();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Cancel and Escape after a create warning also refresh", async () => {
    const first = await createWithWarning();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(first.onSaved).toHaveBeenCalled());
    expect(first.onClose).not.toHaveBeenCalled();
    cleanup();
    calls.length = 0;
    const second = await createWithWarning();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(second.onSaved).toHaveBeenCalled());
    expect(second.onClose).not.toHaveBeenCalled();
  });

  it("without a warning, X is a plain close", async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn(async () => {});
    render(<GoalEditor goal={mrr} onClose={onClose} onSaved={onSaved} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });
});

describe("how the typed number counts (value_kind)", () => {
  const kindBox = () => screen.getByLabelText("How does this number count?") as HTMLSelectElement;

  it("a period total is sent with its start day", async () => {
    const onSaved = await openEditor();
    fireEvent.change(kindBox(), { target: { value: "period_total" } });
    fireEvent.change(screen.getByLabelText("Counted from"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved().body).toMatchObject({ value_kind: "period_total", value_period_start: "2026-10-01" });
  });

  it("a stored kind is shown, and a running number drops the start day", async () => {
    const onSaved = await openEditor({ ...mrr, value_kind: "period_total", value_period_start: "2026-10-01" });
    expect(kindBox().value).toBe("period_total");
    fireEvent.change(kindBox(), { target: { value: "gauge" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved().body).toMatchObject({ value_kind: "gauge", value_period_start: null });
  });

  it("is not offered or sent once the founder takes the connected source's number", async () => {
    const onSaved = await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Use it" }));
    expect(screen.queryByLabelText("How does this number count?")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved().body).not.toHaveProperty("value_kind");
  });
});

describe("a new metric resets how the number counts", () => {
  it("shows 'Not said yet' and sends no kind until the founder picks again", async () => {
    const onSaved = await openEditor({ ...mrr, value_kind: "period_total", value_period_start: "2026-10-01" });
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "signups" } });
    const kindBox = screen.getByLabelText("How does this number count?") as HTMLSelectElement;
    expect(kindBox.value).toBe("");
    fireEvent.change(box(), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved().body).not.toHaveProperty("value_kind");
  });
});

describe("a kind belongs to the metric it was picked for", () => {
  it("picked after one metric change, it resets again on the next", async () => {
    const onSaved = await openEditor({ ...mrr, value_kind: "gauge" });
    const kindBox = () => screen.getByLabelText("How does this number count?") as HTMLSelectElement;
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "signups" } });
    fireEvent.change(kindBox(), { target: { value: "period_total" } });
    expect(screen.getByText(/Counted from 0 on this day/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "bookings" } });
    expect(kindBox().value).toBe("");
    expect(screen.queryByText(/Counted from 0 on this day/)).toBeNull();
    fireEvent.change(box(), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(saved().body).not.toHaveProperty("value_kind");
  });
});

describe("a new goal's kind belongs to its metric too", () => {
  it("picked for one metric, then the metric changes before saving: no longer shown", async () => {
    const onSaved = vi.fn(async () => {});
    render(<GoalEditor goal={null} onClose={() => {}} onSaved={onSaved} />);
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "signups" } });
    const kindBox = () => screen.getByLabelText("How does this number count?") as HTMLSelectElement;
    fireEvent.change(kindBox(), { target: { value: "gauge" } });
    expect(kindBox().value).toBe("gauge");
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "bookings" } });
    expect(kindBox().value).toBe("");
  });
});

describe("back on the goal's own metric", () => {
  it("shows the stored choice again, not 'Not said yet'", async () => {
    await openEditor({ ...mrr, value_kind: "period_total", value_period_start: "2026-10-01" });
    const kindBox = () => screen.getByLabelText("How does this number count?") as HTMLSelectElement;
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "signups" } });
    fireEvent.change(kindBox(), { target: { value: "gauge" } });
    fireEvent.change(screen.getByLabelText("Metric"), { target: { value: "mrr" } });
    await waitFor(() => expect(kindBox().value).toBe("period_total"));
    expect((screen.getByLabelText("Counted from") as HTMLInputElement).value).toBe("2026-10-01");
  });
});
