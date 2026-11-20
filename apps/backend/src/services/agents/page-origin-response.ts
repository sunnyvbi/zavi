
import type { Response } from "express";
import { stampThreadChannelOrigin, type PageOrigin } from "@/services/agents/thread-channel-origin";

export const PAGE_ORIGIN_STAMP_DEADLINE_MS = 2_000;

export type PageOriginContext = PageOrigin & { tenantId: string; userId: string };

export function holdResponseForPageOrigin(res: Response): {
  res: Response;
  setOrigin: (ctx: PageOriginContext) => void;
  release: () => Promise<void>;
} {
  let origin: PageOriginContext | null = null;
  let status = 200;
  let held: { status: number; body: unknown } | null = null;

  const proxy = new Proxy(res, {
    get(target, prop) {
      if (prop === "status") {
        return (code: number) => {
          status = code;
          if (!origin || code < 200 || code >= 300) target.status(code);
          return proxy;
        };
      }
      if (prop === "json") {
        return (body: unknown) => {
          if (origin && status >= 200 && status < 300 && !held) {
            held = { status, body };
          } else {
            target.json(body);
          }
          return proxy;
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  return {
    res: proxy,
    setOrigin(ctx) {
      origin = ctx;
    },
    async release() {
      if (!held) return;
      const { status: code, body } = held;
      held = null;
      const threadId = (body as { thread_id?: unknown } | null)?.thread_id;
      if (origin && typeof threadId === "string") {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const outcome = await Promise.race([
            stampThreadChannelOrigin({ ...origin, threadId }).then(() => "done" as const),
            new Promise<"timeout">((resolve) => {
              timer = setTimeout(() => resolve("timeout"), PAGE_ORIGIN_STAMP_DEADLINE_MS);
            }),
          ]);
          if (outcome === "timeout") {
            console.warn(
              `[chat-send] page origin stamp timed out (thread=${threadId}); answering unstamped`,
            );
          }
        } catch (e) {
          console.warn(`[chat-send] page origin stamp threw (thread=${threadId}): ${(e as Error).message}`);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      res.status(code).json(body);
    },
  };
}
