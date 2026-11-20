
export const GO_DEEPER_SLUGS: readonly string[] = ["research"];

type MessageLike = { id: string; sender_role: string; body: string; agent_run_id: string | null };

export function goDeeperPrompts<T extends MessageLike>(
  messages: readonly T[],
  depthByRun: ReadonlyMap<string, string> | undefined,
  slug: string,
  hasChips: (m: T) => boolean,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!GO_DEEPER_SLUGS.includes(slug) || !depthByRun || depthByRun.size === 0) return out;
  const promptByRun = new Map<string, string>();
  for (const m of messages) {
    if (m.sender_role === "user" && m.agent_run_id && m.body.trim()) promptByRun.set(m.agent_run_id, m.body);
  }
  for (const m of messages) {
    if (m.sender_role === "user" || m.sender_role === "system" || !m.agent_run_id) continue;
    const prompt = promptByRun.get(m.agent_run_id);
    if (prompt && depthByRun.get(m.agent_run_id) === "light" && !hasChips(m)) out.set(m.id, prompt);
  }
  return out;
}
