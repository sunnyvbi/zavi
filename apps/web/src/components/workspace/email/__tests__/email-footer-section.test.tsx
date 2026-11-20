// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

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

import { EmailFooterSection } from "../EmailFooterSection";

const set = (key: string, body: unknown, status = 200) => {
  routes[key] = { status, body };
};

const STORED = {
  logo_url: "https://cdn.northwind.test/logo.png",
  brand_color: "#2e7d32",
  button_color: "#1b5e20",
  font_key: "georgia",
  sign_off: "Northwind Clinic team",
  postal_address: "400 Elm St, Austin TX 78701",
  show_cards: true,
  updated_by: "u-1",
  updated_at: "2026-10-18T10:00:00.000Z",
};

const writes = () => calls.filter((c) => c.method !== "GET");
const postal = () => screen.getByLabelText(/^Postal address/) as HTMLTextAreaElement;
const unsub = () => screen.getByLabelText("Unsubscribe link") as HTMLInputElement;
const toastAdd = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: { add: (o: unknown) => toastAdd(o) } }));
const saveBtn = () => screen.getByRole("button", { name: "Save footer" }) as HTMLButtonElement;

let saved: ReturnType<typeof vi.fn>;
beforeEach(() => {
  toastAdd.mockReset();
  calls.length = 0;
  for (const k of Object.keys(routes)) delete routes[k];
  set("GET /api/workspace/email-template", { template: STORED, fonts: ["system", "georgia"], can_edit: true });
  set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: "400 Elm St, Austin TX 78701" }] } });
  saved = vi.fn();
  window.addEventListener("zavi:email-footer-saved", saved);
});
afterEach(() => {
  window.removeEventListener("zavi:email-footer-saved", saved);
  cleanup();
});

