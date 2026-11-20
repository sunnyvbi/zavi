// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

const looksLikeButton = (el: HTMLElement) => {
  const c = el.className.split(/\s+/);
  expect(c.includes("bg-ink") || (c.includes("border") && c.includes("border-rule") && c.includes("bg-white")), `${el.textContent} fill/border`).toBe(true);
  expect(c, `${el.textContent} pointer`).toContain("cursor-pointer");
  expect(c.some((x) => x.startsWith("hover:")), `${el.textContent} hover`).toBe(true);
};

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${method} ${url}`] ?? { status: 200, body: { ok: true } };
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
const ws = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: ws.role }) }));

import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { ChannelPageHeaderSlotProvider } from "../../layout/ChannelHeaderRow";
import { EMAIL_SENDING_COPY, EmailSendingSwitch, forgetPaused } from "../EmailSendingSwitch";
import { getEmailPause } from "@/lib/workspace/emailCampaignSettingsApi";

const PAUSE = "/api/workspace/email-pause";
const set = (key: string, body: unknown, status = 200) => {
  routes[key] = { status, body };
};
const count = (key: string) => calls.filter((c) => `${c.method} ${c.url}` === key).length;
const sw = () => screen.findByRole("switch", { name: "Email sending" });

function mount() {
  const badge = document.createElement("span");
  document.body.appendChild(badge);
  const view = render(
    <ChannelPageHeaderSlotProvider element={null} badgeElement={badge}>
      <ConfirmDialogHost />
      <EmailSendingSwitch />
    </ChannelPageHeaderSlotProvider>,
  );
  return { badge, view };
}

beforeEach(() => {
  forgetPaused();
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  ws.role = "owner";
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("getEmailPause", () => {
  it("passes a known held value through and drops anything else", async () => {
    set(`GET ${PAUSE}`, { paused: false, held: "abuse" });
    expect(await getEmailPause()).toEqual({ paused: false, held: "abuse" });
    set(`GET ${PAUSE}`, { paused: true, held: "global" });
    expect(await getEmailPause()).toEqual({ paused: true, held: "global" });
    set(`GET ${PAUSE}`, { paused: false, held: "disabled" });
    expect(await getEmailPause()).toEqual({ paused: false, held: "disabled" });
    set(`GET ${PAUSE}`, { paused: false, held: "unknown" });
    expect(await getEmailPause()).toEqual({ paused: false, held: "unknown" });
    set(`GET ${PAUSE}`, { paused: true });
    expect(await getEmailPause()).toEqual({ paused: true, held: null });
    set(`GET ${PAUSE}`, { paused: true, held: null });
    expect(await getEmailPause()).toEqual({ paused: true, held: null });
  });

  it("a held value it cannot read is held-unknown, never 'no hold' (fail closed)", async () => {
    set(`GET ${PAUSE}`, { paused: false, held: "Disabled" });
    expect(await getEmailPause()).toEqual({ paused: false, held: "unknown" });
    set(`GET ${PAUSE}`, { paused: false, held: "something_else" });
    expect(await getEmailPause()).toEqual({ paused: false, held: "unknown" });
    set(`GET ${PAUSE}`, { paused: false, held: 3 });
    expect(await getEmailPause()).toEqual({ paused: false, held: "unknown" });
  });
});

const OWN_SENDER_ONLY = "Your email tools still send.";

describe("Email sending switch when Zavi stopped its own sender", () => {
  for (const [held, base] of [
    ["abuse", "Zavi stopped its own sender for this workspace after too many spam reports or bounces."],
    ["global", "Zavi's own sender is stopped for every workspace right now."],
    ["disabled", "Zavi's own sender is switched off for this workspace. Contact support to turn it back on."],
    ["unknown", "Zavi could not confirm that its own sender is running, so it is treated as stopped for now."],
  ] as const) {
    const reason = `${base} ${OWN_SENDER_ONLY}`;
    it(`held ${held}: a Zavi sender stopped badge about only Zavi's sender, the switch reads on and an owner can still pause`, async () => {
      set(`GET ${PAUSE}`, { paused: false, held });
      set(`POST ${PAUSE}`, { paused: true });
      const { badge } = mount();
      const pill = await within(badge).findByTestId("email-held-badge");
      expect(pill.textContent).toBe(`Zavi sender stopped${reason}`);
      expect(EMAIL_SENDING_COPY.stoppedByZavi).toBe("Zavi sender stopped");
      expect(pill.getAttribute("title")).toBe(reason);
      expect(pill.textContent).toContain(OWN_SENDER_ONLY);
      expect(pill.textContent).not.toMatch(/Zavi stopped sending|Sending is stopped|Email sending is switched off/);
      expect(within(pill).getByText(reason).className).toContain("sr-only");
      expect(within(badge).queryByTestId("email-paused-badge")).toBeNull();

      const toggle = (await sw()) as HTMLButtonElement;
      expect(toggle.getAttribute("aria-checked")).toBe("true");
      expect(toggle.getAttribute("aria-disabled")).toBe("false");
      expect(toggle.className).not.toContain("opacity-60");
      expect(document.getElementById("email-sending-state")!.textContent).toBe(EMAIL_SENDING_COPY.on);
      const described = toggle.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)!.textContent);
      expect(described).toContain(reason);

      fireEvent.click(toggle);
      fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Pause all email" }));
      await waitFor(() => expect(count(`POST ${PAUSE}`)).toBe(1));
      expect(calls.find((c) => c.method === "POST")!.body).toEqual({ paused: true });
      await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
      const after = within(badge).getByTestId("email-held-badge");
      expect(after.textContent).toBe(`Zavi sender stopped${base}`);
      expect(after.getAttribute("title")).toBe(base);
      expect(within(badge).getByTestId("email-paused-badge").textContent).toBe("Paused");
      expect(document.body.textContent).not.toContain(OWN_SENDER_ONLY);
      expect(screen.getByTestId("email-sending").getAttribute("title")).toBe(base);
    });
  }

  it("switched off by staff or the abuse shutoff shows the disabled badge and never tells the founder Zavi stopped them for spam", async () => {
    set(`GET ${PAUSE}`, { paused: false, held: "disabled" });
    const { badge } = mount();
    const pill = await within(badge).findByTestId("email-held-badge");
    expect(pill.textContent).toBe(`Zavi sender stopped${EMAIL_SENDING_COPY.held.disabled} ${OWN_SENDER_ONLY}`);
    expect(pill.textContent).not.toContain(EMAIL_SENDING_COPY.held.abuse);
    expect(screen.getByTestId("email-sending").getAttribute("title")).toBe(`${EMAIL_SENDING_COPY.held.disabled} ${OWN_SENDER_ONLY}`);
    expect(document.getElementById("email-sending-held")!.textContent).toBe(`${EMAIL_SENDING_COPY.held.disabled} ${OWN_SENDER_ONLY}`);
    expect(document.body.textContent).not.toMatch(/spam complaints/);
  });

  it("held while also paused by the owner: both badges, no claim that email tools still send, and turning it back on drops Paused and restores that sentence", async () => {
    set(`GET ${PAUSE}`, { paused: true, held: "abuse" });
    set(`POST ${PAUSE}`, { paused: false });
    const { badge } = mount();
    const pill = await within(badge).findByTestId("email-held-badge");
    expect(within(badge).getByTestId("email-paused-badge").textContent).toBe("Paused");
    expect(pill.textContent).toBe(`Zavi sender stopped${EMAIL_SENDING_COPY.held.abuse}`);
    expect(document.body.textContent).not.toContain(OWN_SENDER_ONLY);
    const toggle = await sw();
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(toggle);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(count(`POST ${PAUSE}`)).toBe(1));
    expect(calls.find((c) => c.method === "POST")!.body).toEqual({ paused: false });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(within(badge).queryByTestId("email-paused-badge")).toBeNull();
    expect(within(badge).getByTestId("email-held-badge").getAttribute("title")).toBe(`${EMAIL_SENDING_COPY.held.abuse} ${OWN_SENDER_ONLY}`);
  });

  it("paused with no hold shows Paused and nothing else", async () => {
    set(`GET ${PAUSE}`, { paused: true, held: null });
    const { badge } = mount();
    expect((await within(badge).findByTestId("email-paused-badge")).textContent).toBe("Paused");
    expect(within(badge).queryByTestId("email-held-badge")).toBeNull();
  });

  it("a member still cannot flip the switch while held", async () => {
    ws.role = "member";
    set(`GET ${PAUSE}`, { paused: false, held: "global" });
    const { badge } = mount();
    await within(badge).findByTestId("email-held-badge");
    const toggle = await sw();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(toggle);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(count(`POST ${PAUSE}`)).toBe(0);
  });

  it("a remount from the session cache paints the held badge and a live switch on the first paint", async () => {
    set(`GET ${PAUSE}`, { paused: false, held: "global" });
    const first = mount();
    await within(first.badge).findByTestId("email-held-badge");
    first.view.unmount();
    const again = mount();
    const toggle = screen.getByRole("switch", { name: "Email sending" });
    expect(toggle.getAttribute("aria-disabled")).toBe("false");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(within(again.badge).getByTestId("email-held-badge")).toBeTruthy();
  });

  it("the hold lifts on the next read: the badge goes and the owner can pause again", async () => {
    set(`GET ${PAUSE}`, { paused: false, held: "abuse" });
    const first = mount();
    await within(first.badge).findByTestId("email-held-badge");
    first.view.unmount();
    forgetPaused();
    set(`GET ${PAUSE}`, { paused: false, held: null });
    set(`POST ${PAUSE}`, { paused: true });
    const { badge } = mount();
    const toggle = await sw();
    await waitFor(() => expect(within(badge).queryByTestId("email-held-badge")).toBeNull());
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-disabled")).toBe("false");
    fireEvent.click(toggle);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Pause all email" }));
    await waitFor(() => expect(count(`POST ${PAUSE}`)).toBe(1));
  });

  it("no held field (an older backend): the switch works as before", async () => {
    set(`GET ${PAUSE}`, { paused: false });
    const { badge } = mount();
    const toggle = await sw();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.getAttribute("aria-disabled")).toBe("false");
    expect(badge.textContent).toBe("");
  });
});

