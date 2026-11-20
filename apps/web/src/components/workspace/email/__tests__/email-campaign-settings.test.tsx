// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

type Call = { url: string; method: string; body: unknown };
const calls: Call[] = [];
const routes: Record<string, { status: number; body: unknown }> = {};
vi.mock("@/lib/api", () => ({
  apiFetch: (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = routes[`${method} ${url}`] ?? { status: 200, body: {} };
    return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
  },
}));
const ws = vi.hoisted(() => ({ role: "owner" as string | null }));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: ws.role }) }));

import { ConfirmDialogHost } from "@/components/ui/ConfirmDialog";
import { AUTO_SEND_COPY, AUTO_SEND_ON_AUTOPILOT_OFF, AUTO_SEND_UNREADABLE, EmailAutoSendBlock, EmailSendgridBlock, EmailTemplateBlock } from "../EmailCampaignSettingsBlocks";
import { ChannelSettingsPanels } from "../EmailSettingsPanels";
const looksLikeButton = (el: HTMLElement, hover = "hover:bg-creamDeep") => {
  for (const c of ["border", "border-rule", "bg-white", "cursor-pointer", "hover:border-inkLight", hover]) expect(el.classList.contains(c), `${el.textContent} missing ${c}`).toBe(true);
};

const set = (key: string, body: unknown, status = 200) => {
  routes[key] = { status, body };
};

beforeEach(() => {
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  ws.role = "owner";
  set("GET /api/workspace/sendgrid/senders", {
    senders: [
      { id: "41", from_email: "hello@northwind.test", from_name: "Northwind Clinic", verified: true },
      { id: "42", from_email: "old@northwind.test", from_name: null, verified: false },
    ],
  });
  set("GET /api/workspace/sendgrid/suppression-groups", { groups: [{ id: "7", name: "Patient news", is_default: true }] });
  set("GET /api/workspace/sendgrid/lists", { lists: [{ id: "L1", name: "Patients", people: 120 }, { id: "L2", name: "Staff test", people: 3 }] });
  set("GET /api/channels/email_marketing/settings", { fields: { email_test_lists: [{ item: "zavi_list:abc" }] } });
});
afterEach(cleanup);

