
import { alert as defaultAlert } from "@/services/logging/alert";
import { globalClient } from "@/services/tenant-client";
import { isOurSeatAuthError, isProviderAuthError, isSeatEntitlementError } from "./infra-retry";
import { seatLabelForToken } from "./seat-identity";

export interface SeatDisabledAlertDeps {
  alert: typeof defaultAlert;
  readNote: (seat: string) => Promise<string | null>;
  now: () => Date;
}

async function readSeatNote(seat: string): Promise<string | null> {
  const { data, error } = await globalClient()
    .from("agent_auth_seat_note")
    .select("note")
    .eq("seat", seat)
    .maybeSingle();
  if (error) return null;
  return (data as { note?: string } | null)?.note ?? null;
}

function refusalFor(text: string): { phrase: string; diagnosis: string; fix: string } {
  if (/account does not have access to claude/i.test(text)) {
    return {
      phrase: "Your account does not have access to Claude.",
      diagnosis: "its Claude account has lost access (signed out, removed or plan ended)",
      fix: "Sign that account back in to Claude and refresh its token in the pool,",
    };
  }
  return {
    phrase: "Your organization has disabled Claude subscription access for Claude Code.",
    diagnosis: "subscription access for Claude Code is disabled on its organization",
    fix: "Sign in to the Claude organization that owns this seat and turn Claude Code subscription access back on,",
  };
}

export function isSeatLoginFailure(text: string | null | undefined): boolean {
  if (text == null || isSeatEntitlementError(text)) return false;
  if (isOurSeatAuthError(text)) return true;
  return isProviderAuthError(text) && /^\s*(failed to authenticate\.\s*)?api error:\s*401\b/i.test(text);
}

function loginFailureFor(text: string): { phrase: string; diagnosis: string; fix: string } {
  const phrase = /revoked/i.test(text)
    ? "OAuth token has been revoked (API Error: 401)."
    : /expired/i.test(text)
      ? "OAuth token has expired (API Error: 401)."
      : "Authentication failed (API Error: 401).";
  return {
    phrase,
    diagnosis: "its Claude login has expired or been revoked",
    fix: "Log this seat back in (claude login / refresh the token in the seat pool),",
  };
}

const defaultDeps = (): SeatDisabledAlertDeps => ({
  alert: defaultAlert,
  readNote: readSeatNote,
  now: () => new Date(),
});

export function noteSeatDisabled(args: {
  token: string | undefined;
  text: string;
  runId: string | undefined;
  tenantId: string | undefined;
  rotated: boolean;
  deps?: Partial<SeatDisabledAlertDeps>;
}): Promise<void> {
  const kind = isSeatEntitlementError(args.text)
    ? ("disabled" as const)
    : isSeatLoginFailure(args.text)
      ? ("auth_failed" as const)
      : null;
  if (kind == null) return Promise.resolve();
  const deps = { ...defaultDeps(), ...(args.deps ?? {}) };
  return (async () => {
    try {
      const seat = seatLabelForToken(args.token);
      const note = await deps.readNote(seat).catch(() => null);
      const hour = deps.now().toISOString().slice(0, 13);
      const who = note ? `${seat} (${note})` : seat;
      const disabled = kind === "disabled";
      const refusal = disabled ? refusalFor(args.text) : loginFailureFor(args.text);
      await deps.alert({
        source: disabled ? "claude-seat-disabled" : "claude-seat-auth-failed",
        code: disabled ? "seat_disabled" : "seat_auth_failed",
        msg: disabled
          ? `Claude seat ${seat} is refusing runs: ${refusal.diagnosis}.`
          : `Claude seat ${seat} cannot log in: ${refusal.diagnosis}.`,
        email: {
          dedupeKey: `${disabled ? "seat_disabled" : "seat_auth_failed"}:${seat}:${hour}`,
          subjectDetail: disabled ? `Claude seat refusing runs: ${who}` : `Claude seat login expired: ${who}`,
          detail: [
            `Seat: ${who}`,
            `Run: ${args.runId ?? "unknown"} (tenant ${args.tenantId ?? "unknown"})`,
            args.rotated
              ? "This run moved to another seat. Other runs can still fail if every seat is busy or out."
              : "This run did not move to another seat. Check the run for whether it failed.",
            `${disabled ? "Refusal" : "Error"}: ${refusal.phrase}`,
            "",
            `Fix: ${refusal.fix}`,
            "or take the seat out of the Claude token pool.",
            "At most one email per seat per hour while it keeps failing.",
          ].join("\n"),
        },
      });
    } catch (e) {
      console.warn(`[seat-disabled-alert] alert failed (run=${args.runId ?? "unknown"}): ${(e as Error).message}`);
    }
  })();
}
