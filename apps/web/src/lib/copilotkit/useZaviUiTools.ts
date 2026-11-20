"use client";

import { useRouter } from "next/navigation";
import { z } from "zod";
import { useFrontendTool } from "@copilotkit/react-core/v2/headless";
import { useWorkspace } from "@/components/workspace/WorkspaceShell";
import { STATIC_TITLES, type StaticKind } from "@/components/workspace/layout/shared";

function staticKinds(): [StaticKind, ...StaticKind[]] {
  return Object.keys(STATIC_TITLES) as [StaticKind, ...StaticKind[]];
}

export function openTabArgs() {
  return z.object({ kind: z.enum(staticKinds()).describe("Which workspace destination to open.") });
}
export const OpenAgentArgs = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).describe("Agent slug, e.g. growth-lead."),
  new_thread: z.boolean().optional().describe("Start a fresh conversation instead of the latest one."),
});
export const OpenApprovalArgs = z.object({
  decision_id: z.string().uuid().optional().describe("The decision to review; opens the approvals queue."),
});

export function useZaviUiTools() {
  const { openTab, openAgentTab } = useWorkspace();
  const router = useRouter();

  useFrontendTool({
    name: "open_tab",
    description: `Open a workspace destination for the user. One of: ${staticKinds().join(", ")}.`,
    parameters: openTabArgs(),
    followUp: false,
    handler: async ({ kind }) => {
      openTab({ kind, title: STATIC_TITLES[kind], payload: { kind } as never, dirty: false, pinned: kind === "home" });
      return `opened ${kind}`;
    },
  });

  useFrontendTool({
    name: "open_agent",
    description: "Open (or start) a conversation with one of the user's agents.",
    parameters: OpenAgentArgs,
    followUp: false,
    handler: async ({ slug, new_thread }) => {
      await openAgentTab(slug, { newThread: new_thread === true });
      return `opened ${slug}`;
    },
  });

  useFrontendTool({
    name: "open_approval",
    description: "Take the user to their pending approvals (the Needs-you-now queue on Home).",
    parameters: OpenApprovalArgs,
    followUp: false,
    handler: async () => {
      openTab({ kind: "home", title: STATIC_TITLES.home, payload: { kind: "home" }, dirty: false, pinned: true });
      router.push("/workspace");
      return "opened approvals";
    },
  });
}
