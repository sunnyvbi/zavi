import type { ReactNode } from "react";

export function SettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="rounded-2xl border border-ca-border bg-ca-bg p-4">
      <h2 id={id} className="text-ca-title font-semibold text-ca-xdark">{title}</h2>
      {children}
    </section>
  );
}
