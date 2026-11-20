import type { ActionItem } from "../../types";

export function HoldNotices({ a }: { a: ActionItem }) {
  const held = a.status === "pending" && a.exec_status == null && a.held?.words.length ? a.held : null;
  const cap = a.status === "pending" && (a.exec_status == null || a.exec_status === "failed") && a.cap_warning ? a.cap_warning : null;
  if (!held && !cap) return null;
  return (
    <div className="flex flex-col gap-2 text-ca-action">
      {held && (
        <p data-testid="held-for-you" className="text-ca-xdark">
          <span className="font-medium">Held for you: {held.words.join("; ")}.</span>
          {held.evidence && <span className="text-ca-secondary"> {held.evidence}</span>}
        </p>
      )}
      {cap && (
        <p data-testid="cap-warning" role="status" className="text-ca-danger">
          <span className="font-medium">{cap}.</span> <span className="text-ca-secondary">Autopilot won&apos;t add spend while you&apos;re over; approving it is your call.</span>
        </p>
      )}
    </div>
  );
}
