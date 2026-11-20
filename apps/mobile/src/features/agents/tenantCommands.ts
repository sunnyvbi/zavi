
export type TenantCommand = { slug: string; name: string; description: string };

export type TenantCommandsState = { commands: readonly TenantCommand[]; loaded: boolean; failed: boolean };

const SLUG = /^[a-z][a-z0-9-]{0,39}$/;

export function readTenantCommands(raw: unknown): TenantCommand[] {
  const rows = (raw as { commands?: unknown } | null)?.commands;
  if (!Array.isArray(rows)) return [];
  const out: TenantCommand[] = [];
  for (const r of rows) {
    const row = (r ?? {}) as Record<string, unknown>;
    if (typeof row.slug !== "string" || !SLUG.test(row.slug)) continue;
    out.push({
      slug: row.slug,
      name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : row.slug,
      description: typeof row.description === "string" ? row.description.trim() : "",
    });
  }
  return out;
}

export const NO_COMMANDS: readonly TenantCommand[] = [];

export function usableCommands(
  state: TenantCommandsState,
  where: { editing: boolean; channelPicked: boolean },
): TenantCommandsState | undefined {
  return where.editing || where.channelPicked ? undefined : state;
}

export function filterTenantCommands(query: string, rows: readonly TenantCommand[]): TenantCommand[] {
  const q = query.trim().toLowerCase();
  return q ? rows.filter((c) => c.slug.startsWith(q)) : [...rows];
}

export function matchTenantInvocation(input: string): { slug: string; body: string } | null {
  const m = /^\/([a-z][a-z0-9-]{0,39})(?:\s+([\s\S]*))?$/.exec(input);
  return m ? { slug: m[1], body: (m[2] ?? "").trim() } : null;
}

export function sendableTenantCommand(
  value: string,
  commands: readonly TenantCommand[],
): { slug: string; body: string } | null {
  const m = matchTenantInvocation(value.trim());
  return m && m.body && commands.some((c) => c.slug === m.slug) ? m : null;
}

export function tenantSlugList(commands: readonly TenantCommand[]): string {
  const shown = commands.slice(0, 5).map((c) => `/${c.slug}`);
  const more = commands.length - shown.length;
  return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

export function tenantCommandHint(value: string, state: TenantCommandsState): string | null | undefined {
  const m = matchTenantInvocation(value.trim());
  if (!m) return undefined;
  if (!state.loaded) return null;
  if (state.failed) return "Couldn't load your workspace commands. Try again in a moment.";
  if (!state.commands.some((c) => c.slug === m.slug)) return undefined;
  return m.body ? `Send to run /${m.slug}.` : `/${m.slug} needs a message.`;
}
