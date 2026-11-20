import { cn } from "@/lib/cn";
import { LiveRunBanner } from "./LiveRunBanner";

export function WebsiteEntryNotices({
  email,
  remove,
  from,
  website,
}: {
  email: string | null;
  remove: string | null;
  from: string | null;
  website: string;
}) {
  const text =
    email === "confirmed"
      ? "Email confirmed. We'll send your growth card as soon as it's ready, usually within a day."
      : email === "invalid"
        ? "That confirmation link has expired or was already used. Check your site again below."
        : email === "error" || remove === "error"
          ? "Something went wrong on our side. Please try again in a moment."
          : remove === "invalid"
            ? "That removal link has expired or was already used. Open the result and ask again."
            : null;
  return (
    <>
      {from && <LiveRunBanner from={from} website={website} />}
      {text && (
        <p
          role="status"
          className={cn(
            "mt-4 rounded-xl border px-4 py-3 text-sm leading-relaxed",
            email === "confirmed"
              ? "border-success/20 bg-success/5 text-success"
              : "border-warn/20 bg-warn/5 text-warn",
          )}
        >
          {text}
        </p>
      )}
    </>
  );
}
