
import { z } from "zod";
import type { ToolSpec } from "@/services/tools/types";
import { ExpectedToolError } from "@/services/tools/types";

const inputSchema = z.object({});

export const contentPunchlistTool: ToolSpec = {
  name: "growth_content_punchlist",
  effect: "read",
  description:
    "Produce a content-gap punchlist (high-intent topics the operator has no content for). Read-only. Currently returns content_not_connected — treat content as a manual operator lever and say so in your bets.",
  input_schema: inputSchema,
  async execute(_ctx, input) {
    inputSchema.parse(input);
    throw new ExpectedToolError(
      "content_not_connected",
      "Content source not wired yet. Recommend the operator build a content punchlist manually; revisit when a content source is connected.",
    );
  },
};
