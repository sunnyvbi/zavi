// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { MoveCard } from "./MoveCard";
import type { MoveView } from "@/lib/approvals/decisionApi";

const RAISE = "aaaaaaaa-0000-4000-8000-000000000001";
const CUT = "aaaaaaaa-0000-4000-8000-000000000002";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const line = (o: Partial<MoveView["lines"][number]>): MoveView["lines"][number] => ({ id: RAISE, decision_class: "google_ads.update_campaign_budget_review", title: "Raise Atlanta from $40 to $70 a day", status: "proposed", side: "adds", daily_delta_usd: 30, dispatch_error: null, waits_on_cuts: false, blocked: null, ...o });
const cut = (o: Partial<MoveView["lines"][number]> = {}) => line({ id: CUT, title: "Cut Dallas from $40 to $10 a day", side: "lowers", daily_delta_usd: -30, ...o });
const move = (lines: MoveView["lines"]): MoveView => ({ key: "run-root", still_filing: false, lines });
const calls = (op: string) => apiFetch.mock.calls.filter((c) => String(c[0]).endsWith(`/${op}`));
const bodyOf = (c: unknown[]) => JSON.parse(String((c[1] as { body?: string }).body ?? "{}"));
const over = { kind: "over", month_label: "October", projection_usd: 27040, monthly_usd: 27000, over_by_usd: 40, raise_to_usd: 27100, daily_limit_usd: null, daily_limit_to_usd: null };

afterEach(() => cleanup());
beforeEach(() => apiFetch.mockReset());

