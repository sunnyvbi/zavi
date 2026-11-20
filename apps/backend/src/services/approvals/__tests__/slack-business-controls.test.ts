import { expect, it } from "vitest";
import { buildApprovalBlocks } from "../slack-approval-blocks";
it("offers a link to review business settings, with no blind Slack approval", () => {
  const blocks = buildApprovalBlocks({
    id: "d",
    decision_class: "growth.save_business_controls",
    body: {},
    dispatch_handler: null,
  });
  const actions = (
    blocks as Array<{
      type: string;
      elements?: Array<{
        action_id?: string;
        url?: string;
        text?: { text: string };
      }>;
    }>
  )
    .filter((b) => b.type === "actions")
    .flatMap((b) => b.elements ?? []);
  expect(actions).toHaveLength(1);
  expect(actions[0].url).toMatch(/\/workspace\?tab=needs-you(&company=[^&]+)?&decision=/);
  expect(actions[0].action_id).toBeUndefined();
  expect(actions[0].text?.text).toBe("Review settings in Zavi");
});
