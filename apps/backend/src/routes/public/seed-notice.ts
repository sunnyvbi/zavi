import type { Request, Response } from "express";
import { unsubscribeByKey } from "@/services/start-card/seed/notice-store";
import { resetLeaderboardCache } from "@/services/start-card/leaderboard";

export const NOTICE_KEY_RE = /^seed-notice-[0-9a-f-]{20,64}$/;

const page = (title: string, body: string, form?: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:480px;margin:64px auto;padding:0 16px;color:#1f1f1f">
<h1 style="font-size:24px">${title}</h1>
<p>${body}</p>${form ?? ""}
</body></html>`;

function keyOf(req: Request): string {
  const q = typeof req.query.k === "string" ? req.query.k : "";
  const b = (req.body as { k?: unknown } | undefined)?.k;
  return q || (typeof b === "string" ? b : "");
}

export async function seedNoticeUnsubscribePage(req: Request, res: Response): Promise<void> {
  const k = keyOf(req);
  res.set("Cache-Control", "no-store").type("html");
  if (!NOTICE_KEY_RE.test(k)) {
    res.status(404).send(page("This link is not valid", "Write to support@zaviagent.com and we will remove your site."));
    return;
  }
  res.status(200).send(
    page(
      "Remove my site from Zavi",
      "This takes your site's growth card off Zavi's public leaderboard and its link, and we will not email you about it again.",
      `<form method="post" action="/api/public/seed-notice/unsubscribe?k=${k}"><button type="submit" style="min-height:48px;padding:0 20px;border:0;border-radius:12px;background:#027bff;color:#fff;font-size:15px;font-weight:600">Remove my site</button></form>`,
    ),
  );
}

export async function seedNoticeUnsubscribe(req: Request, res: Response): Promise<void> {
  const k = keyOf(req);
  res.set("Cache-Control", "no-store").type("html");
  if (!NOTICE_KEY_RE.test(k)) {
    res.status(404).send(page("This link is not valid", "Write to support@zaviagent.com and we will remove your site."));
    return;
  }
  try {
    const out = await unsubscribeByKey(k);
    if (out !== "removed") {
      res.status(404).send(page("This link is not valid", "Write to support@zaviagent.com and we will remove your site."));
      return;
    }
    resetLeaderboardCache();
    res.status(200).send(page("Your site is removed", "It is off Zavi's leaderboard, its card link no longer shows it, and we will not email you about it again."));
  } catch (e) {
    console.error(`[seed-notice] unsubscribe failed: ${(e as Error).message?.slice(0, 200)}`);
    res.status(503).send(page("Something went wrong", "Please try again in a minute, or write to support@zaviagent.com and we will remove your site."));
  }
}