describe("Settings > Footer", () => {
  it("is the footer anchor the channel page scrolls to, with the two design rows and no link-tracking switch", async () => {
    render(<EmailFooterSection />);
    await waitFor(() => expect(postal().value).toBe("400 Elm St, Austin TX 78701"));
    const section = document.getElementById("email-settings-footer")!;
    expect(section.tagName).toBe("SECTION");
    expect(screen.getByRole("heading", { level: 2, name: "Footer" }).id).toBe(section.getAttribute("aria-labelledby"));
    expect(postal().placeholder).toBe("Street, city, state, ZIP");
    expect(unsub().placeholder).toBe("Added by your email tool when connected");
    expect(section.textContent).toContain("Required by US law");
    expect(screen.queryByRole("switch")).toBeNull();
    expect(section.textContent).not.toMatch(/tracking/i);
    expect(screen.queryByRole("button", { name: "Save footer" })).toBeNull();
    fireEvent.change(unsub(), { target: { value: "https://northwind.test/u" } });
    expect(saveBtn().disabled).toBe(false);
    expect(saveBtn().className).toContain("h-10");
    fireEvent.change(unsub(), { target: { value: "" } });
    expect(screen.queryByRole("button", { name: "Save footer" })).toBeNull();
  });

  it("Save footer is a filled button with pointer and hover", async () => {
    render(<EmailFooterSection />);
    await waitFor(() => expect(postal().value).toBe("400 Elm St, Austin TX 78701"));
    fireEvent.change(unsub(), { target: { value: "https://northwind.test/u" } });
    const save = saveBtn();
    for (const c of ["border-ink", "bg-ink", "text-cream", "cursor-pointer", "hover:opacity-90"]) expect(save.classList.contains(c), c).toBe(true);
  });

  it("a save puts the form back to normal, shows one green confirmation, and the next edit brings the button back", async () => {
    render(<EmailFooterSection />);
    await waitFor(() => expect(postal().value).toBe("400 Elm St, Austin TX 78701"));
    fireEvent.change(unsub(), { target: { value: "https://northwind.test/u" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1));
    expect(toastAdd).toHaveBeenCalledWith({ type: "success", title: "Your footer is saved", position: "top-center", dismissible: false });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save footer" })).toBeNull());
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.change(unsub(), { target: { value: "https://northwind.test/v" } });
    expect(saveBtn().disabled).toBe(false);
  });

  it("saves the postal address into the template with every other field untouched, then into the channel setting, and tells open cards", async () => {
    render(<EmailFooterSection />);
    await waitFor(() => expect(postal().value).toBe("400 Elm St, Austin TX 78701"));
    fireEvent.change(postal(), { target: { value: "  12 Oak Ave, Austin TX 78702  " } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("footer-drafts-note").textContent).toBe("New emails use this footer. Emails already drafted keep theirs.");
    expect(writes()).toEqual([
      {
        url: "/api/workspace/email-template",
        method: "PUT",
        body: {
          logo_url: "https://cdn.northwind.test/logo.png",
          brand_color: "#2e7d32",
          button_color: "#1b5e20",
          font_key: "georgia",
          sign_off: "Northwind Clinic team",
          postal_address: "12 Oak Ave, Austin TX 78702",
          show_cards: true,
        },
      },
      { url: "/api/channels/email_marketing/settings/postal_address", method: "PUT", body: { items: ["12 Oak Ave, Austin TX 78702"] } },
    ]);
    const getTemplate = calls.filter((c) => c.method === "GET" && c.url === "/api/workspace/email-template");
    expect(getTemplate.length).toBe(2);
    expect(saved).toHaveBeenCalledTimes(1);
  });

  it("with no template yet, builds on Zavi's draft from the brand and saves it with the address", async () => {
    set("GET /api/workspace/email-template", { template: null, fonts: [], can_edit: true });
    set("GET /api/channels/email_marketing/settings", { fields: {} });
    set("POST /api/workspace/email-template/draft", {
      draft: { logo_url: null, brand_color: "#123456", button_color: "#654321", font_key: "system", sign_off: "Northwind", postal_address: null, show_cards: false, company_name: "Northwind Clinic" },
    });
    render(<EmailFooterSection />);
    await waitFor(() => expect(postal().value).toBe(""));
    fireEvent.change(postal(), { target: { value: "9 Pine Rd, Reno NV 89501" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(writes().length).toBe(3));
    expect(writes()[0]).toEqual({ url: "/api/workspace/email-template/draft", method: "POST", body: undefined });
    expect(writes()[1]!.body).toEqual({
      logo_url: null,
      brand_color: "#123456",
      button_color: "#654321",
      font_key: "system",
      sign_off: "Northwind",
      postal_address: "9 Pine Rd, Reno NV 89501",
      show_cards: false,
    });
    expect(writes()[2]).toEqual({ url: "/api/channels/email_marketing/settings/postal_address", method: "PUT", body: { items: ["9 Pine Rd, Reno NV 89501"] } });
  });

  it("an address only in the old channel setting is not shown and not copied: the template is the one source", async () => {
    set("GET /api/workspace/email-template", { template: { ...STORED, postal_address: null }, fonts: [], can_edit: true });
    render(<EmailFooterSection />);
    await waitFor(() => expect(unsub()).toBeDefined());
    expect(postal().value).toBe("");
    expect(document.getElementById("email-settings-footer")!.textContent).not.toContain("400 Elm St");
    fireEvent.change(unsub(), { target: { value: "https://northwind.test/unsubscribe" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(writes()).toEqual([{ url: "/api/channels/email_marketing/settings/unsubscribe_link", method: "PUT", body: { items: ["https://northwind.test/unsubscribe"] } }]);
  });

  it("a template address wins over a different old setting, and saving it again keeps the mobile setting in step", async () => {
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: "OLD 1 Old Rd" }] } });
    render(<EmailFooterSection />);
    await waitFor(() => expect(postal().value).toBe("400 Elm St, Austin TX 78701"));
    expect(screen.queryByRole("button", { name: "Save footer" })).toBeNull();
    fireEvent.change(postal(), { target: { value: "12 Oak Ave" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(writes().map((w) => `${w.method} ${w.url}`)).toEqual(["PUT /api/workspace/email-template", "PUT /api/channels/email_marketing/settings/postal_address"]);
  });

  it("an unsubscribe-only save never rewrites a paused old postal setting", async () => {
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: "400 Elm St, Austin TX 78701", status: "paused" }] } });
    render(<EmailFooterSection />);
    await waitFor(() => expect(postal().value).toBe("400 Elm St, Austin TX 78701"));
    fireEvent.change(unsub(), { target: { value: "https://northwind.test/u" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(writes().map((w) => `${w.method} ${w.url}`)).toEqual(["PUT /api/channels/email_marketing/settings/unsubscribe_link"]);
  });

  it.each([
    ["not a link", false],
    ["http://northwind.test/u", false],
    ["https://northwind.test/u", true],
    ["*|UNSUB|*", true],
    ["{% unsubscribe_link %}", true],
    ["{{{unsubscribe}}}", true],
    ["{% unsubscribe 'Unsubscribe' %}", true],
    ["<%asm_group_unsubscribe_raw_url%>", true],
    ["<%asm_global_unsubscribe_raw_url%>", true],
    ["<%asm_preferences_raw_url%>", false],
  ])("unsubscribe link %s accepted: %s", async (value, ok) => {
    render(<EmailFooterSection />);
    await waitFor(() => expect(postal().value).not.toBe(""));
    fireEvent.change(unsub(), { target: { value } });
    fireEvent.click(saveBtn());
    if (ok) {
      await waitFor(() => expect(writes()).toEqual([{ url: "/api/channels/email_marketing/settings/unsubscribe_link", method: "PUT", body: { items: [value] } }]));
    } else {
      await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("https://"));
      expect(writes()).toEqual([]);
      expect(saved).not.toHaveBeenCalled();
    }
  });

  it("an old saved unsubscribe link the check now refuses does not block a postal save, and is not rewritten", async () => {
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: "400 Elm St, Austin TX 78701" }], unsubscribe_link: [{ item: "http://northwind.test/u" }] } });
    render(<EmailFooterSection />);
    await waitFor(() => expect(unsub().value).toBe("http://northwind.test/u"));
    fireEvent.change(postal(), { target: { value: "12 Oak Ave, Austin TX 78702" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(writes().map((w) => `${w.method} ${w.url}`)).toEqual(["PUT /api/workspace/email-template", "PUT /api/channels/email_marketing/settings/postal_address"]);
    expect(saved).toHaveBeenCalledTimes(1);
    fireEvent.change(unsub(), { target: { value: "http://northwind.test/other" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("https://"));
    expect(writes().length).toBe(2);
  });

  it("clearing the unsubscribe link clears the setting; clearing a saved postal address is refused", async () => {
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: "400 Elm St, Austin TX 78701" }], unsubscribe_link: [{ item: "https://northwind.test/u" }] } });
    render(<EmailFooterSection />);
    await waitFor(() => expect(unsub().value).toBe("https://northwind.test/u"));
    fireEvent.change(postal(), { target: { value: " " } });
    fireEvent.change(unsub(), { target: { value: "" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("cannot be removed"));
    expect(writes()).toEqual([]);
    fireEvent.change(postal(), { target: { value: "400 Elm St, Austin TX 78701" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(writes()).toEqual([{ url: "/api/channels/email_marketing/settings/unsubscribe_link", method: "PUT", body: { items: [] } }]));
  });

  it("a refused template save writes no setting, tells no card, and shows the server's sentence", async () => {
    set("PUT /api/workspace/email-template", { error: { code: "invalid_template", message: "The postal address is too long (500 characters at most)." } }, 400);
    render(<EmailFooterSection />);
    await waitFor(() => expect(postal().value).not.toBe(""));
    fireEvent.change(postal(), { target: { value: "1 New St" } });
    fireEvent.click(saveBtn());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("too long"));
    expect(writes().map((w) => w.url)).toEqual(["/api/workspace/email-template"]);
    expect(saved).not.toHaveBeenCalled();
    expect(toastAdd).not.toHaveBeenCalled();
    expect(saveBtn().disabled).toBe(false);
  });

  it("says the connected tool adds each person's link, so the field is optional", async () => {
    set("GET /api/channels/email_marketing/settings", { fields: { esp: [{ item: "klaviyo" }] } });
    render(<EmailFooterSection />);
    await waitFor(() => expect(screen.getByTestId("footer-unsubscribe-note").textContent).toBe("Klaviyo adds each person's unsubscribe link. Leave this empty."));
    expect(unsub().placeholder).toBe("Optional");
    cleanup();
    set("GET /api/channels/email_marketing/settings", { fields: { sendgrid_sender_id: [{ item: "41" }] } });
    render(<EmailFooterSection />);
    await waitFor(() => expect(screen.getByTestId("footer-unsubscribe-note").textContent).toBe("SendGrid adds each person's unsubscribe link. Leave this empty."));
    expect(unsub().placeholder).toBe("Optional");
  });

  it("a member reads the footer but cannot change it", async () => {
    set("GET /api/workspace/email-template", { template: STORED, fonts: [], can_edit: false });
    render(<EmailFooterSection />);
    await waitFor(() => expect(postal().value).toBe("400 Elm St, Austin TX 78701"));
    expect(postal().disabled).toBe(true);
    expect(unsub().disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save footer" })).toBeNull();
    expect(screen.getByText("Only a workspace owner or admin can change the footer.")).toBeDefined();
  });

  it("a failed load says so and Retry loads again", async () => {
    set("GET /api/channels/email_marketing/settings", { error: { code: "read_failed", message: "Could not read settings." } }, 500);
    render(<EmailFooterSection />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not read settings."));
    set("GET /api/channels/email_marketing/settings", { fields: {} });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(postal().value).toBe("400 Elm St, Austin TX 78701"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Settings > Footer placeholder address", () => {
  it("warns under the field when the saved or typed address is a placeholder, and the warning goes once a real address is typed", async () => {
    set("GET /api/workspace/email-template", { template: { ...STORED, postal_address: "123 Main St, Anytown, CA 90000" }, fonts: ["system"], can_edit: true });
    set("GET /api/channels/email_marketing/settings", { fields: { postal_address: [{ item: "123 Main St, Anytown, CA 90000" }] } });
    render(<EmailFooterSection />);
    await waitFor(() => expect(postal().value).toBe("123 Main St, Anytown, CA 90000"));
    const warn = screen.getByTestId("footer-postal-placeholder");
    expect(warn.textContent).toBe("This still looks like a placeholder. Zavi can't send until it is your real postal address.");
    expect(postal().getAttribute("aria-describedby")).toBe(warn.id);
    fireEvent.change(postal(), { target: { value: "400 Elm St, Austin TX 78701" } });
    expect(screen.queryByTestId("footer-postal-placeholder")).toBeNull();
    fireEvent.change(postal(), { target: { value: "Your address here" } });
    expect(screen.getByTestId("footer-postal-placeholder")).toBeTruthy();
  });

  it("a real address shows no placeholder warning", async () => {
    render(<EmailFooterSection />);
    await waitFor(() => expect(postal().value).toBe("400 Elm St, Austin TX 78701"));
    expect(screen.queryByTestId("footer-postal-placeholder")).toBeNull();
  });
});
