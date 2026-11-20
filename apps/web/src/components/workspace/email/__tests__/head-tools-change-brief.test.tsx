// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  apiFetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
}));
vi.mock("../../WorkspaceShell", () => ({ useWorkspaceOptional: () => ({ role: "owner" }) }));

import { askTopActionAgain } from "../../actions/topActions/api";
import { ChannelPageHeaderSlotProvider } from "../../layout/ChannelHeaderRow";
import { EmailHeadTools } from "../EmailHeadTools";
import { campaignDraftFromInputs } from "../NewCampaignDialog";

const brief = () => screen.getByLabelText("What should this email do?") as HTMLTextAreaElement;

function mount() {
  render(
    <ChannelPageHeaderSlotProvider element={null}>
      <EmailHeadTools slug="email_marketing" channelName="Email campaigns" />
    </ChannelPageHeaderSlotProvider>,
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

describe("Change brief on a refused repeat", () => {
  it("reopens the real New campaign with the earlier brief, and a plain open after that starts empty", async () => {
    mount();
    await act(async () => askTopActionAgain("email_marketing", "new_email", { route: "klaviyo", list_id: "VYfr94", brief: "Happy diwali" }));
    expect(brief().value).toBe("Happy diwali");
    cleanup();
    mount();
    await act(async () => askTopActionAgain("email_marketing", "new_email"));
    expect(brief().value).toBe("");
  });

  it("does not fill another channel's dialog", async () => {
    mount();
    await act(async () => askTopActionAgain("sms", "new_email", { route: "klaviyo", list_id: "VYfr94", brief: "Happy diwali" }));
    expect(screen.queryByLabelText("What should this email do?")).toBeNull();
  });
});

describe("campaignDraftFromInputs", () => {
  it("keeps route, list, brief, subject and preview", () => {
    expect(campaignDraftFromInputs({ route: "zavi_list", list_id: "L1", brief: "Spring", subject: "S", preview_text: "P" })).toMatchObject({ pick: "zavi_list:L1", mode: "ai", prompt: "Spring", subject: "S", preview: "P", when: "approve" });
  });
  it("a pasted email comes back as a pasted email", () => {
    expect(campaignDraftFromInputs({ route: "klaviyo", list_id: "L1", pasted: { subject: "S", preview_text: "P", body: "Hello there" } })).toMatchObject({ pick: "klaviyo:L1", mode: "paste", prompt: "", paste: "Hello there", subject: "S", preview: "P" });
  });
  it("no route or list gives no draft", () => {
    expect(campaignDraftFromInputs({ brief: "Spring" })).toBeNull();
  });
});
