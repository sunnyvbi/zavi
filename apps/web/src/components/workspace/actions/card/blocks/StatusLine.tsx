import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import type { ActionItem } from "../../types";

export function StatusLine({ tone, children }: { tone: "success" | "muted" | "error"; children: React.ReactNode }) {
  return (
    <p role="status" className={cn("inline-flex items-center gap-1.5 text-ca-action font-medium", tone === "success" ? "text-ca-success" : tone === "error" ? "text-ca-danger" : "text-ca-secondary")}>
      {tone === "success" && <Check className="size-4" aria-hidden />}
      {children}
    </p>
  );
}

export function FailedLine({ a }: { a: ActionItem }) {
  return (
    <p role="alert" className="text-ca-action font-medium text-ca-danger">
      {a.exec_fix_text ?? a.note ?? "This change did not go through. Try again."}
      {a.exec_checkout_url && <a href={a.exec_checkout_url} className="ml-2 text-ca-primary underline underline-offset-4 hover:no-underline">Add credits</a>}
    </p>
  );
}
