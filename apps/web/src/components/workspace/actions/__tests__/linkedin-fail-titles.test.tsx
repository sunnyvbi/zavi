// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ChannelActionCard } from "../ChannelActionCard";
import { execFailureToast } from "../ActionFooter";
import { platformFor } from "../platforms";
import type { ActionHandlers } from "../types";
import { FIXTURES, makeAction } from "./fixtures";

afterEach(cleanup);

const li = platformFor("linkedin_ads");
let n = 0;
const liFailed = (exec_code: string, note: string) =>
  makeAction("create_ad", {
    ...FIXTURES.create_ad,
    id: `li-title-${++n}`,
    channel_slug: "linkedin_ads",
    exec_status: "failed",
    exec_bucket: "temporary",
    exec_code,
    note,
  });
const handlers = (): ActionHandlers => ({ onSetStatus: vi.fn(), onRedo: vi.fn(), onApprove: vi.fn(), onOpenChat: vi.fn() });

it.each([
  [
    "linkedin_ads_zavi_incomplete",
    "Zavi could not finish this change.",
    "LinkedIn made the paused campaign, but Zavi could not finish saving its setup. This was a problem on Zavi's side, not in LinkedIn, so there is nothing to fix in LinkedIn.",
  ],
  [
    "linkedin_ads_account_turned_off",
    "This account was turned off.",
    "You turned this ad account off in Zavi with Stop using this account, so Zavi did not finish the campaign.",
  ],
])("a LinkedIn campaign stopped by %s never tells the founder LinkedIn refused it, and keeps Try again", (code, title, note) => {
  const a = liFailed(code, note);
  render(<ChannelActionCard action={a} platform={li} handlers={handlers()} />);
  expect(screen.getByTestId("exec-title").textContent).toBe(title);
  const text = screen.getByTestId("exec-state").textContent ?? "";
  expect(text).not.toMatch(/LinkedIn did not accept|LinkedIn refused/);
  expect(text).toContain(note);
  expect(screen.getByRole("button", { name: /^Try again$/ })).toBeTruthy();
  expect(execFailureToast(a, "LinkedIn", li.execCopy).title).toBe(title.replace(/\.$/, ""));
});

it("a campaign step LinkedIn did not answer clearly reads as Zavi checking first, never as a LinkedIn refusal, and keeps Try again", () => {
  const note = "LinkedIn did not answer clearly while Zavi was creating the paused campaign, so Zavi cannot tell yet whether it was made. Nothing can spend: everything Zavi made is paused. Choose Try again in a few minutes: Zavi first looks in the campaign group it made, Spring (Zavi 1234abcd), for the paused campaign, reuses it if it is there and creates it only if it is not, so nothing is made twice.";
  const a = liFailed("linkedin_ads_creation_unconfirmed", note);
  render(<ChannelActionCard action={a} platform={li} handlers={handlers()} />);
  expect(screen.getByTestId("exec-title").textContent).toBe("Zavi checks what LinkedIn made before trying again.");
  const text = screen.getByTestId("exec-state").textContent ?? "";
  expect(text).not.toMatch(/LinkedIn did not accept|LinkedIn refused/);
  expect(text).toContain(note);
  expect(screen.getByRole("button", { name: /^Try again$/ })).toBeTruthy();
  expect(execFailureToast(a, "LinkedIn", li.execCopy).title).toBe("Zavi checks what LinkedIn made before trying again");
});

it("a LinkedIn refusal partway through creation keeps the LinkedIn title", () => {
  const a = liFailed("linkedin_ads_creation_incomplete", "LinkedIn could not save these campaign settings. Campaign setup is saved. Correct the issue in LinkedIn, then choose Try again to finish the remaining steps.");
  render(<ChannelActionCard action={a} platform={li} handlers={handlers()} />);
  expect(screen.getByTestId("exec-title").textContent).toBe("LinkedIn did not accept this change");
  expect(screen.getByRole("button", { name: /^Try again$/ })).toBeTruthy();
});