describe("MoveCard", () => {
  it("must-catch Atlanta order: one Approve posts the ticked ids, cuts first", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => { const url = String(args[0]); return (url.endsWith("/move-fit") ? json(200, { ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } }) : json(200, { ok: true, approved: [CUT], waiting: [RAISE] })); });
    const onChanged = vi.fn();
    render(<MoveCard anchorId={RAISE} move={move([cut(), line({})])} onChanged={onChanged} />);
    expect(await screen.findByText("Net: $0/day")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls("approve-move")).toHaveLength(1));
    expect(bodyOf(calls("approve-move")[0])).toEqual({ ticked_ids: [CUT, RAISE] });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("unticking the cut asks move-fit, and the button becomes Approve and raise budget", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      const init = (args[1] ?? {}) as { body?: string };
      if (url.endsWith("/move-fit")) {
        const ids = JSON.parse(init.body ?? "{}").ticked_ids as string[];
        return json(200, ids.includes(CUT) ? { ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } } : { ok: true, net_daily_usd: 30, budget_choice: over });
      }
      return json(200, { ok: true, approved: [RAISE], waiting: [] });
    });
    render(<MoveCard anchorId={RAISE} move={move([cut(), line({})])} onChanged={() => {}} />);
    await screen.findByText("Net: $0/day");
    fireEvent.click(screen.getByRole("checkbox", { name: "Cut Dallas from $40 to $10 a day" }));
    const btn = await screen.findByRole("button", { name: "Approve and raise budget to $27,100" });
    expect(screen.getByText("October is projected at about $27,040, over your $27,000 budget.")).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => expect(calls("approve-move")).toHaveLength(1));
    expect(bodyOf(calls("approve-move")[0])).toEqual({ ticked_ids: [RAISE], raise_budget_to_usd: 27100 });
  });

  it("must-catch Atlanta end: a failed cut shows Retry; once the cut is done the raise shows Finish; Reject after partial shows the kept cuts", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.endsWith("/move-fit")) return json(200, { ok: true, net_daily_usd: 30, budget_choice: { kind: "fits" } });
      if (url.endsWith("/reject-move")) return json(200, { ok: true, rejected: [RAISE], kept: ["Cut Dallas from $40 to $10 a day"] });
      return json(200, { ok: true, approved: [], waiting: [RAISE] });
    });
    const { rerender } = render(<MoveCard anchorId={RAISE} move={move([cut({ status: "dispatch_failed", dispatch_error: "Google said no" }), line({ waits_on_cuts: true })])} onChanged={() => {}} />);
    expect(screen.getByText("Google said no")).toBeTruthy();
    expect(screen.getByText("· Runs after the cuts")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(calls("approve-move")).toHaveLength(1));
    expect(bodyOf(calls("approve-move")[0])).toEqual({ ticked_ids: [], retry_ids: [CUT] });

    rerender(<MoveCard anchorId={RAISE} move={move([cut({ status: "acted" }), line({ waits_on_cuts: true })])} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Finish the raise" }));
    await waitFor(() => expect(calls("approve-move")).toHaveLength(2));
    expect(bodyOf(calls("approve-move")[1])).toEqual({ ticked_ids: [], finish: true });

    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("These cuts already went through and stay: Cut Dallas from $40 to $10 a day.")).toBeTruthy();
  });

  it("must-catch F3: a reject that lost the race to an approve says the raise was already approved", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) =>
      String(args[0]).endsWith("/reject-move") ? json(200, { ok: true, rejected: [], kept: [], closed: [{ id: RAISE, title: "Raise Atlanta from $40 to $70 a day", status: "approved" }] }) : json(200, { ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } }),
    );
    render(<MoveCard anchorId={RAISE} move={move([cut(), line({})])} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Already approved, so not rejected: Raise Atlanta from $40 to $70 a day.")).toBeTruthy();
  });

  it("must-not-touch: a line that was superseded meanwhile is never called approved", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) =>
      String(args[0]).endsWith("/reject-move") ? json(200, { ok: true, rejected: [], kept: [], closed: [{ id: RAISE, title: "Raise Atlanta from $40 to $70 a day", status: "superseded" }] }) : json(200, { ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } }),
    );
    render(<MoveCard anchorId={RAISE} move={move([cut(), line({})])} onChanged={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Already closed without being approved: Raise Atlanta from $40 to $70 a day.")).toBeTruthy();
    expect(screen.queryByText(/Already approved/)).toBeNull();
  });

  it("a failed raise shows Retry", async () => {
    apiFetch.mockResolvedValue(json(200, { ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } }));
    render(<MoveCard anchorId={RAISE} move={move([cut({ status: "acted" }), line({ status: "dispatch_failed", dispatch_error: "budget refused" })])} onChanged={() => {}} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByText("· Didn't go through")).toBeTruthy();
  });

  it("while the order is still filing, Approve is off", async () => {
    apiFetch.mockResolvedValue(json(200, { ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } }));
    render(<MoveCard anchorId={RAISE} move={{ ...move([cut(), line({})]), still_filing: true }} onChanged={() => {}} />);
    expect((screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("MoveCard: find the money elsewhere (plan 2026-10-23, Slice 3)", () => {
  const cand = (object_id: string, from_usd: number, to_usd: number) => ({ platform: "google" as const, level: "campaign" as const, object_id, name: object_id === "g1" ? "Dallas" : "Houston", from_usd, to_usd, frees_daily_usd: from_usd - to_usd, why: "clearly worse" });
  const C = [cand("g1", 100, 80), cand("g2", 50, 40)];

  it("must-catch: the candidates are all unticked; the ticked ones are posted as new_cuts and asked of move-fit", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.endsWith("/move-fit")) {
        const b = JSON.parse(String((args[1] as { body?: string }).body ?? "{}"));
        return json(200, b.new_cuts ? { ok: true, net_daily_usd: 10, budget_choice: { kind: "fits" } } : { ok: true, net_daily_usd: 30, budget_choice: over });
      }
      return json(200, { ok: true, approved: ["x"], waiting: [RAISE] });
    });
    const onChanged = vi.fn();
    render(<MoveCard anchorId={RAISE} move={move([line({})])} candidates={C} onChanged={onChanged} />);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((b) => [b.getAttribute("aria-label"), b.checked])).toEqual([
      ["Cut Dallas $100 to $80/day · frees $20/day", false],
      ["Cut Houston $50 to $40/day · frees $10/day", false],
      ["Raise Atlanta from $40 to $70 a day", true],
    ]);
    expect(await screen.findByRole("button", { name: "Approve and raise budget to $27,100" })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Cut Dallas $100 to $80/day · frees $20/day" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls("approve-move")).toHaveLength(1));
    expect(bodyOf(calls("approve-move")[0])).toEqual({ ticked_ids: [RAISE], new_cuts: [{ platform: "google", object_id: "g1", to_usd: 80 }] });
    expect(bodyOf(calls("move-fit").at(-1)!)).toEqual({ ticked_ids: [RAISE], new_cuts: [{ platform: "google", object_id: "g1", to_usd: 80 }] });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("must-catch: candidates_changed replaces the list, nothing ticked, and the card stays", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) =>
      String(args[0]).endsWith("/move-fit")
        ? json(200, { ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } })
        : json(409, { error: { code: "candidates_changed", message: "The cuts Zavi found have changed. Check the new list and approve again. Nothing was approved.", candidates: [cand("g3", 60, 48)] } }),
    );
    const onChanged = vi.fn();
    render(<MoveCard anchorId={RAISE} move={move([line({})])} candidates={C} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Cut Dallas $100 to $80/day · frees $20/day" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/The cuts Zavi found have changed/)).toBeTruthy();
    const box = screen.getByRole("checkbox", { name: "Cut Houston $60 to $48/day · frees $12/day" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.queryByText(/Cut Dallas/)).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("a refusal that filed part of the picks reloads the card and passes the words up", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) =>
      String(args[0]).endsWith("/move-fit")
        ? json(200, { ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } })
        : json(409, { error: { code: "move_cut_file_failed", message: "Zavi filed one of the cuts you picked, then could not file the rest.", filed: ["f1"] } }),
    );
    const onChanged = vi.fn();
    const onFailed = vi.fn();
    render(<MoveCard anchorId={RAISE} move={move([line({})])} candidates={C} onChanged={onChanged} onFailed={onFailed} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Cut Dallas $100 to $80/day · frees $20/day" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onFailed).toHaveBeenCalledWith("Zavi filed one of the cuts you picked, then could not file the rest.");
  });

  it("a filed candidate on a real move starts unticked; Reject can be the plain reject; no candidates says so", async () => {
    apiFetch.mockResolvedValue(json(200, { ok: true, net_daily_usd: 30, budget_choice: { kind: "fits" } }));
    render(<MoveCard anchorId={RAISE} move={move([cut({ suggested: true }), line({})])} onChanged={() => {}} />);
    expect((screen.getByRole("checkbox", { name: "Cut Dallas from $40 to $10 a day" }) as HTMLInputElement).checked).toBe(false);
    cleanup();
    const onReject = vi.fn();
    render(<MoveCard anchorId={RAISE} move={move([line({})])} candidates={[]} onChanged={() => {}} onReject={onReject} />);
    expect(screen.getByText("Cutting other ads can't make enough room this month. Raise the budget instead.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalled();
    expect(calls("reject-move")).toHaveLength(0);
  });
  it("must-catch (Codex F4): a refusal after the cuts were filed and one approved reloads the real move and never says nothing was approved", async () => {
    apiFetch.mockImplementation(async (...args: unknown[]) =>
      String(args[0]).endsWith("/move-fit")
        ? json(200, { ok: true, net_daily_usd: 0, budget_choice: { kind: "fits" } })
        : json(409, { error: { code: "move_cut_refused", message: "Zavi could not approve this just now. Nothing was approved.", done: ["f1"], filed: ["f1", "f2"] } }),
    );
    const onChanged = vi.fn();
    const onFailed = vi.fn();
    render(<MoveCard anchorId={RAISE} move={move([line({})])} candidates={C} onChanged={onChanged} onFailed={onFailed} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Cut Dallas $100 to $80/day · frees $20/day" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Cut Houston $50 to $40/day · frees $10/day" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onFailed).toHaveBeenCalledWith("Zavi could not approve this just now.");
    expect(screen.queryByText(/Nothing was approved/)).toBeNull();
  });
});

