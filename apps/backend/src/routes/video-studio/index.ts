import type { Request, Response } from "express";
import { z } from "zod";
import { requireAuth } from "@/services/auth/middleware";
import { supabaseStudioStore } from "@/services/video-studio/store";
import { readPostStates } from "@/services/video-studio/post";
import {
  defaultStudioDeps,
  listStudioThreads,
  readGallery,
  readStudio,
  readStudioPrompt,
  retryStudioRender,
  sendStudioMessage,
  StudioError,
  writeStudioScript,
  type StudioDeps,
} from "@/services/video-studio/studio";

const sendBody = z.object({
  text: z.string().default(""),
  image_path: z.string().max(300).optional(),
  thread_id: z.string().uuid().optional(),
  new_thread: z.boolean().optional(),
  verbatim: z.boolean().optional(),
});

const scriptBody = z.object({ prompt: z.string().default("") });

const renderBody = z.object({ message_id: z.string().uuid(), thread_id: z.string().uuid().optional() }).strict();

const threadQuery = z.string().uuid();

export type MakeStudioDeps = (tenant_id: string) => StudioDeps;

const defaultMakeDeps: MakeStudioDeps = (tenant_id) => defaultStudioDeps(supabaseStudioStore(tenant_id));

function sendError(res: Response, e: unknown, fallback: string): void {
  if (e instanceof StudioError) {
    res.status(e.status).json({ error: { code: e.code, message: e.message, ...e.extra } });
    return;
  }
  console.warn(`[video-studio] ${fallback}: ${(e as Error).message}`);
  res.status(500).json({ error: { code: fallback, message: "Something went wrong. Try again." } });
}

function overridden(auth: unknown, res: Response): boolean {
  if ((auth as { tenant_overridden?: boolean }).tenant_overridden === true) {
    res.status(403).json({ error: { code: "tenant_override_forbidden", message: "Not available for an overridden tenant." } });
    return true;
  }
  return false;
}

export function videoStudioHandlers(makeDeps: MakeStudioDeps = defaultMakeDeps) {
  return {
    async read(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      try {
        const q = typeof req.query?.thread_id === "string" ? req.query.thread_id : null;
        if (q !== null && !threadQuery.safeParse(q).success) {
          res.status(400).json({ error: { code: "invalid_thread", message: "That ad link is not valid. Open the ad again from Overview." } });
          return;
        }
        res.json(await readStudio(makeDeps(auth.tenant_id).store, auth.user_id, q));
      } catch (e) {
        sendError(res, e, "video_studio_read_failed");
      }
    },

    async send(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      if (overridden(auth, res)) return;
      const body = sendBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "Describe the video, or attach an image, then try again." } });
        return;
      }
      try {
        res.json(await sendStudioMessage(makeDeps(auth.tenant_id), {
            tenant_id: auth.tenant_id,
            user_id: auth.user_id,
            text: body.data.text,
            image_path: body.data.image_path ?? null,
            thread_id: body.data.thread_id ?? null,
            new_thread: body.data.new_thread === true,
            verbatim: body.data.verbatim === true,
          }));
      } catch (e) {
        sendError(res, e, "video_studio_send_failed");
      }
    },

    async script(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      if (overridden(auth, res)) return;
      const body = scriptBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "Type what the script should be about, then try again." } });
        return;
      }
      try {
        res.json(await writeStudioScript(makeDeps(auth.tenant_id), { tenant_id: auth.tenant_id, prompt: body.data.prompt }));
      } catch (e) {
        sendError(res, e, "video_studio_script_failed");
      }
    },

    async render(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      if (overridden(auth, res)) return;
      const body = renderBody.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({ error: { code: "invalid_body", message: "That ad could not be found. Open it again from Overview." } });
        return;
      }
      try {
        const out = await retryStudioRender(makeDeps(auth.tenant_id), {
          tenant_id: auth.tenant_id,
          user_id: auth.user_id,
          message_id: body.data.message_id,
          thread_id: body.data.thread_id ?? null,
        });
        res.json({ status: "rendering", run_id: out.run_id, thread_id: out.thread_id, message: out.rendering_message });
      } catch (e) {
        sendError(res, e, "video_studio_render_failed");
      }
    },

    async threads(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      try {
        res.json({ threads: await listStudioThreads(makeDeps(auth.tenant_id).store, auth.user_id) });
      } catch (e) {
        sendError(res, e, "video_studio_threads_failed");
      }
    },

    async prompt(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      try {
        const raw = typeof req.query?.after === "string" ? req.query.after : null;
        const after = raw !== null && /^\d{1,3}$/.test(raw) ? Number(raw) : null;
        res.json(await readStudioPrompt(makeDeps(auth.tenant_id), { tenant_id: auth.tenant_id, after }));
      } catch (e) {
        sendError(res, e, "video_studio_prompt_failed");
      }
    },

    async gallery(req: Request, res: Response): Promise<void> {
      const auth = await requireAuth(req, res);
      if (!auth) return;
      try {
        res.json(await readGallery(makeDeps(auth.tenant_id).store, auth.user_id, (ids) => readPostStates(auth.tenant_id, ids)));
      } catch (e) {
        sendError(res, e, "video_studio_gallery_failed");
      }
    },
  };
}

const handlers = videoStudioHandlers();
export const videoStudioRead = handlers.read;
export const videoStudioSend = handlers.send;
export const videoStudioRender = handlers.render;
export const videoStudioThreads = handlers.threads;
export const videoStudioGallery = handlers.gallery;
export const videoStudioScript = handlers.script;
export const videoStudioPrompt = handlers.prompt;
