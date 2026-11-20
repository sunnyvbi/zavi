
import { ZAVI_POSTAL_ADDRESS, webOrigin } from "../theme";

export type Rendered = { html: string; text: string; subject: string };

const INK = "#0e0f11";
const BODY = "#3d3d3d";
const MUTED = "#6b6b6b";
const LINE = "#ececec";
const EYEBROW = "#46658a";
const FONT = "'Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function oneLine(s: string, max = 80): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function firstNameOf(name: string): string {
  const t = name.trim();
  return t.split(/\s+/)[0] || t;
}

export function renderCreatorLetter(args: {
  subject: string;
  preheader: string;
  firstName: string;
  paragraphs: string[];
  button: { label: string; url: string };
  after?: string[];
  footerReason: string;
  unsubscribeUrl: string;
  siteUrl: string;
}): Rendered {
  const site = escapeHtml(args.siteUrl || webOrigin());
  const url = escapeHtml(args.button.url);
  const unsub = escapeHtml(args.unsubscribeUrl);
  const year = new Date().getFullYear();
  const p = (t: string) => `<p style="margin:0 0 16px 0;font-size:16px;line-height:1.6;color:${BODY};">${escapeHtml(t)}</p>`;

  const html = `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <title>${escapeHtml(args.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f4f5f7;-webkit-font-smoothing:antialiased;">
    <div style="display:none;font-size:1px;color:#f4f5f7;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(args.preheader)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f5f7;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
            <tr>
              <td style="padding:0 6px 16px 6px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td><a href="${site}" target="_blank" style="font-family:${FONT};font-size:26px;font-weight:800;letter-spacing:-0.03em;color:${INK};text-decoration:none;">Zavi</a></td>
                    <td align="right" style="font-family:${FONT};font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${EYEBROW};">For creators</td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;border:1px solid ${LINE};border-radius:24px;">
            <tr>
              <td style="padding:36px 40px 8px 40px;font-family:${FONT};">
                ${p(`Hi ${args.firstName},`)}
                ${args.paragraphs.map(p).join("\n                ")}
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 40px 24px 40px;font-family:${FONT};">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td bgcolor="${INK}" style="border-radius:999px;background-color:${INK};"><a href="${url}" target="_blank" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(args.button.label)}</a></td></tr></table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 40px 32px 40px;font-family:${FONT};">
                ${(args.after ?? []).map(p).join("\n                ")}
                <p style="margin:0;font-size:16px;line-height:1.6;font-weight:600;color:${INK};">Team Zavi</p>
              </td>
            </tr>
          </table>
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
            <tr>
              <td align="center" style="padding:22px 20px 0 20px;text-align:center;font-family:${FONT};font-size:12px;line-height:1.6;color:${MUTED};">
                <p style="margin:0 0 8px 0;">${escapeHtml(args.footerReason)} <a href="${unsub}" style="color:${MUTED};">Unsubscribe</a></p>
                <p style="margin:0;"><a href="${site}" style="color:${MUTED};">zaviagent.com</a> &nbsp;&middot;&nbsp; &copy; ${year} Zavi &nbsp;&middot;&nbsp; ${ZAVI_POSTAL_ADDRESS}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [
    `Hi ${args.firstName},`,
    "",
    ...args.paragraphs.flatMap((t) => [t, ""]),
    `${args.button.label}: ${args.button.url}`,
    "",
    ...(args.after ?? []).flatMap((t) => [t, ""]),
    "Team Zavi",
    "",
    "---",
    args.footerReason,
    `Unsubscribe: ${args.unsubscribeUrl}`,
    `Zavi · ${ZAVI_POSTAL_ADDRESS}`,
  ].join("\n");

  return { html, text, subject: args.subject };
}
