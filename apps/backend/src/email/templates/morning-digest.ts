
import { renderEmail } from "../theme";
import type {
  MorningBriefResponse,
  TopDecision,
} from "../../services/workspace/morning-brief-assembler";

function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;",
  );
}

function approveLink(approvalsBaseUrl: string, _decisionId?: string): string {
  return approvalsBaseUrl;
}

function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function cleanBriefLine(s: string): string {
  return s
    .replace(/\s*\[(observed|proposed|inferred|refine|smoke|test|qa|internal|draft)\]/gi, "")
    .replace(/\s+[—–]\s+/g, ", ")
    .replace(/[—–]/g, "-")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function needsClick(n: number): string {
  return `${pluralize(n, "thing")} ${n === 1 ? "needs" : "need"} your click`;
}

function truncateSubject(s: string): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > 64 ? `${clean.slice(0, 61)}…` : clean;
}

export function renderMorningDigestEmail(
  brief: MorningBriefResponse,
  opts: {
    workspaceUrl: string;
    approvalsUrl: string;
    displayName?: string;
    yesterdayLines?: string[];
    trendLines?: string[];
  },
): { subject: string; html: string; text: string } {
  const name = opts.displayName?.trim() || "";
  const greeting = name ? `Good morning ${name}.` : "Good morning.";
  const y = brief.yesterday;
  const t = brief.today;
  const hasApprovals = t.pending_approvals > 0;

  const cards = brief.top_decisions ?? [];
  const lead: TopDecision | undefined = cards[0];
  const olderQueued = Math.max(
    0,
    (t.pending_approvals > 0 ? t.pending_approvals : cards.length) - 1,
  );
  const olderClause =
    olderQueued > 0 ? ` (${olderQueued} more queued. Review anytime.)` : "";

  const subject = lead
    ? `Your morning brief: ${truncateSubject(lead.title)}`
    : hasApprovals
      ? `Your morning brief: ${needsClick(t.pending_approvals)}`
      : "Your morning brief from Zavi";

  const decisionHeading = olderQueued > 0
    ? "Decisions waiting on you"
    : "The one decision waiting on you";
  const introLead = lead
    ? olderQueued > 0
      ? "Here's what your AI team did, what's planned today, and the decisions waiting on your call."
      : "Here's what your AI team did, what's planned today, and the one decision waiting on you."
    : hasApprovals
      ? "Here's what your AI team did, what's planned today, and the one thing waiting on you."
      : "Here's what your AI team did and what's planned today.";

  const didParts: string[] = [];
  if (y.builds_started > 0 || y.builds_done > 0 || y.builds_failed > 0) {
    if (y.builds_done === 0 && y.builds_failed === 0 && y.builds_started > 0) {
      didParts.push(`${pluralize(y.builds_started, "build")} in progress`);
    } else {
      didParts.push(
        `${pluralize(y.builds_started, "build")} started ` +
          `(${y.builds_done} done, ${y.builds_failed} failed)`,
      );
    }
  }
  if (y.pr_count != null && y.pr_count > 0) {
    didParts.push(pluralize(y.pr_count, "pull request"));
  }

  const activityLis = brief.recent_activity
    .slice(0, 8)
    .map((a) => `<li>${esc(a.label)}</li>`)
    .join("");

  let didHtml = "";
  if (didParts.length > 0 || activityLis) {
    didHtml += `<p style="margin:0 0 8px;"><strong>What your AI team did</strong></p>`;
    if (didParts.length > 0) {
      didHtml += `<p style="margin:0 0 10px;">${esc(didParts.join(" · "))}</p>`;
    }
    if (activityLis) {
      didHtml += `<ul style="margin:0 0 18px;padding-left:20px;line-height:1.7;">${activityLis}</ul>`;
    } else {
      didHtml += `<div style="height:8px;"></div>`;
    }
  }

  const yLines = opts.yesterdayLines ?? [];
  let yesterdayHtml = "";
  if (yLines.length > 0) {
    yesterdayHtml += `<p style="margin:0 0 8px;"><strong>Yesterday</strong></p>`;
    yesterdayHtml += `<ul style="margin:0 0 18px;padding-left:20px;line-height:1.7;">`;
    yesterdayHtml += yLines.map((l) => `<li>${esc(cleanBriefLine(l))}</li>`).join("");
    yesterdayHtml += `</ul>`;
  }

  const tLines = opts.trendLines ?? [];
  let trendsHtml = "";
  if (tLines.length > 0) {
    trendsHtml += `<p style="margin:0 0 8px;"><strong>Trends</strong></p>`;
    trendsHtml += `<ul style="margin:0 0 18px;padding-left:20px;line-height:1.7;">`;
    trendsHtml += tLines.map((l) => `<li>${esc(cleanBriefLine(l))}</li>`).join("");
    trendsHtml += `</ul>`;
  }

  const todayParts: string[] = [];
  if (t.pending_approvals > 0) {
    const crit = t.critical_approvals ?? 0;
    const critClause = crit > 0 ? ` (${crit} need your attention)` : "";
    todayParts.push(
      `${pluralize(t.pending_approvals, "approval")} waiting on you${critClause}`,
    );
  }
  if (t.proposed_plans > 0) {
    todayParts.push(`${pluralize(t.proposed_plans, "plan")} proposed`);
  }
  if ((t.pending_suggestions ?? 0) > 0) {
    todayParts.push(pluralize(t.pending_suggestions ?? 0, "suggestion"));
  }

  const expiredRecent = t.expired_unread_recent ?? 0;
  const funnelHealthLine =
    expiredRecent > 0
      ? `${pluralize(expiredRecent, "decision")} expired unactioned recently. Your approval queue is filling faster than it is being cleared.`
      : "";

  let todayHtml = "";
  if (todayParts.length > 0) {
    todayHtml += `<p style="margin:0 0 8px;"><strong>Today's plan</strong></p>`;
    todayHtml += `<ul style="margin:0 0 18px;padding-left:20px;line-height:1.7;">`;
    todayHtml += todayParts.map((p) => `<li>${esc(p)}</li>`).join("");
    todayHtml += `</ul>`;
  }
  if (funnelHealthLine) {
    todayHtml += `<p style="margin:0 0 18px;font-size:12px;color:#9a5b2e;">${esc(funnelHealthLine)}</p>`;
  }

  let goalsHtml = "";
  if (brief.goals.length > 0) {
    goalsHtml += `<p style="margin:0 0 8px;"><strong>Goal progress</strong></p>`;
    goalsHtml += `<ul style="margin:0 0 18px;padding-left:20px;line-height:1.7;">`;
    for (const g of brief.goals.slice(0, 5)) {
      const progress =
        g.current_value == null || g.target_value == null
          ? "not enough data yet"
          : `${String(g.current_value)}/${String(g.target_value)}`;
      goalsHtml +=
        `<li>${esc(g.objective)}: ${esc(g.target_metric)} ` +
        `${esc(progress)} <span style="color:#6b6b6b;">(${esc(g.status)})</span></li>`;
    }
    goalsHtml += `</ul>`;
  }

  function decisionCardHtml(d: TopDecision, primary: boolean): string {
    const link = approveLink(opts.approvalsUrl, d.id);
    const border = d.is_critical
      ? "2px solid #c0392b"
      : primary
        ? "2px solid #d5d8dd"
        : "1px solid #ececec";
    let inner = "";
    if (d.is_critical) {
      const age =
        typeof d.age_days === "number" && d.age_days >= 1
          ? ` · open ${d.age_days} ${d.age_days === 1 ? "day" : "days"}`
          : "";
      inner += `<p style="margin:0 0 6px;font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;color:#c0392b;">Needs your attention${esc(age)}</p>`;
    }
    inner += `<p style="margin:0 0 6px;font-weight:600;">${esc(d.title)}</p>`;
    if (d.recommendation) {
      inner += `<p style="margin:0 0 6px;font-size:13px;color:#3d3d3d;">${esc(d.recommendation)}</p>`;
    }
    const meta: string[] = [];
    if (d.impact) meta.push(`Impact: ${esc(d.impact)}`);
    if (d.risk) meta.push(`Risk: ${esc(d.risk)}`);
    if (meta.length > 0) {
      inner += `<p style="margin:0 0 8px;font-size:12px;color:#6b6b6b;">${meta.join(" · ")}</p>`;
    }
    inner += `<a href="${esc(link)}" style="display:inline-block;font-size:13px;font-weight:600;color:#0e0f11;text-decoration:underline;">Approve →</a>`;
    return `<div style="border:${border};border-radius:8px;padding:12px 14px;margin:0 0 12px;">${inner}</div>`;
  }

  let leadHtml = "";
  let ctaText: string;
  let ctaUrl: string;
  if (lead) {
    leadHtml += `<p style="margin:0 0 8px;"><strong>${esc(decisionHeading)}</strong></p>`;
    leadHtml += decisionCardHtml(lead, true);
    const rest = cards.slice(1);
    if (rest.length > 0) {
      leadHtml += rest.map((d) => decisionCardHtml(d, false)).join("");
    }
    if (olderQueued > rest.length) {
      const tail = olderQueued - rest.length;
      leadHtml += `<p style="margin:0 0 12px;font-size:12px;color:#6b6b6b;">+${tail} more queued. Review anytime.</p>`;
    }
    ctaText = "Approve this decision";
    ctaUrl = approveLink(opts.approvalsUrl, lead.id);
  } else if (hasApprovals) {
    leadHtml =
      `<p style="margin:0 0 4px;"><strong>A decision is waiting on you${esc(olderClause)}</strong></p>` +
      `<p style="margin:0 0 8px;">Open your workspace to review and approve.</p>`;
    ctaText = "Review and approve";
    ctaUrl = opts.approvalsUrl;
  } else {
    leadHtml = `<p style="margin:0 0 8px;">Nothing is blocked on you right now. Open your workspace whenever you want the full picture.</p>`;
    ctaText = "Review in your workspace";
    ctaUrl = opts.workspaceUrl;
  }

  let growthFocusHtml = "";
  if (brief.growth_do_this_first) {
    growthFocusHtml += `<p style="margin:0 0 8px;"><strong>Do this first</strong></p>`;
    growthFocusHtml += `<p style="margin:0 0 18px;">${esc(brief.growth_do_this_first)}</p>`;
  }

  const body = `
    ${leadHtml}
    ${growthFocusHtml}
    ${didHtml}
    ${yesterdayHtml}
    ${trendsHtml}
    ${todayHtml}
    ${goalsHtml}
  `;

  const html = renderEmail({
    preheader: lead
      ? `${truncateSubject(lead.title)}. Here's what your AI team did and what's planned today.`
      : hasApprovals
        ? "A decision is waiting on you. Here's what your AI team did and what's planned today."
        : "Here's what your AI team did and what's planned today.",
    kicker: "Daily brief",
    eyebrow: "Good morning",
    title:
      lead || hasApprovals
        ? "Your AI team needs <em>your call</em>"
        : "Here's your <em>morning brief</em>",
    intro: `${esc(greeting)} ${introLead}`,
    ctaText,
    ctaUrl,
    body,
    footerNote:
      "You're getting this because daily brief emails are on for your workspace. You can turn them off in your settings any time.",
    footerVariant: "founder-growth",
  });

  const textLines: string[] = [];
  textLines.push(greeting);
  textLines.push("");
  if (lead) {
    const critPrefix = (d: TopDecision): string => {
      if (!d.is_critical) return "";
      const age =
        typeof d.age_days === "number" && d.age_days >= 1 ? ` · open ${d.age_days}d` : "";
      return `[Needs your attention${age}] `;
    };
    textLines.push(`${decisionHeading}:`);
    textLines.push(`  ${critPrefix(lead)}${lead.title}`);
    if (lead.recommendation) textLines.push(`    ${lead.recommendation}`);
    const metaT: string[] = [];
    if (lead.impact) metaT.push(`Impact: ${lead.impact}`);
    if (lead.risk) metaT.push(`Risk: ${lead.risk}`);
    if (metaT.length > 0) textLines.push(`    ${metaT.join(" · ")}`);
    textLines.push(`    Approve: ${approveLink(opts.approvalsUrl, lead.id)}`);
    const rest = cards.slice(1);
    for (const d of rest) {
      textLines.push(`  ${critPrefix(d)}${d.title}`);
      textLines.push(`    Approve: ${approveLink(opts.approvalsUrl, d.id)}`);
    }
    if (olderQueued > rest.length) {
      textLines.push(`  +${olderQueued - rest.length} more queued. Review anytime.`);
    }
    textLines.push("");
  } else if (hasApprovals) {
    textLines.push(
      `A decision is waiting on you${olderClause}. Open your workspace to review and approve.`,
    );
    textLines.push("");
  }
  if (brief.growth_do_this_first) {
    textLines.push("Do this first:");
    textLines.push(`  ${brief.growth_do_this_first}`);
    textLines.push("");
  }
  if (didParts.length > 0 || brief.recent_activity.length > 0) {
    textLines.push("What your AI team did:");
    if (didParts.length > 0) textLines.push(`  ${didParts.join(" · ")}`);
    for (const a of brief.recent_activity.slice(0, 8)) {
      textLines.push(`  - ${a.label}`);
    }
    textLines.push("");
  }
  if (yLines.length > 0) {
    textLines.push("Yesterday:");
    for (const l of yLines) textLines.push(`  - ${cleanBriefLine(l)}`);
    textLines.push("");
  }
  if (tLines.length > 0) {
    textLines.push("Trends:");
    for (const l of tLines) textLines.push(`  - ${cleanBriefLine(l)}`);
    textLines.push("");
  }
  if (todayParts.length > 0) {
    textLines.push("Today's plan:");
    for (const p of todayParts) textLines.push(`  - ${p}`);
    if (funnelHealthLine) textLines.push(`  ${funnelHealthLine}`);
    textLines.push("");
  }
  if (brief.goals.length > 0) {
    textLines.push("Goal progress:");
    for (const g of brief.goals.slice(0, 5)) {
      const progress =
        g.current_value == null || g.target_value == null
          ? "not enough data yet"
          : `${String(g.current_value)}/${String(g.target_value)}`;
      textLines.push(`  - ${g.objective}: ${g.target_metric} ${progress} (${g.status})`);
    }
    textLines.push("");
  }
  textLines.push(`${ctaText}: ${ctaUrl}`);
  textLines.push("");
  textLines.push("Zavi · zaviagent.com");

  const text = textLines.join("\n");

  return { subject, html, text };
}
