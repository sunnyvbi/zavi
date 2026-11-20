import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import {
  defaultPostDeps,
  postLibraryVideo,
  PostError,
  POST_TARGET_NAMES,
  readPostTargets,
  type PostDeps,
  type PostTargetName,
} from "@/services/video-studio/post";

const postBody = z
  .object({
    channels: z.array(z.enum(POST_TARGET_NAMES as [PostTargetName, ...PostTargetName[]])).min(1).max(POST_TARGET_NAMES.length),
    caption: z.string().max(2200).optional(),
    repost: z.array(z.enum(POST_TARGET_NAMES as [PostTargetName, ...PostTargetName[]])).max(POST_TARGET_NAMES.length).optional(),
  })
  .strict();

const videoId = z.string().uuid();

export function videoStudioPostHandlers(deps: PostDeps = defaultPostDeps) {
  return {
    async targets(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      try {
        res.json({ targets: await readPostTargets(auth.tenant_id, deps) });
      } catch (e) {
        console.warn(`[video-studio] post targets failed: ${(e as Error).message}`);
        res.status(500).json({ error: { code: "video_post_targets_failed", message: "Your channels could not be loaded. Try again." } });
      }
    },

    async post(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      if (auth.tenant_overridden === true) {
        res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." } });
        return;
      }
      const id = videoId.safeParse(req.params?.id);
      const body = postBody.safeParse(req.body);
      if (!id.success || !body.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "Pick at least one channel, then post again." } });
        return;
      }
      try {
        const results = await postLibraryVideo(deps, {
          tenant_id: auth.tenant_id,
          user_id: auth.user_id,
          artifact_id: id.data,
          names: body.data.channels,
          caption: body.data.caption ?? null,
          repost: body.data.repost,
        });
        res.json({ results });
      } catch (e) {
        if (e instanceof PostError) {
          res.status(e.status).json({ error: { code: e.code, message: e.message } });
          return;
        }
        console.warn(`[video-studio] library post failed: ${(e as Error).message}`);
        res.status(500).json({ error: { code: "video_post_failed", message: "Nothing was posted. Try again in a minute." } });
      }
    },
  };
}

const handlers = videoStudioPostHandlers();
export const videoStudioPostTargets = handlers.targets;
export const videoStudioPost = handlers.post;
