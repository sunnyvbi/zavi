"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, {
  type ForceGraphMethods,
} from "react-force-graph-2d";
import { assignNotesToAnchors } from "./affinity";

export { assignNotesToAnchors } from "./affinity";

export type AnchorInput = {
  id: string;
  slug: string;
  label: string;
  body: string;
  written: boolean;
  tier: "canonical" | "primary";
  primary_rank?: number;
};

export type NoteInput = {
  id: string;
  title: string;
  body: string;
  note_type: string;
  tags: string[];
};

export type EntityInput = {
  id: string;
  canonical_name: string;
  entity_type: string;
};

export type PulseEvent = {
  nodeId: string;
  kind: "write" | "run";
  ts: number;
};

export type PriorityHighlight = {
  rank: number;
  graphNodeId: string;
};

type BrainNode = {
  id: string;
  kind: "anchor" | "note" | "entity";
  label: string;
  color: string;
  glow: string;
  size: number;
  anchorSlug?: string;
  noteType?: string;
  entityType?: string;
  written?: boolean;
  tier?: "canonical" | "primary";
  primaryRank?: number;
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
};

type BrainLink = {
  source: string;
  target: string;
  strength: number;
};

const NOTE_TYPE_COLOR: Record<string, { fill: string; stroke: string }> = {
  operator_preference: { fill: "#2B2A28", stroke: "#191919" },
  agent_feedback: { fill: "#FFC93D", stroke: "#A07000" },
  tenant_project: { fill: "#A3D9C0", stroke: "#0E9F6E" },
  tenant_reference: { fill: "#5EEAD4", stroke: "#0F766E" },
  untyped: { fill: "#C4BFB3", stroke: "#787268" },
};

const ENTITY_FILL = "#787268";
const DARK_INK: Record<string, string> = { "#191919": "#ECECEC", "#2B2A28": "#BDBDBD" };
const isDark = () => typeof document !== "undefined" && document.documentElement.classList.contains("dark");
const themed = (c: string) => (isDark() ? DARK_INK[c.toUpperCase()] ?? c : c);
const ANCHOR_FILL = "#191919";
const ANCHOR_STROKE = "#2B2A28";
const ANCHOR_INK_STROKE = "#191919";
const PRIORITY_RING = "#FF6B6B";
const PRIORITY_FILL = "#FFE3E3";
const PULSE_COLOR_WRITE = "#0E9F6E";
const PULSE_COLOR_RUN = "#FFC93D";
const PULSE_MS = 1400;

export function computeAnchorPositions(
  anchors: ReadonlyArray<Pick<AnchorInput, "slug" | "tier">>,
  dims: { width: number; height: number },
): Map<string, { x: number; y: number }> {
  const baseRCanonical = Math.min(dims.width, dims.height) * 0.30;
  const baseRPrimary = Math.min(dims.width, dims.height) * 0.18;
  const cx = 0;
  const cy = 0;
  const out = new Map<string, { x: number; y: number }>();

  const canonical = anchors.filter((a) => a.tier !== "primary");
  const primary = anchors.filter((a) => a.tier === "primary");

  canonical.forEach((a, i) => {
    const angle =
      (i / Math.max(canonical.length, 1)) * Math.PI * 2 - Math.PI / 2;
    out.set(a.slug, {
      x: cx + Math.cos(angle) * baseRCanonical,
      y: cy + Math.sin(angle) * baseRCanonical,
    });
  });

  const primaryAngleOffset =
    primary.length > 1 ? Math.PI / primary.length : 0;
  primary.forEach((a, i) => {
    const angle =
      primary.length === 1
        ? -Math.PI / 2
        : (i / primary.length) * Math.PI * 2 - Math.PI / 2 + primaryAngleOffset;
    out.set(a.slug, {
      x: cx + Math.cos(angle) * baseRPrimary,
      y: cy + Math.sin(angle) * baseRPrimary,
    });
  });

  return out;
}