describe("Email sending switch copy and phone layout", () => {
  it("an abuse hold names both triggers the backend holds on, spam reports and bounces, not spam alone", async () => {
    set(`GET ${PAUSE}`, { paused: false, held: "abuse" });
    const { badge } = mount();
    const pill = await within(badge).findByTestId("email-held-badge");
    const reason = pill.getAttribute("title")!;
    expect(reason).toMatch(/\bbounces\b/);
    expect(reason).toMatch(/spam reports/);
    expect(reason).not.toMatch(/after spam complaints\./);
    expect(EMAIL_SENDING_COPY.held.abuse).toBe("Zavi stopped its own sender for this workspace after too many spam reports or bounces.");
    expect(document.getElementById("email-sending-held")!.textContent).toBe(`${EMAIL_SENDING_COPY.held.abuse} ${OWN_SENDER_ONLY}`);
  });

  it("a failed pause on a phone shows the whole error on its own wrapping line under the switch, still as an alert", async () => {
    const message = "Could not save whether email is paused because the server did not answer in time. Try again.";
    set(`GET ${PAUSE}`, { paused: false, held: null });
    set(`POST ${PAUSE}`, { error: { message } }, 500);
    mount();
    const toggle = await sw();
    fireEvent.click(toggle);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Pause all email" }));
    const full = `${message} The saved state is shown.`;
    const alert = await screen.findByText(full);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.textContent).toBe(full);

    const classes = alert.className.split(/\s+/);
    const compact = classes.filter((c) => c.startsWith("compact:")).map((c) => c.slice("compact:".length));
    expect(compact).toContain("whitespace-normal");
    expect(compact).toContain("max-w-none");
    expect(compact).toContain("basis-full");
    expect(compact.filter((c) => /^max-w-\[/.test(c) || c === "truncate" || c === "whitespace-nowrap")).toEqual([]);

    const row = screen.getByTestId("email-sending");
    expect(alert.parentElement).toBe(row);
    expect(row.className.split(/\s+/)).toContain("compact:flex-wrap");
    const switchGroup = toggle.parentElement!;
    expect(switchGroup.parentElement).toBe(row);
    expect(switchGroup.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
  it("a resume that committed but could not restart held sends shows the whole server sentence, without 'The saved state is shown', and wraps instead of truncating", async () => {
    const message = "Email is resumed, but some held campaigns have not restarted yet. Zavi will retry automatically; contact support if they remain held.";
    set(`GET ${PAUSE}`, { paused: true, held: null });
    mount();
    const toggle = await sw();
    set(`GET ${PAUSE}`, { paused: false, held: null });
    set(`POST ${PAUSE}`, { error: { code: "email_resume_incomplete", message } }, 503);
    fireEvent.click(toggle);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Turn on" }));
    const alert = await screen.findByText(message);
    expect(alert.textContent).toBe(message);
    expect(alert.className.split(/\s+/)).not.toContain("truncate");
    expect(alert.className.split(/\s+/)).toContain("whitespace-normal");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("the resume dialog says an approved email waiting more than a day is dropped", async () => {
    set(`GET ${PAUSE}`, { paused: true, held: null });
    mount();
    fireEvent.click(await sw());
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/more than a day/);
    expect(dialog.textContent).toMatch(/new draft/);
  });

  it("a failed pause whose reload also fails clears the red error once Retry reads the state", async () => {
    set(`GET ${PAUSE}`, { paused: false, held: null });
    mount();
    const toggle = await sw();
    set(`POST ${PAUSE}`, { error: { message: "That did not save. Try again." } }, 500);
    set(`GET ${PAUSE}`, { error: { message: "down" } }, 500);
    fireEvent.click(toggle);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Pause all email" }));
    expect(await screen.findByText("That did not save. Try again.")).toBeTruthy();
    set(`GET ${PAUSE}`, { paused: false, held: null });
    const retry = await screen.findByRole("button", { name: "Retry" });
    looksLikeButton(retry);
    fireEvent.click(retry);
    await sw();
    await waitFor(() => expect(screen.queryByText("That did not save. Try again.")).toBeNull());
  });

  it("a member on a held workspace still sees that only an owner or admin can pause or resume, in the tooltip", async () => {
    ws.role = "member";
    set(`GET ${PAUSE}`, { paused: false, held: "abuse" });
    mount();
    await sw();
    const title = screen.getByTestId("email-sending").getAttribute("title")!;
    expect(title).toContain(EMAIL_SENDING_COPY.held.abuse);
    expect(title).toContain(EMAIL_SENDING_COPY.readOnly);
  });
});