it.each([
  ["linkedin_ads_account_turned_off", "temporary", "Turn the account back on with Use this account again, then choose Try again."],
  ["linkedin_ads_zavi_incomplete", "temporary", "This was a problem on Zavi's side, not in LinkedIn. Choose Try again."],
  ["linkedin_ads_account_turned_off", null, "Turn the account back on with Use this account again, then choose Try again."],
  ["linkedin_ads_zavi_incomplete", null, "This was a problem on Zavi's side, not in LinkedIn. Choose Try again."],
])("a %s failure with no note (bucket %s) gives its own next step, never a LinkedIn blip", (code, bucket, hint) => {
  const a = { ...liFailed(code, ""), exec_bucket: bucket } as ReturnType<typeof liFailed>;
  const toast = execFailureToast(a, "LinkedIn", li.execCopy);
  expect(toast.description).toBe(hint);
  expect(toast.description).not.toMatch(/temporary problem at LinkedIn|part of it may have gone through/);
});

const UNCONFIRMED = "This launch may have reached LinkedIn, but Zavi could not confirm it. Zavi tried to pause the campaign to be safe, but it may still be running. Check the campaign in LinkedIn Campaign Manager and pause it there if it is running, then review the launch again. The budget set aside for it stays held until Zavi confirms what happened.";

it("an interrupted launch reads as unconfirmed, with the checking note and no Try again, never as a LinkedIn refusal", () => {
  const note = "This launch was interrupted, so Zavi could not confirm whether it reached LinkedIn. Zavi is checking it now, and if it still cannot confirm the launch within about 15 minutes it pauses the campaign to be safe. The budget set aside for it stays held until Zavi confirms what happened. If the campaign is paused after that, review the launch again.";
  const a = { ...liFailed("exec_outcome_unknown", note), action_type: "update_ad", exec_bucket: "partial_risk" } as ReturnType<typeof liFailed>;
  render(<ChannelActionCard action={a} platform={li} handlers={handlers()} />);
  expect(screen.getByTestId("exec-title").textContent).toBe("This may have reached LinkedIn");
  const text = screen.getByTestId("exec-state").textContent ?? "";
  expect(text).toContain(note);
  expect(text).not.toMatch(/LinkedIn did not accept|Try again/);
  expect(screen.queryByRole("button", { name: /Try again/i })).toBeNull();
});

it("a launch that may have reached LinkedIn says so plainly and offers no Try again on the used request", () => {
  const a = { ...liFailed("exec_outcome_unknown", UNCONFIRMED), action_type: "update_ad", exec_bucket: "partial_risk" } as ReturnType<typeof liFailed>;
  const onApprove = vi.fn();
  render(<ChannelActionCard action={a} platform={li} handlers={{ ...handlers(), onApprove }} />);
  expect(screen.getByTestId("exec-title").textContent).toBe("This may have reached LinkedIn");
  const text = screen.getByTestId("exec-state").textContent ?? "";
  expect(text).not.toMatch(/LinkedIn did not accept|Try again|try again/);
  expect(text).toContain(UNCONFIRMED);
  expect(screen.queryByRole("button", { name: /Try again/i })).toBeNull();
  expect(document.querySelector("[data-approve]")).toBeNull();
  expect(onApprove).not.toHaveBeenCalled();
  const toast = execFailureToast(a, "LinkedIn", li.execCopy);
  expect(toast.title).toBe("This may have reached LinkedIn");
  expect(toast.title).not.toMatch(/did not accept/);
});

it("a launch Zavi could not reopen says nothing was sent, never that LinkedIn refused it, and offers no Try again", () => {
  const a = { ...liFailed("linkedin_ads_launch_not_reopened", "Nothing was sent to LinkedIn for this request, and Zavi could not reopen it, so Zavi closed the card. Review the launch again to send a new one."), action_type: "update_ad", exec_bucket: "blocked_on_us" } as ReturnType<typeof liFailed>;
  render(<ChannelActionCard action={a} platform={li} handlers={handlers()} />);
  expect(screen.getByTestId("exec-title").textContent).toBe("Zavi could not reopen this launch.");
  const text = screen.getByTestId("exec-state").textContent ?? "";
  expect(text).toContain("Nothing was sent to LinkedIn.");
  expect(text).toContain("Review the launch again to send a new one.");
  expect(text).not.toMatch(/LinkedIn refused|may have reached|alerted|Try again/);
  expect(screen.queryByRole("button", { name: /Try again/i })).toBeNull();
});

