"use client";

import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { workspaceAgentHref } from "@/lib/workspace/tabUrl";

type AgentRow = { slug: string; name?: string };

export function CommandPalette({
  agents,
}: {
  agents: AgentRow[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmdOrCtrl = e.metaKey || e.ctrlKey;
      if (cmdOrCtrl && (e.key === "p" || e.key === "P" || e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 p-4 pt-[10vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <Command
        className="w-full max-w-lg rounded-block bg-white shadow-lift border border-bone overflow-hidden"
        loop
      >
        <Command.Input
          autoFocus
          placeholder="Search agents…  (⌘P)"
          className="w-full border-b border-bone bg-white px-4 py-3 text-[16px] text-ink placeholder:text-inkMuted focus:outline-none"
        />
        <Command.List className="max-h-[50vh] overflow-y-auto py-1">
          <Command.Empty className="px-4 py-6 text-[13px] text-inkMuted">
            No agents match.
          </Command.Empty>
          <Command.Group heading="Agents" className="px-1">
            {agents.map((a) => (
              <Command.Item
                key={a.slug}
                value={`${a.slug} ${a.name ?? ""}`}
                onSelect={() => {
                  setOpen(false);
                  router.push(workspaceAgentHref(a.slug));
                }}
                className="flex items-baseline justify-between gap-3 rounded-md px-3 py-2 text-[13px] cursor-pointer aria-selected:bg-violetSoft aria-selected:text-violetDeep"
              >
                <span className="font-mono text-ink">{a.slug}</span>
                {a.name && a.name !== a.slug && (
                  <span className="text-[11px] text-inkMuted truncate">{a.name}</span>
                )}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
