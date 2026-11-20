"use client";

import type { SlashCommand } from "@/lib/workspace/slashCommandRegistry";
import type { TenantSlashEntry } from "@/lib/workspace/tenantCommands";

export type SlashSelection =
  | { kind: "builtin"; cmd: SlashCommand }
  | { kind: "tenant"; entry: TenantSlashEntry };

export function SlashMenu({
  matches,
  tenantMatches = [],
  cursor,
  onSelect,
}: {
  matches: SlashCommand[];
  tenantMatches?: TenantSlashEntry[];
  cursor: number;
  onSelect: (selection: SlashSelection) => void;
}) {
  if (matches.length === 0 && tenantMatches.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Slash commands"
      className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-lg border border-ink/10 bg-white shadow-lg"
    >
      {matches.map((cmd, i) => {
        const isActive = i === cursor;
        return (
          <div
            key={`builtin:${cmd.name}`}
            role="option"
            aria-selected={isActive}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect({ kind: "builtin", cmd });
            }}
            className={`flex cursor-pointer items-baseline justify-between px-3 py-2 text-[13px] ${
              isActive ? "bg-creamDeep" : "bg-white hover:bg-creamDeep/60"
            }`}
          >
            <span className="flex items-baseline gap-2">
              <span className="font-mono text-violet">/{cmd.name}</span>
              <span className="font-mono text-[12px] text-inkMuted">
                {cmd.argHint}
              </span>
            </span>
            <span className="ml-3 truncate text-[12px] text-inkMuted">
              {cmd.description}
            </span>
          </div>
        );
      })}

      {tenantMatches.length > 0 && (
        <>
          {matches.length > 0 && (
            <div className="border-t border-ink/10 bg-cream/60 px-3 py-1 text-[11px] font-mono uppercase tracking-[0.16em] text-inkMuted">
              Your commands
            </div>
          )}
          {tenantMatches.map((entry, j) => {
            const i = matches.length + j;
            const isActive = i === cursor;
            return (
              <div
                key={`tenant:${entry.slug}`}
                role="option"
                aria-selected={isActive}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect({ kind: "tenant", entry });
                }}
                className={`flex cursor-pointer items-baseline justify-between px-3 py-2 text-[13px] ${
                  isActive ? "bg-creamDeep" : "bg-white hover:bg-creamDeep/60"
                }`}
              >
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-violet">/{entry.slug}</span>
                  <span className="text-[12px] text-inkMuted">
                    {entry.name}
                  </span>
                </span>
                {entry.description && (
                  <span className="ml-3 truncate text-[12px] text-inkMuted">
                    {entry.description}
                  </span>
                )}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
