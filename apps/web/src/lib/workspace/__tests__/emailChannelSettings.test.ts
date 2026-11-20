import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api", () => ({ apiFetch: (...a: unknown[]) => apiFetch(...a) }));

import { getEmailChannelSettings } from "../emailCampaignSettingsApi";
import { loadFooterPostal } from "@/components/workspace/email/postalAddress";

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

function serve(settings: unknown, template: unknown = { template: null, fonts: [], can_edit: true }) {
  apiFetch.mockImplementation((path: string) => {
    if (path === "/api/channels/email_marketing/settings") return ok(settings);
    if (path === "/api/workspace/email-template") return ok(template);
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  });
}

beforeEach(() => apiFetch.mockReset());

describe("getEmailChannelSettings skips settings the founder turned off, like the backend does", () => {
  it("a paused or dismissed row is not a setting; the next live row is", async () => {
    serve({
      fields: {
        sendgrid_sender_id: [
          { item: "111", status: "paused" },
          { item: "222", status: "dismissed" },
          { item: "333", status: "active" },
        ],
        sendgrid_suppression_group_id: [{ item: "9", status: "paused" }],
        postal_address: [{ item: "OLD 1 Old Rd, Reno NV 89501", status: "paused" }],
        esp: [{ item: "mailchimp", status: null }],
      },
    });
    expect(await getEmailChannelSettings()).toEqual({
      sendgrid_sender_id: ["333"],
      sendgrid_suppression_group_id: [],
      postal_address: [],
      esp: ["mailchimp"],
    });
  });

  it("with no template row, a paused old postal setting never becomes the footer address", async () => {
    serve({ fields: { postal_address: [{ item: "OLD 1 Old Rd, Reno NV 89501", status: "paused" }] } });
    expect(await loadFooterPostal()).toBe("");
    serve({ fields: { postal_address: [{ item: "OLD 1 Old Rd, Reno NV 89501", status: "paused" }, { item: "12 Elm St, Austin TX 78701" }] } });
    expect(await loadFooterPostal()).toBe("12 Elm St, Austin TX 78701");
  });
});
