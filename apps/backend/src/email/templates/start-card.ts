
import { START_CARD_CHECK_KEYS, type StartCardDiagnosisEvidence, type StartCardScore } from "@zavi/shared";
import { scoresOf } from "@/services/start-card/site-check-result";
import { EMAIL_FONT, EMAIL_PALETTE, ZAVI_POSTAL_ADDRESS, escapeEmailHtml, oneLineName, renderEmail, renderEmailFooter, webOrigin } from "../theme";

export function renderStartCardConfirmEmail(args: {
  domain: string;
  confirmUrl: string;
}): { html: string; text: string; subject: string } {
  const domain = escapeEmailHtml(args.domain);
  const url = escapeEmailHtml(args.confirmUrl);
  const subject = `Confirm your email to get the growth card for ${args.domain}`;

  const html = renderEmail({
    preheader: `One click and we'll send the card for ${args.domain} as soon as it's ready.`,
    kicker: "Growth card",
    eyebrow: "Confirm your email",
    title: "One click to get your <em>card</em>",
    intro: `You asked for the growth card for ${domain}. Confirm this address and we'll email it as soon as it's ready, usually within a day.`,
    ctaText: "Confirm and send my card",
    ctaUrl: args.confirmUrl,
    linkFallback: true,
    body: `
      <p>Didn't ask for this? Ignore this email and nothing will be sent. We delete this address after the card goes out, or after 7 days if it never does.</p>
    `,
    footerNote: "This link works once and expires in 7 days.",
    footerVariant: "neutral",
  });

  const text = [
    `You asked for the growth card for ${args.domain}.`,
    "",
    "Confirm this address and we'll email the card as soon as it's ready:",
    args.confirmUrl,
    "",
    "Didn't ask for this? Ignore this email and nothing will be sent.",
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}

export type StartCardReadyCard = {
  score: StartCardScore | null;
  diagnosis: StartCardDiagnosisEvidence | null;
  companyName?: string | null;
};

export function scoreHeadline(score: StartCardScore): string {
  const pct = score.out_of > 0 ? score.total / score.out_of : 0;
  if (pct >= 0.7) return "A strong base to build on";
  if (pct >= 0.4) return "Good bones, clear gaps";
  return "A clear place to start";
}

const BLUE = "#3b82f6";
const TRACK = "#e9edf3";
const SOFT_BOX = "#f4f6fa";
const FONT_LINK = "https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap";

export function ringSides(score: StartCardScore): [string, string, string, string] {
  const pct = score.out_of > 0 ? Math.max(0, Math.min(1, score.total / score.out_of)) : 0;
  const filled = pct === 0 ? 0 : Math.max(1, Math.round(pct * 4));
  return [0, 1, 2, 3].map((i) => (i < filled ? BLUE : TRACK)) as [string, string, string, string];
}

function scoreRing(score: StartCardScore): string {
  const [top, right, bottom, left] = ringSides(score);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td align="center" valign="middle" width="96" height="96" style="width:96px;height:96px;border-radius:50%;border-style:solid;border-width:10px;border-color:${top} ${right} ${bottom} ${left};text-align:center;">
      <div style="font-family:${EMAIL_FONT};font-size:34px;line-height:1;font-weight:800;color:${EMAIL_PALETTE.ink};">${score.total}</div>
      <div style="margin-top:6px;font-family:${EMAIL_FONT};font-size:13px;color:${EMAIL_PALETTE.muted};">/${score.out_of}</div>
    </td>
  </tr></table>`;
}

function snapshotRows(score: StartCardScore): string {
  return scoresOf(score)
    .map((s) => {
      const label = escapeEmailHtml(s.label);
      const labelCell = `<td style="padding:10px 12px 10px 0;font-family:${EMAIL_FONT};font-size:15px;color:${EMAIL_PALETTE.ink};width:38%;">${label}</td>`;
      if (s.points === null) {
        return `<tr>${labelCell}<td colspan="2" style="padding:10px 0;font-family:${EMAIL_FONT};font-size:14px;color:${EMAIL_PALETTE.muted};">Not measured</td></tr>`;
      }
      const pct = Math.max(0, Math.min(100, Math.round((s.points / s.max) * 100)));
      const fill = pct > 0 ? `<td width="${pct}%" bgcolor="${BLUE}" style="background-color:${BLUE};height:8px;font-size:0;line-height:8px;border-radius:4px;">&nbsp;</td>` : "";
      const track = pct < 100 ? `<td bgcolor="${TRACK}" style="background-color:${TRACK};height:8px;font-size:0;line-height:8px;border-radius:4px;">&nbsp;</td>` : "";
      return `<tr>${labelCell}
        <td style="padding:10px 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;background-color:${TRACK};border-radius:4px;"><tr>${fill}${track}</tr></table>
        </td>
        <td align="right" style="padding:10px 0 10px 16px;font-family:${EMAIL_FONT};font-size:15px;font-weight:700;color:${EMAIL_PALETTE.ink};white-space:nowrap;width:52px;">${s.points}/${s.max}</td>
      </tr>`;
    })
    .join("");
}

function calloutBox(eyebrow: string, title: string, why?: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 14px 0;">
    <tr><td bgcolor="${SOFT_BOX}" style="padding:20px 22px;background-color:${SOFT_BOX};border-radius:16px;font-family:${EMAIL_FONT};">
      <p style="margin:0 0 8px 0;font-size:11px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;color:${EMAIL_PALETTE.muted};">${eyebrow}</p>
      <p style="margin:0;font-size:18px;font-weight:700;line-height:1.35;color:${EMAIL_PALETTE.ink};">${escapeEmailHtml(title)}</p>
      ${why ? `<p style="margin:8px 0 0 0;font-size:15px;line-height:1.5;color:${EMAIL_PALETTE.muted};">${escapeEmailHtml(why)}</p>` : ""}
    </td></tr>
  </table>`;
}

function measuredLines(score: StartCardScore): string {
  const measured = scoresOf(score).filter((s) => s.points !== null).length;
  const unmeasured = START_CARD_CHECK_KEYS.length - measured;
  const first = `${measured} of ${START_CARD_CHECK_KEYS.length} checks measured.`;
  if (unmeasured === 0) return first;
  return `${first}<br>${unmeasured === 1 ? "One check" : `${unmeasured} checks`} could not be measured.`;
}

function scoreCard(score: StartCardScore, diagnosis: StartCardDiagnosisEvidence | null, mascotSrc: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 24px 0;"><tr>
      <td width="116" valign="middle" style="width:116px;padding:0 16px 0 0;">${scoreRing(score)}</td>
      <td valign="middle" style="font-family:${EMAIL_FONT};">
        <p style="margin:0 0 6px 0;font-size:20px;font-weight:800;letter-spacing:-0.01em;color:${EMAIL_PALETTE.ink};">${scoreHeadline(score)}</p>
        <p style="margin:0;font-size:14px;line-height:1.6;color:${EMAIL_PALETTE.muted};">${measuredLines(score)}</p>
      </td>
      <td width="104" valign="middle" align="right" class="sc-mascot" style="width:104px;">
        <img src="${escapeEmailHtml(mascotSrc)}" alt="" width="104" height="104" style="display:block;width:104px;height:104px;border:0;outline:none;text-decoration:none;">
      </td>
    </tr></table>
    <p style="margin:0 0 10px 0;padding:0 0 12px 0;border-bottom:1px solid ${EMAIL_PALETTE.rule};font-family:${EMAIL_FONT};font-size:18px;font-weight:800;color:${EMAIL_PALETTE.ink};">Your growth snapshot</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px 0;">${snapshotRows(score)}</table>
    ${diagnosis ? calloutBox("What needs attention", diagnosis.constraint.title) : ""}
    ${diagnosis ? calloutBox("Your next step", diagnosis.action_this_week.title, diagnosis.action_this_week.why) : ""}`;
}

function pillButton(text: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:24px auto 0 auto;"><tr>
    <td align="center" bgcolor="${EMAIL_PALETTE.ink}" style="background-color:${EMAIL_PALETTE.ink};border-radius:999px;">
      <a href="${escapeEmailHtml(url)}" target="_blank" style="display:inline-block;padding:16px 40px;font-family:${EMAIL_FONT};font-size:16px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeEmailHtml(text)} &rarr;</a>
    </td>
  </tr></table>`;
}

export function renderStartCardReadyEmail(args: {
  domain: string;
  strategyUrl: string;
  card?: StartCardReadyCard;
}): { html: string; text: string; subject: string } {
  const domain = escapeEmailHtml(args.domain);
  const score = args.card?.score ?? null;
  const diagnosis = args.card?.diagnosis ?? null;
  const company = oneLineName(args.card?.companyName ?? "");
  const site = webOrigin();
  const subject = score
    ? `Your growth scorecard for ${args.domain}: ${score.total}/${score.out_of}`
    : `Your growth scorecard for ${args.domain} is ready`;
  const preheader = score
    ? `${args.domain} scored ${score.total}/${score.out_of}. Your key findings and next step are inside.`
    : `Your score, your #1 growth problem and one thing to do this week for ${args.domain}.`;
  const who = company && company.toLowerCase() !== args.domain.toLowerCase() ? `${escapeEmailHtml(company)} &middot; ${domain}` : domain;
  const cta = "Open Zavi";

  const inner = score
    ? scoreCard(score, diagnosis, `${site}/email/scorecard/zavi-mascot.png`)
    : `<p style="margin:0;font-family:${EMAIL_FONT};font-size:16px;line-height:1.6;color:${EMAIL_PALETTE.body};">It has your score, the #1 thing holding your growth back, and one action for this week.</p>`;

  const html = `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>Your growth scorecard is ready.</title>
    <link href="${FONT_LINK}" rel="stylesheet">
    <style>
      @media only screen and (max-width: 640px) {
        .email-wrapper { padding: 20px 8px !important; }
        .email-container { width: 100% !important; max-width: 100% !important; }
        .sc-card { padding: 24px 18px !important; }
        .sc-title { font-size: 26px !important; }
        .sc-mascot { display: none !important; }
      }
    </style>
  </head>
  <body style="background-color:${EMAIL_PALETTE.ground};margin:0;padding:0;-webkit-font-smoothing:antialiased;">
    <div style="display:none;font-size:1px;color:${EMAIL_PALETTE.ground};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeEmailHtml(preheader)}</div>
    <table role="presentation" class="email-wrapper" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background-color:${EMAIL_PALETTE.ground};">
      <tr><td align="center">
        <table role="presentation" class="email-container" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">
          <tr><td align="center" style="padding:0 8px 24px 8px;text-align:center;font-family:${EMAIL_FONT};">
            <a href="${site}" target="_blank" style="font-family:${EMAIL_FONT};font-size:30px;font-weight:800;letter-spacing:-0.03em;color:${EMAIL_PALETTE.ink};text-decoration:none;">zavi</a>
            <h1 class="sc-title" style="margin:20px 0 0 0;font-family:${EMAIL_FONT};font-size:32px;line-height:1.15;font-weight:800;letter-spacing:-0.03em;color:${EMAIL_PALETTE.ink};">Your growth scorecard is ready.</h1>
            <p style="margin:14px 0 0 0;font-family:${EMAIL_FONT};font-size:16px;font-weight:700;color:${EMAIL_PALETTE.ink};">${who}</p>
            <p style="margin:10px 0 0 0;font-family:${EMAIL_FONT};font-size:15px;line-height:1.5;color:${EMAIL_PALETTE.muted};">See where your business stands and what to work on next.</p>
          </td></tr>
        </table>
        <table role="presentation" class="email-container" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background-color:${EMAIL_PALETTE.card};border:1px solid ${EMAIL_PALETTE.rule};border-radius:24px;">
          <tr><td class="sc-card" style="padding:32px 32px 28px 32px;">
            ${inner}
            ${pillButton(cta, args.strategyUrl)}
            <p style="margin:12px 0 0 0;text-align:center;font-family:${EMAIL_FONT};font-size:13px;color:${EMAIL_PALETTE.muted};">Your growth plan shows up there as soon as Zavi has written it.</p>
          </td></tr>
        </table>
        ${renderEmailFooter({ footerVariant: "neutral", siteUrl: site, note: "You received this email because you requested a growth scorecard from Zavi." })}
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    "Your growth scorecard is ready.",
    company && company.toLowerCase() !== args.domain.toLowerCase() ? `${company} · ${args.domain}` : args.domain,
    "",
    ...(score
      ? [
          `${score.total}/${score.out_of}: ${scoreHeadline(score)}`,
          "",
          "Your growth snapshot",
          ...scoresOf(score).map((s) => `- ${s.label}: ${s.points === null ? "not measured" : `${s.points}/${s.max}`}`),
        ]
      : ["It has your score, the #1 thing holding your growth back, and one action for this week."]),
    ...(diagnosis
      ? [
          "",
          `What needs attention: ${diagnosis.constraint.title}`,
          `Your next step: ${diagnosis.action_this_week.title}`,
          diagnosis.action_this_week.why,
        ]
      : []),
    "",
    `${cta}: ${args.strategyUrl}`,
    "",
    "You received this email because you requested a growth scorecard from Zavi.",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}

export function renderStartCardRemoveEmail(args: {
  domain: string;
  removeUrl: string;
}): { html: string; text: string; subject: string } {
  const domain = escapeEmailHtml(args.domain);
  const url = escapeEmailHtml(args.removeUrl);
  const subject = `Remove the growth check for ${args.domain}`;

  const html = renderEmail({
    preheader: `One click removes the public growth check for ${args.domain}.`,
    kicker: "Growth card",
    eyebrow: "Remove this result",
    title: "One click to <em>remove</em> it",
    intro: `Someone using this address asked us to remove the public growth check for ${domain}. Click below and the result link stops showing it straight away.`,
    ctaText: "Remove the result",
    ctaUrl: args.removeUrl,
    linkFallback: true,
    body: `
      <p>Didn't ask for this? Ignore this email and nothing changes.</p>
    `,
    footerNote: "This link works once and expires in 7 days.",
    footerVariant: "neutral",
  });

  const text = [
    `Someone using this address asked us to remove the public growth check for ${args.domain}.`,
    "",
    "Open this link to remove it straight away:",
    args.removeUrl,
    "",
    "Didn't ask for this? Ignore this email and nothing changes.",
    "",
    "Zavi · zaviagent.com",
  ].join("\n");

  return { html, text, subject };
}

export function renderSeedNoticeEmail(args: {
  domain: string;
  cardUrl: string;
  oneClickUrl: string;
  removeUrl?: string;
  source: "yc" | "product_hunt" | null;
  card: StartCardReadyCard;
}): { html: string; text: string; subject: string } {
  const domain = escapeEmailHtml(args.domain);
  const score = args.card.score ?? null;
  const diagnosis = args.card.diagnosis ?? null;
  const company = oneLineName(args.card.companyName ?? "");
  const site = webOrigin();
  const where = args.source === "yc" ? "the Y Combinator company directory" : args.source === "product_hunt" ? "Product Hunt" : "a public startup directory";
  const subject = score
    ? `${args.domain} scored ${score.total}/${score.out_of} on Zavi's growth check`
    : `We ran a growth check on ${args.domain}`;
  const preheader = `A free growth check of ${args.domain}: Google, AI answers, SEO, design and competitors. This is the only email we will send.`;
  const who = company && company.toLowerCase() !== args.domain.toLowerCase() ? `${escapeEmailHtml(company)} &middot; ${domain}` : domain;
  const removeUrl = escapeEmailHtml(args.oneClickUrl);
  const p = (s: string) => `<p style="margin:0 0 12px 0;font-family:${EMAIL_FONT};font-size:15px;line-height:1.6;color:${EMAIL_PALETTE.body};">${s}</p>`;

  const inner = score
    ? scoreCard(score, diagnosis, `${site}/email/scorecard/zavi-mascot.png`)
    : p("It covers how the site shows up on Google and in AI answers, its SEO, how it looks on a phone, and how it compares with competitors.");

  const html = `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>We ran a growth check on your site.</title>
    <link href="${FONT_LINK}" rel="stylesheet">
    <style>
      @media only screen and (max-width: 640px) {
        .email-wrapper { padding: 20px 8px !important; }
        .email-container { width: 100% !important; max-width: 100% !important; }
        .sc-card { padding: 24px 18px !important; }
        .sc-title { font-size: 26px !important; }
        .sc-mascot { display: none !important; }
      }
    </style>
  </head>
  <body style="background-color:${EMAIL_PALETTE.ground};margin:0;padding:0;-webkit-font-smoothing:antialiased;">
    <div style="display:none;font-size:1px;color:${EMAIL_PALETTE.ground};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeEmailHtml(preheader)}</div>
    <table role="presentation" class="email-wrapper" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px;background-color:${EMAIL_PALETTE.ground};">
      <tr><td align="center">
        <table role="presentation" class="email-container" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;">
          <tr><td align="center" style="padding:0 8px 24px 8px;text-align:center;font-family:${EMAIL_FONT};">
            <a href="${site}" target="_blank" style="font-family:${EMAIL_FONT};font-size:30px;font-weight:800;letter-spacing:-0.03em;color:${EMAIL_PALETTE.ink};text-decoration:none;">zavi</a>
            <h1 class="sc-title" style="margin:20px 0 0 0;font-family:${EMAIL_FONT};font-size:32px;line-height:1.15;font-weight:800;letter-spacing:-0.03em;color:${EMAIL_PALETTE.ink};">We ran a growth check on your site.</h1>
            <p style="margin:14px 0 0 0;font-family:${EMAIL_FONT};font-size:16px;font-weight:700;color:${EMAIL_PALETTE.ink};">${who}</p>
            <p style="margin:10px 0 0 0;font-family:${EMAIL_FONT};font-size:15px;line-height:1.5;color:${EMAIL_PALETTE.muted};">A one-time notice from Zavi, an AI growth product. We checked ${domain} for free, from public information, after finding it in ${escapeEmailHtml(where)}.</p>
          </td></tr>
        </table>
        <table role="presentation" class="email-container" width="580" cellpadding="0" cellspacing="0" style="max-width:580px;width:100%;background-color:${EMAIL_PALETTE.card};border:1px solid ${EMAIL_PALETTE.rule};border-radius:24px;">
          <tr><td class="sc-card" style="padding:32px 32px 28px 32px;">
            ${inner}
            ${pillButton("See the full growth card", args.cardUrl)}
            <p style="margin:20px 0 0 0;text-align:center;font-family:${EMAIL_FONT};font-size:14px;line-height:1.6;color:${EMAIL_PALETTE.muted};">This result is listed on Zavi's public growth leaderboard. Don't want it there? <a href="${removeUrl}" style="color:${EMAIL_PALETTE.ink};text-decoration:underline;">Remove my site</a></p>
          </td></tr>
        </table>
        ${renderEmailFooter({ footerVariant: "neutral", siteUrl: site, unsubscribeUrl: args.oneClickUrl, note: `This is the only email we will send about ${domain}.` })}
      </td></tr>
    </table>
  </body>
</html>`;

  const text = [
    "We ran a growth check on your site.",
    company && company.toLowerCase() !== args.domain.toLowerCase() ? `${company} · ${args.domain}` : args.domain,
    `A one-time notice from Zavi, an AI growth product. We checked ${args.domain} for free, from public information, after finding it in ${where}.`,
    "",
    ...(score
      ? [
          `${score.total}/${score.out_of}: ${scoreHeadline(score)}`,
          "",
          ...scoresOf(score).map((s) => `- ${s.label}: ${s.points === null ? "not measured" : `${s.points}/${s.max}`}`),
        ]
      : []),
    ...(diagnosis ? ["", `What needs attention: ${diagnosis.constraint.title}`, `Your next step: ${diagnosis.action_this_week.title}`] : []),
    "",
    `See the full growth card: ${args.cardUrl}`,
    "",
    "This result is listed on Zavi's public growth leaderboard.",
    `Don't want it there? Remove my site (one click): ${args.oneClickUrl}`,
    "",
    `This is the only email we will send about ${args.domain}.`,
    `Zavi · zaviagent.com · ${ZAVI_POSTAL_ADDRESS}`,
  ].join("\n");

  return { html, text, subject };
}
