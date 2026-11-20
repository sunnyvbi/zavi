
import { z } from "zod";

export const ctoShipPrPayloadSchema = z.object({
  task_description: z.string().min(1).max(2000),
  repo_hint: z.string().optional(),
  file_hints: z.array(z.string()).max(5).optional(),
  context_summary: z.string().max(500).default(""),
  source_agent: z.string().default("manual"),
});

export type CtoShipPrPayload = z.infer<typeof ctoShipPrPayloadSchema>;
