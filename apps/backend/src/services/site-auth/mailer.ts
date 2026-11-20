
import { createHash } from "node:crypto";
import { sgSend } from "@/email/sendAuthEmail";
import { systemSender } from "@/email/system-identity";
import { renderSiteAuthMail } from "./templates";
import type { MailRequest, ShardStore, SiteMailer, SiteRecord } from "./types";

export const SITE_MAX_PER_HOUR = 300;
export const RECIPIENT_MAX_PER_HOUR = 6;

export type SendFn = (
  to: string,
  subject: string,
  html: string,
  text: string,
  from: { email: string; name: string },
  opts?: { noTracking?: boolean },
) => Promise<void>;

export function createSiteMailer(send: SendFn = sgSend): SiteMailer {
  return {
    async send(store: ShardStore, req: MailRequest) {
      if (req.site.test === true) {
        console.warn(`[site-auth] mail suppressed for test site ${req.site.siteId} (${req.kind})`);
        return "suppressed";
      }
      const siteKey = `mail:site:${req.site.siteId}`;
      const rcptKey = `mail:rcpt:${createHash("sha256").update(`${req.site.siteId}|${req.to}`).digest("hex").slice(0, 40)}`;
      if (!(await store.rateTake(rcptKey, 3600, RECIPIENT_MAX_PER_HOUR))) return "limited";
      if (!(await store.rateTake(siteKey, 3600, SITE_MAX_PER_HOUR))) return "limited";
      const m = renderSiteAuthMail(req);
      const from = {
        email: (process.env.SITE_AUTH_FROM_EMAIL || systemSender().email).trim(),
        name: req.site.name.slice(0, 60),
      };
      await send(req.to, m.subject, m.html, m.text, from, { noTracking: true });
      return "sent";
    },
  };
}

export const NOTICE_SITE_MAX_PER_HOUR = 30;

export interface NoticeRequest {
  site: SiteRecord;
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export type NoticeSendFn = (
  to: string,
  subject: string,
  html: string,
  text: string,
  from: { email: string; name: string },
  opts?: { headers?: Record<string, string> },
) => Promise<void>;

export interface SiteNoticeMailer {
  sendNotice(store: ShardStore, req: NoticeRequest): Promise<"sent" | "limited">;
}

export function createSiteNoticeMailer(send: NoticeSendFn = sgSend): SiteNoticeMailer {
  return {
    async sendNotice(store, req) {
      if (!(await store.rateTake(`notice:site:${req.site.siteId}`, 3600, NOTICE_SITE_MAX_PER_HOUR))) return "limited";
      const from = {
        email: (process.env.SITE_AUTH_FROM_EMAIL || systemSender().email).trim(),
        name: req.site.name.slice(0, 60),
      };
      await send(req.to, req.subject.replace(/[\r\n]+/g, " "), req.html, req.text, from, req.headers ? { headers: req.headers } : undefined);
      return "sent";
    },
  };
}