export function BrainGraph({
  anchors,
  notes,
  entities,
  pulses,
  reads24h,
  priority,
  hoveredPriorityRank,
  onAnchorClick,
  onNoteClick,
  onEntityClick,
  onHoveredPriorityChange,
}: {
  anchors: AnchorInput[];
  notes: NoteInput[];
  entities: EntityInput[];
  pulses: PulseEvent[];
  reads24h: number;
  priority: PriorityHighlight[];
  hoveredPriorityRank: number | null;
  onAnchorClick: (a: AnchorInput) => void;
  onNoteClick: (n: NoteInput) => void;
  onEntityClick: (e: EntityInput) => void;
  onHoveredPriorityChange: (rank: number | null) => void;
}) {
  const fgRef = useRef<ForceGraphMethods<BrainNode, BrainLink> | undefined>(
    undefined,
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dims, setDims] = useState({ width: 800, height: 620 });
  const [hovered, setHovered] = useState<BrainNode | null>(null);

  const pulsesByIdRef = useRef<Map<string, { until: number; kind: "write" | "run" }>>(
    new Map(),
  );

  useEffect(() => {
    if (!pulses.length) return;
    const map = pulsesByIdRef.current;
    const now = Date.now();
    for (const p of pulses) {
      map.set(p.nodeId, { until: now + PULSE_MS, kind: p.kind });
    }
  }, [pulses]);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const map = pulsesByIdRef.current;
      const now = Date.now();
      let active = false;
      for (const [k, v] of map) {
        if (v.until <= now) map.delete(k);
        else active = true;
      }
      if (active && fgRef.current) {
        fgRef.current.d3ReheatSimulation?.();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        setDims({
          width: Math.max(320, Math.floor(width)),
          height: Math.max(360, Math.floor(height)),
        });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const priorityById = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of priority) m.set(p.graphNodeId, p.rank);
    return m;
  }, [priority]);

  const noteToAnchor = useMemo(
    () => assignNotesToAnchors(anchors, notes),
    [anchors, notes],
  );

  const graphData = useMemo(() => {
    const anchorPosBySlug = computeAnchorPositions(anchors, dims);
    const anchorNodes: BrainNode[] = anchors.map((a) => {
      const pos = anchorPosBySlug.get(a.slug);
      return {
        id: `a:${a.id}`,
        kind: "anchor",
        label: a.label,
        color: a.written ? ANCHOR_FILL : "#A8A39A",
        glow: a.written ? "rgba(25,25,25,0.20)" : "rgba(168,163,154,0.18)",
        size: 13,
        anchorSlug: a.slug,
        written: a.written,
        tier: a.tier,
        primaryRank: a.primary_rank,
        fx: pos?.x,
        fy: pos?.y,
      };
    });

    const noteNodes: BrainNode[] = notes.map((n) => {
      const c = NOTE_TYPE_COLOR[n.note_type] ?? NOTE_TYPE_COLOR.untyped;
      return {
        id: `n:${n.id}`,
        kind: "note",
        label: n.title || "(untitled)",
        color: c.fill,
        glow: c.stroke,
        size: 5,
        anchorSlug: noteToAnchor.get(n.id),
        noteType: n.note_type,
      };
    });

    const entityNodes: BrainNode[] = entities.map((e) => ({
      id: `e:${e.id}`,
      kind: "entity",
      label: e.canonical_name,
      color: ENTITY_FILL,
      glow: "rgba(120,114,104,0.0)",
      size: 1.8,
      entityType: e.entity_type,
    }));

    const links: BrainLink[] = [];
    const anchorIdBySlug = new Map(anchors.map((a) => [a.slug, a.id]));

    for (const n of notes) {
      const slug = noteToAnchor.get(n.id);
      if (!slug) continue;
      const aid = anchorIdBySlug.get(slug);
      if (!aid) continue;
      links.push({ source: `a:${aid}`, target: `n:${n.id}`, strength: 0.5 });
    }

    const notesByAnchor = new Map<string, NoteInput[]>();
    for (const n of notes) {
      const slug = noteToAnchor.get(n.id);
      if (!slug) continue;
      const arr = notesByAnchor.get(slug) ?? [];
      arr.push(n);
      notesByAnchor.set(slug, arr);
    }
    for (const sibs of notesByAnchor.values()) {
      for (let i = 0; i < sibs.length; i += 1) {
        let added = 0;
        for (let j = i + 1; j < sibs.length && added < 2; j += 1) {
          const a = sibs[i];
          const b = sibs[j];
          const shared = (a.tags ?? []).some((t) => (b.tags ?? []).includes(t));
          if (shared) {
            links.push({
              source: `n:${a.id}`,
              target: `n:${b.id}`,
              strength: 0.15,
            });
            added += 1;
          }
        }
      }
    }

    for (const e of entities) {
      const needle = e.canonical_name.toLowerCase();
      if (needle.length < 3) continue;
      let added = 0;
      for (const n of notes) {
        if (added >= 3) break;
        const hay = `${n.title}\n${n.body}`.toLowerCase();
        if (hay.includes(needle)) {
          links.push({ source: `n:${n.id}`, target: `e:${e.id}`, strength: 0.10 });
          added += 1;
        }
      }
    }

    return {
      nodes: [...anchorNodes, ...noteNodes, ...entityNodes],
      links,
    };
  }, [anchors, notes, entities, noteToAnchor, dims.width, dims.height]);

  const handleNodeClick = (node: BrainNode) => {
    if (node.kind === "anchor") {
      const real = anchors.find((a) => `a:${a.id}` === node.id);
      if (real) onAnchorClick(real);
    } else if (node.kind === "note") {
      const real = notes.find((n) => `n:${n.id}` === node.id);
      if (real) onNoteClick(real);
    } else {
      const real = entities.find((e) => `e:${e.id}` === node.id);
      if (real) onEntityClick(real);
    }
  };

  useEffect(() => {
    if (!fgRef.current) return;
    const t = setTimeout(() => fgRef.current?.zoomToFit?.(400, 40), 700);
    return () => clearTimeout(t);
  }, [dims.width, dims.height, anchors.length, notes.length]);

  return (
    <div
      ref={containerRef}
      className="relative h-full min-h-[420px] w-full overflow-hidden rounded-2xl border border-ink/15 shadow-sm"
      style={{
        background:
          "radial-gradient(ellipse at 50% 32%, #F7F6F3 0%, #EFEDE7 60%, #E4E1D8 100%)",
      }}
    >
      <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-inkMuted">
        <Badge>{anchors.filter((a) => a.written).length} anchors</Badge>
        <Badge>{notes.length} notes</Badge>
        <Badge>{entities.length} entities</Badge>
      </div>
      <div className="pointer-events-none absolute right-3 top-3 z-10 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wide text-inkMuted">
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-mintDeep opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-mintDeep" />
        </span>
        <span>{reads24h} reads / 24h · live</span>
      </div>

      {hovered && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 max-w-[60%] rounded-md border border-ink/10 bg-white/85 px-2.5 py-1.5 font-mono text-[11px] text-ink/85 shadow-sm backdrop-blur-sm">
          <span className="uppercase tracking-wide text-inkMuted">
            {hovered.kind}
            {hovered.noteType ? ` · ${hovered.noteType}` : ""}
            {hovered.entityType ? ` · ${hovered.entityType}` : ""}
          </span>
          <span className="ml-2">{hovered.label}</span>
        </div>
      )}

      <ForceGraph2D
        ref={fgRef}
        graphData={graphData}
        width={dims.width}
        height={dims.height}
        backgroundColor="rgba(0,0,0,0)"
        nodeRelSize={4}
        nodeLabel={() => ""}
        linkColor={() => (isDark() ? "rgba(236,236,236,0.16)" : "rgba(25,25,25,0.10)")}
        linkWidth={() => 0.7}
        d3VelocityDecay={0.4}
        cooldownTicks={140}
        warmupTicks={80}
        enableNodeDrag={false}
        onNodeHover={(node) => {
          const n = (node as BrainNode | null) ?? null;
          setHovered(n);
          const rank = n ? priorityById.get(n.id) ?? null : null;
          onHoveredPriorityChange(rank);
        }}
        onNodeClick={(node) => handleNodeClick(node as BrainNode)}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const n = node as BrainNode;
          const now = Date.now();
          const pulse = pulsesByIdRef.current.get(n.id);
          const pulseRemainMs = pulse ? Math.max(0, pulse.until - now) : 0;
          const pulseT = pulseRemainMs / PULSE_MS;

          const priorityRank = priorityById.get(n.id);
          const isHoveredPriority =
            priorityRank != null && hoveredPriorityRank === priorityRank;

          const x = n.x ?? 0;
          const y = n.y ?? 0;
          const size = n.size;

          if (priorityRank != null) {
            const haloR = size * (isHoveredPriority ? 4.4 : 3.4);
            const grad = ctx.createRadialGradient(x, y, size * 0.6, x, y, haloR);
            grad.addColorStop(0, "rgba(255,107,107,0.35)");
            grad.addColorStop(1, "rgba(255,107,107,0)");
            ctx.beginPath();
            ctx.fillStyle = grad;
            ctx.arc(x, y, haloR, 0, Math.PI * 2);
            ctx.fill();
          }

          if (n.kind === "anchor") {
            const glowR = size * 2.4;
            const grad = ctx.createRadialGradient(x, y, size * 0.5, x, y, glowR);
            grad.addColorStop(0, n.glow);
            grad.addColorStop(1, "rgba(0,0,0,0)");
            ctx.beginPath();
            ctx.fillStyle = grad;
            ctx.arc(x, y, glowR, 0, Math.PI * 2);
            ctx.fill();
          }

          if (pulseT > 0) {
            const ringR = size + (1 - pulseT) * size * 3.2;
            const ringColor = pulse?.kind === "write" ? PULSE_COLOR_WRITE : PULSE_COLOR_RUN;
            ctx.beginPath();
            ctx.strokeStyle = ringColor;
            ctx.globalAlpha = pulseT;
            ctx.lineWidth = 1.6;
            ctx.arc(x, y, ringR, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }

          ctx.beginPath();
          ctx.fillStyle = priorityRank != null && n.kind === "note"
            ? PRIORITY_FILL
            : themed(n.color);
          ctx.arc(x, y, priorityRank != null ? size * 1.35 : size, 0, Math.PI * 2);
          ctx.fill();

          if (priorityRank != null) {
            ctx.beginPath();
            ctx.strokeStyle = PRIORITY_RING;
            ctx.lineWidth = 2.2;
            ctx.arc(x, y, size * 1.35 + 1.4, 0, Math.PI * 2);
            ctx.stroke();
          } else if (n.kind === "anchor") {
            ctx.beginPath();
            ctx.strokeStyle = themed(ANCHOR_INK_STROKE);
            ctx.lineWidth = 1.4;
            ctx.arc(x, y, size + 1.4, 0, Math.PI * 2);
            ctx.stroke();
          } else if (n.kind === "note") {
            ctx.beginPath();
            ctx.strokeStyle = themed(n.glow);
            ctx.lineWidth = 0.9;
            ctx.arc(x, y, size + 0.4, 0, Math.PI * 2);
            ctx.stroke();
          }

          if (n.kind === "anchor" && n.tier === "primary") {
            ctx.beginPath();
            ctx.strokeStyle = PRIORITY_RING;
            ctx.lineWidth = 2;
            ctx.arc(x, y, size + 4, 0, Math.PI * 2);
            ctx.stroke();
          }

          if (priorityRank != null) {
            const badgeR = 6;
            const bx = x + size * 1.3;
            const by = y - size * 1.3;
            ctx.beginPath();
            ctx.fillStyle = PRIORITY_RING;
            ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#FFFFFF";
            const fs = 9 / Math.max(globalScale, 0.6);
            ctx.font = `700 ${fs}px ui-sans-serif, system-ui`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(priorityRank), bx, by + 0.4);
          }

          if (
            n.kind === "anchor" &&
            n.tier === "primary" &&
            n.primaryRank != null
          ) {
            const badgeR = 7;
            const hasPriorityBadge = priorityRank != null;
            const bx = hasPriorityBadge ? x - size * 1.3 : x + size * 1.3;
            const by = y - size * 1.3;
            ctx.beginPath();
            ctx.fillStyle = "#FFFFFF";
            ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.strokeStyle = PRIORITY_RING;
            ctx.lineWidth = 1.4;
            ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
            ctx.stroke();
            ctx.fillStyle = ANCHOR_INK_STROKE;
            const fs = 11 / Math.max(globalScale, 0.6);
            ctx.font = `700 ${fs}px ui-sans-serif, system-ui`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(String(n.primaryRank), bx, by + 0.4);
          }

          if (n.kind === "anchor" && globalScale > 0.55) {
            const fontSize = 11 / Math.max(globalScale, 0.6);
            ctx.font = `600 ${fontSize}px ui-sans-serif, system-ui`;
            ctx.fillStyle = themed("#191919");
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(n.label, x, y + size + 5);
          } else if (hovered?.id === n.id && globalScale > 0.4) {
            const fontSize = 10 / Math.max(globalScale, 0.6);
            ctx.font = `500 ${fontSize}px ui-sans-serif, system-ui`;
            ctx.fillStyle = themed("#2B2A28");
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(n.label.slice(0, 32), x, y + size + 4);
          }
        }}
      />

      <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex items-center gap-3 rounded-md border border-ink/10 bg-white/80 px-2 py-1 font-mono text-[11px] uppercase tracking-wide text-inkMuted shadow-sm backdrop-blur-sm">
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-2.5 rounded-full border border-ink bg-ink"
          />
          anchor
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-full bg-inkSoft"
          />
          note
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ background: ENTITY_FILL }}
          />
          entity
        </span>
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2 w-2 rounded-full ring-2 ring-coral"
            style={{ background: PRIORITY_FILL }}
          />
          act now
        </span>
      </div>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-white/70 px-1.5 py-0.5 ring-1 ring-ink/10 backdrop-blur-sm">
      {children}
    </span>
  );
}
