
export function HeroBrainBackdrop() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {}
      <div
        className="absolute -right-[28%] top-[8%] h-[125%] aspect-square opacity-[0.55]"
        style={{
          maskImage:
            "radial-gradient(circle at 50% 50%, #000 40%, rgba(0,0,0,0.6) 60%, rgba(0,0,0,0) 82%)",
          WebkitMaskImage:
            "radial-gradient(circle at 50% 50%, #000 40%, rgba(0,0,0,0.6) 60%, rgba(0,0,0,0) 82%)",
        }}
      >
        <SynapticLoopOnCream />
      </div>

    </div>
  );
}

function SynapticLoopOnCream() {
  const NODE_COLORS = ["#191919", "#FFC93D", "#7AE0BC", "#FF6B6B"];

  return (
    <svg viewBox="0 0 400 400" className="h-full w-full" aria-hidden="true">
      <defs>
        <radialGradient id="hb-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#191919" stopOpacity="0.55" />
          <stop offset="50%" stopColor="#191919" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#191919" stopOpacity="0" />
        </radialGradient>
      </defs>

      {}
      {[60, 95, 135, 180, 225, 275].map((r, i) => (
        <circle
          key={i}
          cx="200"
          cy="200"
          r={r}
          fill="none"
          stroke="#191919"
          strokeWidth="0.8"
          strokeOpacity={0.45 - i * 0.05}
        >
          <animate
            attributeName="r"
            values={`${r};${r + 10};${r}`}
            dur={`${35 + i * 4}s`}
            repeatCount="indefinite"
          />
        </circle>
      ))}

      {}
      <circle cx="200" cy="200" r="55" fill="url(#hb-core)" />
      <circle cx="200" cy="200" r="10" fill="#191919" fillOpacity="0.7">
        <animate attributeName="r" values="8;14;8" dur="30s" repeatCount="indefinite" />
        <animate
          attributeName="fill-opacity"
          values="0.6;0.85;0.6"
          dur="30s"
          repeatCount="indefinite"
        />
      </circle>

      {}
      {Array.from({ length: 16 }).map((_, i) => {
        const angle = (i * Math.PI * 2) / 16;
        const x2 = 200 + Math.cos(angle) * 290;
        const y2 = 200 + Math.sin(angle) * 290;
        const x1 = 200 + Math.cos(angle) * 22;
        const y1 = 200 + Math.sin(angle) * 22;
        return (
          <g key={i}>
            <line
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="#191919"
              strokeWidth="0.5"
              strokeOpacity="0.22"
            />
            {}
            <circle r="3" fill={NODE_COLORS[i % NODE_COLORS.length]} fillOpacity="0.9">
              <animateMotion
                dur={`${8 + (i % 4) * 1.5}s`}
                begin={`${(i * 0.6) % 6}s`}
                repeatCount="indefinite"
                path={`M${x1},${y1} L${x2},${y2} L${x1},${y1}`}
              />
              <animate
                attributeName="opacity"
                values="0;1;1;1;0"
                keyTimes="0;0.1;0.5;0.9;1"
                dur={`${8 + (i % 4) * 1.5}s`}
                begin={`${(i * 0.6) % 6}s`}
                repeatCount="indefinite"
              />
            </circle>
          </g>
        );
      })}

      {}
      {Array.from({ length: 16 }).map((_, i) => {
        const angle = (i * Math.PI * 2) / 16;
        const x = 200 + Math.cos(angle) * 290;
        const y = 200 + Math.sin(angle) * 290;
        const color = NODE_COLORS[i % NODE_COLORS.length];
        return (
          <g key={`o-${i}`}>
            <circle cx={x} cy={y} r="4" fill={color} fillOpacity="0.18" />
            <circle cx={x} cy={y} r="2.5" fill={color} fillOpacity="0.85" />
          </g>
        );
      })}
    </svg>
  );
}