describe("SendGrid block", () => {
  it("lists verified senders only and saves the picks (test lists moved to their own block)", async () => {
    render(<EmailSendgridBlock />);
    await waitFor(() => expect(screen.getByLabelText("Send from")).toBeDefined());
    const sender = screen.getByLabelText("Send from") as HTMLSelectElement;
    expect([...sender.options].map((o) => o.value)).toEqual(["", "41"]);
    fireEvent.change(sender, { target: { value: "41" } });
    fireEvent.change(screen.getByLabelText("Unsubscribe group"), { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { url: "/api/channels/email_marketing/settings/sendgrid_sender_id", method: "PUT", body: { items: ["41"] } },
      { url: "/api/channels/email_marketing/settings/sendgrid_suppression_group_id", method: "PUT", body: { items: ["7"] } },
    ]);
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("not connected for campaigns: shows the server's sentence; a member cannot change anything", async () => {
    set("GET /api/workspace/sendgrid/senders", { error: { code: "sendgrid_not_connected", message: "SendGrid is not connected for campaigns." } }, 409);
    render(<EmailSendgridBlock />);
    await waitFor(() => expect(screen.getByText("SendGrid is not connected.")).toBeDefined());
    cleanup();
    set("GET /api/workspace/sendgrid/senders", { senders: [] });
    ws.role = "member";
    render(<EmailSendgridBlock />);
    await waitFor(() => expect(screen.getByText(/Only a workspace owner or admin/)).toBeDefined());
    expect((screen.getByLabelText("Send from") as HTMLSelectElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  });
});

describe("SendGrid block: Save explains a missing or stale pick", () => {
  const puts = () => calls.filter((c) => c.method === "PUT");
  const savedPicks = (sender: string, group: string) =>
    set("GET /api/channels/email_marketing/settings", { fields: { sendgrid_sender_id: [{ item: sender }], sendgrid_suppression_group_id: [{ item: group }] } });
  const ready = async () => {
    render(<EmailSendgridBlock />);
    const sender = (await screen.findByLabelText("Send from")) as HTMLSelectElement;
    const group = screen.getByLabelText("Unsubscribe group") as HTMLSelectElement;
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    return { sender, group, save };
  };
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("sender cleared: Save is pressable and says to pick a sender, nothing is saved", async () => {
    savedPicks("41", "7");
    const { sender, save } = await ready();
    await waitFor(() => expect(sender.value).toBe("41"));
    fireEvent.change(sender, { target: { value: "" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect((await screen.findByRole("alert")).textContent).toBe("Pick a verified SendGrid sender before saving.");
    await settle();
    expect(puts()).toHaveLength(0);
  });

  it("group cleared: Save says to pick a group, nothing is saved", async () => {
    savedPicks("41", "7");
    const { group, save } = await ready();
    await waitFor(() => expect(group.value).toBe("7"));
    fireEvent.change(group, { target: { value: "" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    expect((await screen.findByRole("alert")).textContent).toBe("Pick an unsubscribe group before saving.");
    await settle();
    expect(puts()).toHaveLength(0);
  });

  it("Saved line goes away as soon as either pick changes again", async () => {
    const { sender, group, save } = await ready();
    fireEvent.change(sender, { target: { value: "41" } });
    fireEvent.change(group, { target: { value: "7" } });
    fireEvent.click(save);
    expect(await screen.findByText("Saved. New email cards use this sender and group.")).toBeDefined();
    expect(puts()).toHaveLength(2);
    fireEvent.change(group, { target: { value: "" } });
    expect(screen.queryByText("Saved. New email cards use this sender and group.")).toBeNull();
    fireEvent.change(group, { target: { value: "7" } });
    expect(screen.queryByText("Saved. New email cards use this sender and group.")).toBeNull();
    fireEvent.click(save);
    expect(await screen.findByText("Saved. New email cards use this sender and group.")).toBeDefined();
    fireEvent.change(sender, { target: { value: "" } });
    expect(screen.queryByText("Saved. New email cards use this sender and group.")).toBeNull();
  });

  it("a stale saved sender is never saved, and the reason is on screen", async () => {
    savedPicks("99", "7");
    const { sender, save } = await ready();
    await waitFor(() => expect(sender.value).toBe("99"));
    expect(sender.selectedOptions[0].textContent).toBe("Saved sender is no longer available");
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["The saved sender is no longer verified in SendGrid. Pick another sender."]);
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await settle();
    expect(puts()).toHaveLength(0);
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["The saved sender is no longer verified in SendGrid. Pick another sender before saving."]);
    expect(screen.queryByText("Saved. New email cards use this sender and group.")).toBeNull();
  });

  it("a stale saved sender and a stale saved group: Save names the sender first, then the group once the sender is fixed, and saves only when both are real", async () => {
    savedPicks("99", "8");
    const { sender, group, save } = await ready();
    await waitFor(() => expect(sender.value).toBe("99"));
    expect(group.value).toBe("8");
    fireEvent.click(save);
    await settle();
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["The saved sender is no longer verified in SendGrid. Pick another sender before saving."]);
    fireEvent.change(sender, { target: { value: "41" } });
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["The saved unsubscribe group is no longer in SendGrid. Pick another group."]);
    fireEvent.click(save);
    await settle();
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["The saved unsubscribe group is no longer in SendGrid. Pick another group before saving."]);
    expect(puts()).toHaveLength(0);
    fireEvent.change(group, { target: { value: "7" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(save);
    expect(await screen.findByText("Saved. New email cards use this sender and group.")).toBeDefined();
    expect(puts()).toEqual([
      { url: "/api/channels/email_marketing/settings/sendgrid_sender_id", method: "PUT", body: { items: ["41"] } },
      { url: "/api/channels/email_marketing/settings/sendgrid_suppression_group_id", method: "PUT", body: { items: ["7"] } },
    ]);
  });

  it("a stale saved group is never saved, and the reason is on screen", async () => {
    savedPicks("41", "8");
    const { group, save } = await ready();
    await waitFor(() => expect(group.value).toBe("8"));
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["The saved unsubscribe group is no longer in SendGrid. Pick another group."]);
    fireEvent.click(save);
    await settle();
    expect(puts()).toHaveLength(0);
    expect(screen.getAllByRole("alert").map((a) => a.textContent)).toEqual(["The saved unsubscribe group is no longer in SendGrid. Pick another group before saving."]);
    expect(screen.queryByText("Saved. New email cards use this sender and group.")).toBeNull();
  });
});

describe("template block", () => {
  it("drafts from the brand, then saves the edited template", async () => {
    set("GET /api/workspace/email-template", { template: null, fonts: ["system", "georgia"], can_edit: true });
    set("POST /api/workspace/email-template/draft", {
      draft: { logo_url: null, brand_color: "#2e7d32", button_color: "#2e7d32", font_key: "system", sign_off: "Northwind Clinic", postal_address: "400 Elm St", show_cards: false, company_name: "Northwind Clinic" },
    });
    set("PUT /api/workspace/email-template", {
      template: { logo_url: null, brand_color: "#2e7d32", button_color: "#2e7d32", font_key: "georgia", sign_off: "Northwind Clinic", postal_address: "400 Elm St", show_cards: false },
    });
    render(<EmailTemplateBlock />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Draft from brand" })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Draft from brand" }));
    await waitFor(() => expect((screen.getByLabelText("Brand color") as HTMLInputElement).value).toBe("#2e7d32"));
    fireEvent.change(screen.getByLabelText("Font"), { target: { value: "georgia" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({ logo_url: null, brand_color: "#2e7d32", button_color: "#2e7d32", font_key: "georgia", sign_off: "Northwind Clinic", postal_address: "400 Elm St", show_cards: false });
    expect(put.body).not.toHaveProperty("company_name");
    await waitFor(() => expect(screen.getByText(/emails already proposed keep the one they were drafted with/)).toBeDefined());
  });
});

describe("template block: controls look like buttons", () => {
  it("Draft from brand is an outlined button and Save template is a filled one, both with hover and pointer", async () => {
    set("GET /api/workspace/email-template", { template: null, fonts: ["system"], can_edit: true });
    render(<EmailTemplateBlock />);
    looksLikeButton(await screen.findByRole("button", { name: "Draft from brand" }));
    const save = await screen.findByRole("button", { name: "Save template" });
    for (const c of ["border-ink", "bg-ink", "text-cream", "cursor-pointer", "hover:opacity-90"]) expect(save.classList.contains(c), c).toBe(true);
  });
});

describe("template block: a redraft that changes nothing", () => {
  const SAVED = { logo_url: null, brand_color: "#cbd5e0", button_color: "#233d63", font_key: "system", sign_off: "Thanks,\nThe team", postal_address: "400 Elm St", show_cards: false };
  it("says nothing changed instead of asking to save when no Save button is shown, and a changed redraft still asks to save", async () => {
    set("GET /api/workspace/email-template", { template: { ...SAVED, updated_by: "u-1", updated_at: "2026-10-18T10:00:00.000Z" }, fonts: ["system"], can_edit: true });
    set("POST /api/workspace/email-template/draft", { draft: { ...SAVED, company_name: null } });
    render(
      <>
        <EmailTemplateBlock />
        <ConfirmDialogHost />
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Draft from brand" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draft again" }));
    expect(await screen.findByText("Zavi drafted the same template you already have. Nothing to save.")).toBeDefined();
    expect(screen.queryByText("Drafted from your brand. Check it, then save.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save template" })).toBeNull();
    set("POST /api/workspace/email-template/draft", { draft: { ...SAVED, brand_color: "#111111", company_name: null } });
    fireEvent.click(screen.getByRole("button", { name: "Draft from brand" }));
    fireEvent.click(await screen.findByRole("button", { name: "Draft again" }));
    expect(await screen.findByText("Drafted from your brand. Check it, then save.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Save template" })).toBeDefined();
  });
});

describe("template block: the postal address lives in Settings > Footer", () => {
  const SAVED = { logo_url: null, brand_color: "#2e7d32", button_color: "#2e7d32", font_key: "system", sign_off: "Northwind Clinic", postal_address: "400 Elm St", show_cards: false, updated_by: "u-1", updated_at: "2026-10-18T10:00:00.000Z" };

  it("shows no postal address field and saves the brand with the stored address, never the template's metadata", async () => {
    set("GET /api/workspace/email-template", { template: SAVED, fonts: ["system", "georgia"], can_edit: true });
    set("PUT /api/workspace/email-template", { template: { ...SAVED, brand_color: "#000000" } });
    render(<EmailTemplateBlock />);
    await waitFor(() => expect((screen.getByLabelText("Brand color") as HTMLInputElement).value).toBe("#2e7d32"));
    expect(screen.queryByLabelText(/Postal address/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Brand color"), { target: { value: "#000000" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      {
        url: "/api/workspace/email-template",
        method: "PUT",
        body: { logo_url: null, brand_color: "#000000", button_color: "#2e7d32", font_key: "system", sign_off: "Northwind Clinic", postal_address: "400 Elm St", show_cards: false },
      },
    ]);
  });

  it("a Footer save made after the Brand block loaded is kept: Brand re-reads the address right before saving", async () => {
    set("GET /api/workspace/email-template", { template: SAVED, fonts: ["system"], can_edit: true });
    set("PUT /api/workspace/email-template", { template: SAVED });
    render(<EmailTemplateBlock />);
    await waitFor(() => expect(screen.getByLabelText("Sign-off")).toBeDefined());
    set("GET /api/workspace/email-template", { template: { ...SAVED, postal_address: "12 Oak Ave, set in Footer" }, fonts: ["system"], can_edit: true });
    fireEvent.change(screen.getByLabelText("Sign-off"), { target: { value: "Thanks" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const put = calls.find((c) => c.method === "PUT")!.body as { postal_address: string; sign_off: string };
    expect(put.postal_address).toBe("12 Oak Ave, set in Footer");
    expect(put.sign_off).toBe("Thanks");
  });

  it("with no address anywhere, Save is not blocked up front; pressing it points to Footer and sends nothing", async () => {
    set("GET /api/workspace/email-template", { template: { ...SAVED, postal_address: null }, fonts: ["system"], can_edit: true });
    set("GET /api/channels/email_marketing/settings", { fields: {} });
    const goto = vi.fn();
    window.addEventListener("zavi:email-settings-goto", goto);
    render(<EmailTemplateBlock />);
    fireEvent.change(await screen.findByLabelText("Sign-off"), { target: { value: "Thanks" } });
    const save = screen.getByRole("button", { name: "Save template" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText(/Add your postal address in Settings > Footer first/)).toBeDefined());
    expect(calls.filter((c) => c.method === "PUT")).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Open Footer settings" }));
    expect((goto.mock.calls[0]![0] as CustomEvent).detail).toEqual({ section: "footer" });
    window.removeEventListener("zavi:email-settings-goto", goto);
  });

  it("an address only in the old channel setting does not count: the Brand save asks for the Footer address and saves nothing", async () => {
    set("GET /api/workspace/email-template", { template: { ...SAVED, postal_address: null }, fonts: ["system"], can_edit: true });
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: "7 Setting St" }] } });
    set("PUT /api/workspace/email-template", { template: { ...SAVED, postal_address: null } });
    render(<EmailTemplateBlock />);
    fireEvent.change(await screen.findByLabelText("Sign-off"), { target: { value: "Thanks" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    expect(await screen.findByText(/Add your postal address in Settings > Footer first/)).toBeTruthy();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });
});

describe("auto send block", () => {
  it("reads the channel's autorun, says the limits, and writes the switch", async () => {
    set("GET /api/workspace/growth/plan", { channels: [{ slug: "email_marketing", autorun: false }] });
    set("GET /api/workspace/email-test-lists", {
      routes: [
        {
          route: "sendgrid",
          label: "SendGrid",
          status: "complete",
          error: null,
          lists: [
            { id: "L1", name: "Patients", people: 120, marked: false, looks_like_test: false },
            { id: "L2", name: "Staff test", people: 3, marked: true, looks_like_test: true },
            { id: "L3", name: "Everyone", people: 4200, marked: false, looks_like_test: false },
          ],
        },
      ],
      orphans: [],
    });
    render(
      <>
        <ConfirmDialogHost />
        <EmailAutoSendBlock />
      </>,
    );
    expect(screen.getByText(AUTO_SEND_COPY)).toBeDefined();
    expect(AUTO_SEND_COPY).not.toMatch(/Off by default/);
    expect(AUTO_SEND_COPY).toMatch(/up to 1,000 people/);
    expect(AUTO_SEND_COPY).toMatch(/once per list every 7 days/);
    expect(AUTO_SEND_COPY).toMatch(/The rest waits for your approval/);
    const sw = await screen.findByRole("switch", { name: "Send without asking" });
    expect(sw.tagName).toBe("BUTTON");
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText("Off")).toBeDefined();
    fireEvent.click(sw);
    const dialog = await screen.findByRole("alertdialog");
    const can = within(dialog).getByRole("region", { name: "Can send by itself" });
    const waits = within(dialog).getByRole("region", { name: "Waits for your approval" });
    expect(within(can).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["PatientsSendGrid · 120 people"]);
    expect(within(waits).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["EveryoneSendGrid · 4,200 peopleover 1,000"]);
    expect(within(can).queryByText(/Everyone/)).toBeNull();
    expect(within(waits).queryByText(/Patients/)).toBeNull();
    expect(can.textContent).toContain("Can send by itself · 1");
    expect(waits.textContent).toContain("Waits for your approval · 1");
    expect(within(dialog).getByText("Test lists are never sent to.")).toBeDefined();
    expect(within(dialog).queryByText(/Staff test/)).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow Autopilot to send" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")).toEqual({
      url: "/api/workspace/growth/channels/email_marketing/autorun",
      method: "POST",
      body: { autorun: true },
    });
  });
});

describe("auto send: a real switch in a row", () => {
  it("an unreadable list read puts the error under the switch, keeps it off and sends nothing", async () => {
    set("GET /api/workspace/growth/plan", { channels: [{ slug: "email_marketing", autorun: false }] });
    set("GET /api/workspace/email-test-lists", { routes: [{ route: "klaviyo", label: "Klaviyo", status: "unreadable", error: "down", lists: [] }], orphans: [] });
    render(
      <>
        <ConfirmDialogHost />
        <EmailAutoSendBlock />
      </>,
    );
    const sw = await screen.findByRole("switch", { name: "Send without asking" });
    fireEvent.click(sw);
    const error = await screen.findByText(AUTO_SEND_UNREADABLE);
    expect(sw.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(sw.getAttribute("aria-checked")).toBe("false");
  });

  it("on shows its state text; a member sees the switch locked", async () => {
    set("GET /api/workspace/growth/plan", { channels: [{ slug: "email_marketing", autorun: true }] });
    ws.role = "member";
    render(<EmailAutoSendBlock />);
    const sw = (await screen.findByRole("switch", { name: "Send without asking" })) as HTMLButtonElement;
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.disabled).toBe(true);
    expect(screen.getByText("On, within the limits above")).toBeDefined();
    expect(screen.getByText(/Only a workspace owner or admin can change Autopilot sending/)).toBeDefined();
  });
});

describe("auto send: says when Autopilot is off", () => {
  const lists = {
    routes: [{ route: "sendgrid", label: "SendGrid", status: "complete", error: null, lists: [{ id: "L1", name: "Patients", people: 120, marked: false, looks_like_test: false }] }],
    orphans: [],
  };

  it("with Autopilot off, turning it on never promises Zavi sends now and never reads 'within the limits'", async () => {
    set("GET /api/workspace/growth/plan", { channels: [{ slug: "email_marketing", autorun: false }], head_of_growth: { autopilot: false }, unreadable: [] });
    set("GET /api/workspace/email-test-lists", lists);
    render(
      <>
        <ConfirmDialogHost />
        <EmailAutoSendBlock />
      </>,
    );
    const sw = await screen.findByRole("switch", { name: "Send without asking" });
    fireEvent.click(sw);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/Autopilot is off, so nothing sends by itself yet/);
    expect(dialog.textContent).not.toMatch(/Zavi will then send emails by itself/);
    set("GET /api/workspace/growth/plan", { channels: [{ slug: "email_marketing", autorun: true }], head_of_growth: { autopilot: false }, unreadable: [] });
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow Autopilot to send" }));
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(screen.getByText(AUTO_SEND_ON_AUTOPILOT_OFF)).toBeDefined();
    expect(screen.queryByText("On, within the limits above")).toBeNull();
  });

  it("with Autopilot on, the switch keeps its plain promise", async () => {
    set("GET /api/workspace/growth/plan", { channels: [{ slug: "email_marketing", autorun: true }], head_of_growth: { autopilot: true }, unreadable: [] });
    render(<EmailAutoSendBlock />);
    expect(await screen.findByText("On, within the limits above")).toBeDefined();
    expect(screen.queryByText(AUTO_SEND_ON_AUTOPILOT_OFF)).toBeNull();
  });

  it("an unreadable Autopilot read does not claim Autopilot is off", async () => {
    set("GET /api/workspace/growth/plan", { channels: [{ slug: "email_marketing", autorun: true }], head_of_growth: { autopilot: false }, unreadable: ["head_of_growth"] });
    render(<EmailAutoSendBlock />);
    expect(await screen.findByText("On, within the limits above")).toBeDefined();
    expect(screen.queryByText(AUTO_SEND_ON_AUTOPILOT_OFF)).toBeNull();
  });
});

