
export type ParsedInput =
  | { kind: "chat"; body: string }
  | { kind: "force_run"; body: string }
  | { kind: "feedback"; body: string }
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "route_to_agent"; agent: string; body: string }
  | { kind: "attach_decision"; decisionId: string; body: string }
  | { kind: "unknown_command"; raw: string };

const AGENT_SLUG_RE = /^[a-z][a-z0-9-]{1,63}$/;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function parseInput(raw: string): ParsedInput {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "chat", body: "" };
  }

  if (trimmed.startsWith("/")) {
    if (trimmed.length === 1 || /^\/\s/.test(trimmed)) {
      return { kind: "chat", body: trimmed };
    }
    const m = trimmed.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
    if (!m) return { kind: "chat", body: trimmed };
    const cmd = m[1].toLowerCase();
    const body = (m[2] ?? "").trim();

    if (cmd === "run") {
      return { kind: "force_run", body };
    }
    if (cmd === "feedback") {
      if (!body) return { kind: "unknown_command", raw: trimmed };
      return { kind: "feedback", body };
    }
    if (cmd === "clear") {
      return { kind: "clear" };
    }
    if (cmd === "help") {
      return { kind: "help" };
    }
    if (cmd === "decision") {
      const dm = body.match(/^(\S+)(?:\s+([\s\S]*))?$/);
      if (!dm) {
        return { kind: "unknown_command", raw: trimmed };
      }
      const decisionId = dm[1];
      if (!UUID_RE.test(decisionId)) {
        return { kind: "unknown_command", raw: trimmed };
      }
      return {
        kind: "attach_decision",
        decisionId,
        body: (dm[2] ?? "").trim(),
      };
    }
    return { kind: "unknown_command", raw: trimmed };
  }

  if (trimmed.startsWith("@")) {
    if (trimmed.length === 1 || /^@\s/.test(trimmed)) {
      return { kind: "chat", body: trimmed };
    }
    const m = trimmed.match(/^@(\S+)(?:\s+([\s\S]*))?$/);
    if (!m) return { kind: "chat", body: trimmed };
    const agent = m[1];
    const body = (m[2] ?? "").trim();
    if (!AGENT_SLUG_RE.test(agent)) {
      return { kind: "chat", body: trimmed };
    }
    return { kind: "route_to_agent", agent, body };
  }

  return { kind: "chat", body: trimmed };
}
