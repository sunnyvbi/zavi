import { toast } from "@/components/ui/toast";
import { type PostOutcome } from "@/lib/workspace/socialPostWatch";
import { followSocialPost, socialPostNotice } from "@/lib/workspace/socialPostFollow";

export async function followPostInToast(
  decisionId: string,
  platform: string,
  watch?: (id: string) => Promise<PostOutcome>,
  tenantId?: string | null,
): Promise<PostOutcome> {
  const id = toast.add({ type: "loading", title: `Posting to ${platform}…`, timeout: 0, dismissible: false });
  const out = await followSocialPost(decisionId, platform, tenantId, watch);
  const notice = socialPostNotice(out, platform);
  toast.update(id, {
    ...notice,
    ...((out.state === "posted" || out.state === "partial") && out.url
      ? { actionProps: { children: platform === "Pinterest" ? "Open pin" : "Open post", onClick: () => window.open(out.url!, "_blank", "noopener") } }
      : {}),
  });
  return out;
}
