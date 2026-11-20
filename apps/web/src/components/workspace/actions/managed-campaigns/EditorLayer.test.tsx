// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ campaignFetch: api }));
import { GoogleCampaignHost } from "./google/GoogleCampaignHost";
import { openGoogleCampaignEditor } from "./google/googleEditorApi";
import { MetaCampaignHost } from "./meta/MetaCampaignHost";
import { openMetaCampaignEditor } from "./meta/metaEditorApi";

beforeEach(() => {
  api.mockReset();
  api.mockImplementation(() => new Promise(() => {}));
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);

function hiddenTab(host: React.ReactNode) {
  return render(
    <div className="workspace-shell" data-testid="shell">
      <div hidden data-testid="overview-tab">{host}</div>
    </div>,
  );
}

it.each([
  ["Google", <GoogleCampaignHost key="g" onChanged={() => {}} />, () => openGoogleCampaignEditor({ campaign_id: "1" })],
  ["Meta", <MetaCampaignHost key="m" onChanged={() => {}} />, () => openMetaCampaignEditor({ campaign_id: "1" })],
] as const)("%s: an Edit from another tab opens the editor outside the hidden Overview tab", (_, host, open) => {
  hiddenTab(host);
  act(() => open());
  const dialog = screen.getByRole("dialog", { name: "Edit campaign" });
  expect(screen.getByTestId("overview-tab").contains(dialog)).toBe(false);
  expect(screen.getByTestId("shell").contains(dialog)).toBe(true);
});