it("must catch (Review 7): an interrupted launch that never reached LinkedIn says so, offers Try again, and never reads as a LinkedIn refusal or a check in progress", () => {
  const note = "This launch was interrupted before anything reached LinkedIn, so nothing was spent. Choose Try again to send it.";
  const a = { ...liFailed("linkedin_ads_launch_not_sent", note), action_type: "update_ad" } as ReturnType<typeof liFailed>;
  render(<ChannelActionCard action={a} platform={li} handlers={handlers()} />);
  expect(screen.getByTestId("exec-title").textContent).toBe("This launch did not reach LinkedIn.");
  const text = screen.getByTestId("exec-state").textContent ?? "";
  expect(text).toContain(note);
  expect(text).not.toMatch(/did not accept|may have reached|checking|stays held|temporary problem/);
  expect(screen.getByRole("button", { name: /^Try again$/ })).toBeTruthy();
  const toast = execFailureToast({ ...a, note: "" } as typeof a, "LinkedIn", li.execCopy);
  expect(toast.title).toBe("This launch did not reach LinkedIn");
  expect(toast.description).toBe("Nothing was sent to LinkedIn. Choose Try again.");
});

const liDone = (action_type: "pause_ad" | "update_ad" | "create_ad", exec_notice?: string) =>
  makeAction(action_type, {
    ...FIXTURES[action_type],
    id: `li-done-${++n}`,
    channel_slug: "linkedin_ads",
    exec_status: "executed",
    exec_notice,
  });

it.each([
  ['LinkedIn shows "Spring" already ended, so there was nothing to pause.', /already ended/],
  ['LinkedIn no longer shows "Spring" in this ad account, so there was nothing to pause.', /no longer shows/],
  ['"Spring" was already paused in LinkedIn Ads.', /already paused/],
])("approving a pause that changed nothing (%s) never claims Zavi paused it", (notice, want) => {
  render(<ChannelActionCard action={liDone("pause_ad", notice)} platform={li} handlers={handlers()} />);
  const title = within(screen.getByTestId("exec-state")).getAllByRole("status")[0].textContent ?? "";
  expect(title).toMatch(want);
  expect(title).not.toMatch(/stops spending|^Paused/);
});

it.each([
  ["pause_ad", 'Paused "Spring" in LinkedIn Ads.', /^Paused in LinkedIn Campaign Manager\. It stops spending/],
  ["pause_ad", undefined, /^Paused in LinkedIn Campaign Manager/],
  ["create_ad", undefined, /paused\. Nothing spends until you launch it/],
  ["update_ad", undefined, /^Launched\. The campaign is live/],
] as const)("a real %s (notice %s) keeps its plain copy", (type, notice, want) => {
  render(<ChannelActionCard action={liDone(type, notice)} platform={li} handlers={handlers()} />);
  expect(within(screen.getByTestId("exec-state")).getAllByRole("status")[0].textContent).toMatch(want);
});

it("a launch Zavi refused itself is never blamed on LinkedIn, and the note says what to do", () => {
  const note = "Another change to this campaign is still finishing. Nothing was sent to LinkedIn. Try again in a minute.";
  const a = { ...liFailed("linkedin_ads_launch_refused", note), action_type: "update_ad" } as ReturnType<typeof liFailed>;
  render(<ChannelActionCard action={a} platform={li} handlers={handlers()} />);
  expect(screen.getByTestId("exec-title").textContent).toBe("Zavi did not send this launch.");
  const text = screen.getByTestId("exec-state").textContent ?? "";
  expect(text).toContain(note);
  expect(text).not.toMatch(/did not accept|temporary problem|Open Campaign Manager/);
  const toast = execFailureToast({ ...a, note: "" } as typeof a, "LinkedIn", li.execCopy);
  expect(toast.title).toBe("Zavi did not send this launch");
  expect(toast.description).toContain("before anything reached LinkedIn");
});

