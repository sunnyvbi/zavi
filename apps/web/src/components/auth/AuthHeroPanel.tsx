
const STATS: { value: string; label: string }[] = [
  { value: "12,480", label: "Signals routed daily" },
  { value: "180ms", label: "Handoff latency" },
  { value: "99.99%", label: "Mission uptime" },
];

const NODES: { x: number; y: number }[] = [
  { x: 14, y: 26 }, { x: 14, y: 52 }, { x: 14, y: 78 },
  { x: 42, y: 16 }, { x: 42, y: 40 }, { x: 42, y: 64 }, { x: 42, y: 88 },
  { x: 70, y: 28 }, { x: 70, y: 54 }, { x: 70, y: 80 },
  { x: 92, y: 42 }, { x: 92, y: 66 },
];
const EDGES: [number, number][] = [
  [0, 3], [0, 4], [1, 4], [1, 5], [2, 5], [2, 6],
  [3, 7], [4, 7], [4, 8], [5, 8], [5, 9], [6, 9],
  [7, 10], [8, 10], [8, 11], [9, 11],
];

function NeuralNetwork() {
  return (
    <svg viewBox="0 0 100 60" className="h-[150px] w-full" aria-hidden role="presentation">
      {EDGES.map(([a, b], i) => {
        const n1 = NODES[a];
        const n2 = NODES[b];
        return (
          <line
            key={`e-${i}`}
            x1={n1.x}
            y1={n1.y * 0.6}
            x2={n2.x}
            y2={n2.y * 0.6}
            stroke="#d4d4d4"
            strokeWidth="0.4"
          />
        );
      })}
      {NODES.map((n, i) => (
        <g key={`n-${i}`}>
          <circle cx={n.x} cy={n.y * 0.6} r="2.6" fill="#fff" stroke="#a3a3a3" strokeWidth="0.5" />
          <circle cx={n.x} cy={n.y * 0.6} r="1" fill="#171717" />
        </g>
      ))}
    </svg>
  );
}

export function AuthHeroPanel() {
  return (
    <aside
      aria-hidden="true"
      className="relative hidden overflow-hidden lg:block"
      style={{
        background:
          "radial-gradient(78% 72% at 68% 54%, #2f7cf6 0%, #1a4fc0 20%, #0c2f82 35%, #06204f 49%, #04132f 63%, #020c1c 78%, #01060f 100%)",
      }}
    >
      <div className="absolute inset-0 flex items-center justify-center p-10">
        <div className="w-full max-w-[538px] overflow-hidden rounded-block border border-[#e5e5e5] bg-white shadow-[0_25px_50px_-12px_rgba(2,16,44,0.45)]">
          {}
          <div className="flex items-center justify-between px-6 pt-6">
            <p className="text-[12px] uppercase leading-4 tracking-[2.4px] text-[#737373]">
              AI agents work 24 hours
            </p>
            <span className="inline-flex items-center gap-2">
              <span className="relative inline-flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#171717] opacity-50" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#171717]" />
              </span>
              <span className="text-[12px] leading-4 text-[#404040]">Live</span>
            </span>
          </div>

          {}
          <div className="px-6 pb-2 pt-5">
            <NeuralNetwork />
          </div>

          {}
          <div className="grid grid-cols-3 border-t border-[#f5f5f5] bg-white/80 px-6 py-4">
            {STATS.map((s) => (
              <div key={s.label}>
                <p className="text-[24px] font-medium leading-9 tracking-[-0.53px] text-[#171717]">
                  {s.value}
                </p>
                <p className="mt-0.5 text-[11px] leading-4 text-[#737373]">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}
