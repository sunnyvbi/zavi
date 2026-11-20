
export type PitchSource =
  | { kind: "public_web" }
  | { kind: "slack" }
  | { kind: "connector"; connector_slug: string };

export type PitchCandidate = {
  agent_slug: string;
  title: string;
  opportunity: string;
  what_id_do: string;
  what_youd_get: string;
  source: PitchSource;
};

export type Pitch = {
  agent_slug: string;
  title: string;
  opportunity: string;
  what_id_do: string;
  what_youd_get: string;
  source_label: string;
  cta: "start_now" | "connect";
  needs_connector?: string;
};

function sourceLabel(source: PitchSource, connected: boolean): {
  label: string;
  cta: "start_now" | "connect";
  needs?: string;
} {
  switch (source.kind) {
    case "public_web":
      return { label: "from public web research", cta: "start_now" };
    case "slack":
      return { label: "from your Slack", cta: "start_now" };
    case "connector":
      return connected
        ? { label: `from your connected ${source.connector_slug}`, cta: "start_now" }
        : {
            label: `once you connect ${source.connector_slug}`,
            cta: "connect",
            needs: source.connector_slug,
          };
  }
}

export function buildPitches(input: {
  candidates: PitchCandidate[];
  connectedSlugs: ReadonlySet<string>;
  visibleSlugs: ReadonlySet<string>;
  max?: number;
}): Pitch[] {
  const max = input.max ?? 3;
  const out: Pitch[] = [];
  for (const c of input.candidates) {
    if (out.length >= max) break;
    if (!input.visibleSlugs.has(c.agent_slug)) continue;
    const connected =
      c.source.kind === "connector"
        ? input.connectedSlugs.has(c.source.connector_slug)
        : true;
    const { label, cta, needs } = sourceLabel(c.source, connected);
    out.push({
      agent_slug: c.agent_slug,
      title: c.title,
      opportunity: c.opportunity,
      what_id_do: c.what_id_do,
      what_youd_get: c.what_youd_get,
      source_label: label,
      cta,
      ...(needs ? { needs_connector: needs } : {}),
    });
  }
  return out;
}

export function renderTailoredIntro(input: {
  companyName: string;
  pitches: Pitch[];
  forChannel: boolean;
}): string {
  const lead = input.forChannel
    ? `:wave: *Hi team, I'm Zavi, an AI growth agent for your business.* I had a look at *${input.companyName}* and here are a few ways I can help.`
    : `I took a look at *${input.companyName}* based on public info. Here are 3 ways I think I can help right away:`;
  const lines: string[] = [lead, ``];
  input.pitches.forEach((p, i) => {
    const need =
      p.cta === "start_now"
        ? `*What I'd need:* nothing (${p.source_label}) — I can start now.`
        : `*What I'd need:* connect ${p.needs_connector} (2 min) and I'll start.`;
    lines.push(
      `*${i + 1}. ${p.title}*`,
      `• *The opportunity:* ${p.opportunity}`,
      `• *What I'd do:* ${p.what_id_do} (${p.source_label})`,
      `• *What you'd get:* ${p.what_youd_get}`,
      `• ${need}`,
      ``,
    );
  });
  if (!input.forChannel) {
    lines.push(
      `Want me to introduce myself to your team? *Invite me to a channel with \`/invite @Zavi\`* and I'll post this there.`,
    );
  }
  return lines.join("\n");
}
