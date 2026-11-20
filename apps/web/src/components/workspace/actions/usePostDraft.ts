import { useEffect, useState } from "react";
import { postDraftContentSchema, savedPostDraftSchema, type PostDraftContent } from "@zavi/shared";
import { z } from "zod";
import { campaignFetch } from "./managed-campaigns/api";
import type { ActionItem } from "./types";

const response = z.object({ revision: z.string(), content: savedPostDraftSchema.nullable(), editable: z.boolean().optional() });
export function usePostDraft(action: ActionItem, enabled: boolean) {
  const persisted = enabled && action.source === "channel_action" && /^[a-f0-9-]{36}$/i.test(action.id) && !action.executable;
  const [read, setRead] = useState<{ revision: string; publishRevision?: string; error: string; loading: boolean }>({ revision: "", error: "", loading: persisted });
  const path = `/api/channel-actions/${encodeURIComponent(action.staged_draft_id ?? action.id)}/post-draft${action.staged_draft_id || action.run_id === null ? "?store=decisions" : ""}`;
  useEffect(() => {
    if (!persisted) return;
    let stopped = false;
    void campaignFetch<unknown>(path).then((value) => {
      const result = response.parse(value);
      if (action.post_revision && result.revision !== action.post_revision) throw new Error("This draft changed. Refresh before editing it.");
      const known = savedPostDraftSchema.safeParse(action.edited_body);
      if (JSON.stringify(result.content) !== JSON.stringify(known.success ? known.data : null)) throw new Error("This draft changed. Refresh before editing it.");
      if (!result.editable) throw new Error("This draft is no longer editable.");
      if (!stopped) setRead({ revision: result.revision, error: "", loading: false });
    }).catch((error) => { if (!stopped) setRead({ revision: "", error: error instanceof Error ? error.message : "Could not load the draft.", loading: false }); });
    return () => { stopped = true; };
  }, [persisted, path, action.edited_body, action.post_revision]);
  async function save(content: PostDraftContent) {
    if (!read.revision) throw new Error(read.error || "Wait for the saved draft to load.");
    const result = response.parse(await campaignFetch<unknown>(path, { method: "PUT", body: JSON.stringify({ revision: read.revision, content: postDraftContentSchema.parse(content) }) }));
    setRead({ revision: result.revision, publishRevision: result.revision, error: "", loading: false });
    return result.content;
  }
  return { persisted, ...read, save };
}
