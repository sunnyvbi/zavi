
import { inngest } from "../client";
import { suggestRuleFromChatTurn } from "@/services/rules/suggest";

const C8_NOTE = "C8 reverified: the run is re-read by run_id inside the claimed tenant scope";

export const ruleSuggestChatFn = inngest.createFunction(
  { id: "rule-suggest-chat", retries: 1 },
  { event: "chat.turn_complete" },
  async ({ event, step, logger }) => {
    const run_id = event.data.run_id as string | undefined;
    const tenant_id = event.data.tenant_id as string | undefined;
    if (!run_id || !tenant_id) return { suggested: false };
    const rule = await step.run("suggest", () => suggestRuleFromChatTurn(tenant_id, run_id));
    if (rule) logger.info(`[rule-suggest-chat] ${run_id}: suggested ${rule.rule_id} (${C8_NOTE})`);
    return { suggested: !!rule };
  },
);
