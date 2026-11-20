
const RING_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];

export function SquareLoader({ className = "" }: { className?: string }) {
  return (
    <div
      role="status"
      aria-label="Loading"
      className={`grid grid-cols-3 gap-[5px] rotate-45 ${className}`}
    >
      {Array.from({ length: 9 }).map((_, i) => {
        if (i === 4) {
          return <span key={i} className="h-[11px] w-[11px] rounded-[3px] bg-ink opacity-90" />;
        }
        const step = RING_ORDER.indexOf(i);
        return (
          <span
            key={i}
            className="h-[11px] w-[11px] rounded-[3px] bg-ink motion-reduce:!animate-none"
            style={{
              animation: "squareLoaderPulse 1.1s ease-in-out infinite",
              animationDelay: `${step * 0.12}s`,
            }}
          />
        );
      })}
    </div>
  );
}
