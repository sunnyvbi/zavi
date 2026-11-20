"use client";

import { useCallback, useState } from "react";
import { apiFetch } from "@/lib/api";

export type InviteRole = "admin" | "member" | "viewer";
export const INVITE_ROLES: InviteRole[] = ["admin", "member", "viewer"];

export type InviteErrorCode =
  | "user_already_exists"
  | "seat_cap_exceeded"
  | "forbidden"
  | "invalid_email"
  | "network"
  | "unknown";

export type InviteStatus =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; code: InviteErrorCode; message: string };

const FIELD_ERROR_CODES: InviteErrorCode[] = ["user_already_exists", "invalid_email"];
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidInviteEmail(email: string): boolean {
  return EMAIL_RE.test(normalizeInviteEmail(email));
}

export function useInviteMember() {
  const [status, setStatus] = useState<InviteStatus>({ kind: "idle" });

  const reset = useCallback(() => setStatus({ kind: "idle" }), []);
  const clearFieldError = useCallback(
    () =>
      setStatus((current) =>
        current.kind === "error" && FIELD_ERROR_CODES.includes(current.code) ? { kind: "idle" } : current,
      ),
    [],
  );

  const invite = useCallback(
    async (email: string, role: InviteRole): Promise<string | null> => {
      const trimmed = normalizeInviteEmail(email);
      if (!isValidInviteEmail(trimmed)) {
        setStatus({
          kind: "error",
          code: "invalid_email",
          message: "Enter a valid email address.",
        });
        return null;
      }
      setStatus({ kind: "submitting" });
      try {
        const res = await apiFetch("/api/v1/members/invite", {
          method: "POST",
          body: JSON.stringify({ email: trimmed, role }),
          idempotent: true,
        });
        if (res.ok) {
          setStatus({ kind: "idle" });
          return trimmed;
        }
        const parsed = (await res.json().catch(() => null)) as {
          error?: { code?: string; message?: string };
        } | null;
        const code = mapInviteErrorCode(res.status, parsed?.error?.code);
        setStatus({
          kind: "error",
          code,
          message: parsed?.error?.message ?? defaultInviteErrorMessage(code),
        });
        return null;
      } catch {
        setStatus({
          kind: "error",
          code: "network",
          message: "Couldn't reach Zavi. Check your connection and try again.",
        });
        return null;
      }
    },
    [],
  );

  const errorOf = (codes: InviteErrorCode[]) =>
    status.kind === "error" && codes.includes(status.code) ? status.message : null;

  return {
    status,
    reset,
    clearFieldError,
    invite,
    submitting: status.kind === "submitting",
    userExistsError: errorOf(["user_already_exists"]),
    emailError: errorOf(["invalid_email"]),
    seatCapError: errorOf(["seat_cap_exceeded"]),
    otherError: errorOf(["forbidden", "network", "unknown"]),
  };
}

export function mapInviteErrorCode(status: number, code?: string): InviteErrorCode {
  if (status === 409 || code === "user_already_exists")
    return "user_already_exists";
  if (code === "seat_cap_exceeded") return "seat_cap_exceeded";
  if (status === 403) return "forbidden";
  if (status === 400) return "invalid_email";
  return "unknown";
}

export function defaultInviteErrorMessage(code: InviteErrorCode): string {
  switch (code) {
    case "user_already_exists":
      return "Someone with that email already has a Zavi account. Reach out to them directly. Multi-tenant accounts aren't supported yet.";
    case "seat_cap_exceeded":
      return "You've hit your seat cap on this plan. Upgrade your tier to add more teammates.";
    case "forbidden":
      return "You don't have permission to invite teammates.";
    case "invalid_email":
      return "Enter a valid email address.";
    case "network":
      return "Couldn't reach Zavi. Check your connection and try again.";
    default:
      return "Something went wrong sending the invite. Try again in a moment.";
  }
}