describe("template block: rows, dirty save bar, picker", () => {
  const SAVED = { logo_url: null, brand_color: "#2e7d32", button_color: "#2e7d32", font_key: "system", sign_off: "Northwind Clinic", postal_address: "400 Elm St", show_cards: false };

  it("a saved, untouched template shows no Save; an edit shows it; undoing the edit hides it again", async () => {
    set("GET /api/workspace/email-template", { template: SAVED, fonts: ["system", "helvetica"], can_edit: true });
    render(<EmailTemplateBlock />);
    const signOff = (await screen.findByLabelText("Sign-off")) as HTMLInputElement;
    expect(signOff.tagName).toBe("INPUT");
    expect(screen.queryByRole("button", { name: "Save template" })).toBeNull();
    expect(screen.getByRole("button", { name: "Draft from brand" })).toBeDefined();
    fireEvent.change(signOff, { target: { value: "Thanks" } });
    expect(screen.getByRole("button", { name: "Save template" })).toBeDefined();
    fireEvent.change(signOff, { target: { value: "Northwind Clinic" } });
    expect(screen.queryByRole("button", { name: "Save template" })).toBeNull();
    expect(screen.getByText("Your postal address and unsubscribe link are in Footer.")).toBeDefined();
    expect(screen.getByLabelText("Logo link").getAttribute("placeholder")).toBe("https://yoursite.com/logo.png");
    expect(screen.getByText("Products, plans or listings from your data.")).toBeDefined();
  });

  it("font options read capitalized but keep their keys; the color picker writes the hex the save sends", async () => {
    set("GET /api/workspace/email-template", { template: SAVED, fonts: ["system", "helvetica"], can_edit: true });
    set("PUT /api/workspace/email-template", { template: { ...SAVED, brand_color: "#ff0000", show_cards: true } });
    render(<EmailTemplateBlock />);
    const font = (await screen.findByLabelText("Font")) as HTMLSelectElement;
    expect([...font.options].map((o) => [o.value, o.textContent])).toEqual([["system", "System"], ["helvetica", "Helvetica"]]);
    fireEvent.input(screen.getByLabelText("Pick brand color"), { target: { value: "#ff0000" } });
    expect((screen.getByLabelText("Brand color") as HTMLInputElement).value).toBe("#ff0000");
    fireEvent.click(screen.getByRole("switch", { name: "Show product cards" }));
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ brand_color: "#ff0000", show_cards: true, font_key: "system" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save template" })).toBeNull());
  });

  it("a member sees no Save and no Draft, and is told who can change it", async () => {
    set("GET /api/workspace/email-template", { template: SAVED, fonts: ["system"], can_edit: false });
    render(<EmailTemplateBlock />);
    expect(await screen.findByText(/Only a workspace owner or admin can change the template/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Save template" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Draft from brand" })).toBeNull();
  });
});

describe("the channel row asks for the blocks by id", () => {
  it("renders each new block from its panel id", async () => {
    set("GET /api/workspace/email-template", { template: null, fonts: [], can_edit: false });
    set("GET /api/workspace/growth/plan", { channels: [] });
    set("GET /api/workspace/email-test-lists", { routes: [{ route: "sendgrid", label: "SendGrid", status: "complete", error: null, lists: [] }], orphans: [] });
    render(<ChannelSettingsPanels panels={["email_template", "email_sendgrid", "email_auto_send"]} />);
    expect(screen.getByTestId("email-template")).toBeDefined();
    expect(screen.queryByRole("heading", { name: "Email template" })).toBeNull();
    expect(await screen.findByRole("heading", { name: "SendGrid sender", hidden: true })).toBeDefined();
    expect(screen.getByRole("heading", { name: "Send without asking", hidden: true })).toBeDefined();
  });
});