const liPauseFailed = (exec_code: string, note: string) =>
  makeAction("pause_ad", {
    ...FIXTURES.pause_ad,
    id: `li-pause-${++n}`,
    channel_slug: "linkedin_ads",
    exec_status: "failed",
    exec_bucket: "temporary",
    exec_code,
    note,
  });

it.each([
  ["ads_pause_queued", "Zavi saved this pause and keeps trying.", '"Spring": Zavi saved your pause request and will keep retrying it. Check back in a few minutes.'],
  ["ads_pause_queued", "Zavi saved this pause and keeps trying.", `"Spring": LinkedIn's daily request limit for this connection is used up, so Zavi could not pause this campaign and it can keep spending until the limit resets at 00:00 UTC (5:30 AM IST). Zavi saved your pause request and retries it then. To stop it sooner, pause it in LinkedIn Campaign Manager.`],
  ["ads_pause_superseded", "The campaign was relaunched before Zavi could pause it.", '"Spring": This campaign was relaunched while Zavi was pausing it, so Zavi left it running. Pause it again if you still want it stopped.'],
  ["ads_binding_unavailable", "Zavi could not finish this pause.", "The campaign's account could not be verified, so Zavi did not change it."],
  ["linkedin_ads_write_failed", "Zavi could not finish this pause.", 'Pause of "Spring" failed: LinkedIn Ads did not confirm the pause.'],
])("must-catch: a LinkedIn pause card that failed with %s is never headed 'LinkedIn did not accept this change'", (code, title, note) => {
  const a = liPauseFailed(code, note);
  render(<ChannelActionCard action={a} platform={li} handlers={handlers()} />);
  expect(screen.getByTestId("exec-title").textContent).toBe(title);
  const text = screen.getByTestId("exec-state").textContent ?? "";
  expect(text).not.toMatch(/LinkedIn did not accept|LinkedIn refused/);
  expect(text).toContain(note);
  expect(execFailureToast(a, "LinkedIn", li.execCopy).title).toBe(title.replace(/\.$/, ""));
});

it("a pause LinkedIn itself refused keeps the LinkedIn title", () => {
  const a = liPauseFailed("linkedin_ads_forbidden", 'Zavi could not pause "Spring", so it keeps running on LinkedIn and can keep spending. You need Campaign Manager access.');
  render(<ChannelActionCard action={a} platform={li} handlers={handlers()} />);
  expect(screen.getByTestId("exec-title").textContent).toBe("LinkedIn did not accept this change");
});

it("a failed or finished LinkedIn card says what happened in plain text inside the card, with no coloured banner, while another paid channel keeps its banner", () => {
  const failed = liFailed("linkedin_ads_creation_incomplete", "LinkedIn could not save these campaign settings.");
  const { unmount } = render(<ChannelActionCard action={failed} platform={li} handlers={handlers()} />);
  const state = screen.getByTestId("exec-state");
  expect(screen.getByTestId("split-left").contains(state)).toBe(true);
  expect(state.textContent).toContain("LinkedIn did not accept this change");
  expect(state.textContent).toContain("LinkedIn could not save these campaign settings.");
  expect(state.outerHTML).not.toMatch(/bg-ca-danger|bg-ca-success|bg-ca-subtle|text-danger|text-warn|text-success|lucide/);
  unmount();
  const done = render(<ChannelActionCard action={liDone("create_ad")} platform={li} handlers={handlers()} />);
  expect(screen.getByTestId("exec-state").outerHTML).not.toMatch(/text-ca-success|bg-ca-success|lucide-check/);
  done.unmount();
  const meta = platformFor("meta_ads");
  render(<ChannelActionCard action={{ ...failed, id: "meta-failed", channel_slug: "meta_ads" }} platform={meta} handlers={handlers()} />);
  expect(screen.getByTestId("split-left").contains(screen.getByTestId("exec-state"))).toBe(false);
  expect(screen.getByTestId("exec-state").className).toMatch(/bg-ca-danger/);
});
