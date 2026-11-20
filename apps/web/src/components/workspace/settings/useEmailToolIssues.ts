"use client";

import { useEffect, useState } from "react";
import { getEmailTestLists } from "@/lib/workspace/emailCampaignSettingsApi";
import { toolIssues, type ToolIssue } from "../email/EmailConnectTiles";

export type EmailToolIssue = Exclude<ToolIssue, "permissions">;

const NONE: ReadonlyMap<string, EmailToolIssue> = new Map();

export const KEY_TOOLS: ReadonlySet<string> = new Set(["sendgrid", "klaviyo", "mailchimp"]);

export function emailToolIssues(view: Parameters<typeof toolIssues>[0]): ReadonlyMap<string, EmailToolIssue> {
  const out = new Map<string, EmailToolIssue>();
  for (const [tool, issue] of toolIssues(view)) if (KEY_TOOLS.has(tool) && issue !== "permissions") out.set(tool, issue);
  return out;
}

export function useEmailToolIssues(
  enabled: boolean,
  reloadKey = 0,
): { issues: ReadonlyMap<string, EmailToolIssue>; checking: boolean; failed: boolean } {
  const [issues, setIssues] = useState<ReadonlyMap<string, EmailToolIssue> | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!enabled) {
      setIssues(null);
      return;
    }
    let live = true;
    setIssues(null);
    getEmailTestLists({ fresh: reloadKey > 0 }).then(
      (view) => {
        if (live) setIssues(emailToolIssues(view));
      },
      () => {
        if (!live) return;
        setIssues(NONE);
        setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [enabled, reloadKey]);
  return { issues: issues ?? NONE, checking: enabled && issues === null, failed: enabled && failed };
}

export const EMAIL_TOOL_ISSUE_STATUS: Record<EmailToolIssue, string> = { rejected: "Key rejected", unreadable: "Can't reach" };

export function emailToolIssueReason(issue: EmailToolIssue, label: string): string {
  return issue === "rejected"
    ? `${label} rejected the key Zavi has saved, so email campaigns can't send through it. Reconnect with a new key. Emails drafted before you reconnect will not send, even approved or scheduled ones: ask Zavi to draft them again.`
    : `Zavi can't reach ${label} right now, so email campaigns can't use it. Reconnect if this keeps happening.`;
}
