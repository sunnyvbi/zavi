export type CountGrid = { grid: string; item: (index: number) => string };

const TWO_UP = "mx-auto max-w-4xl sm:grid-cols-2";
const LG_TRACKS: Record<number, string> = { 6: "lg:grid-cols-6", 8: "lg:grid-cols-8" };
const LG_START: Record<number, string> = { 2: "lg:col-start-2", 3: "lg:col-start-3", 4: "lg:col-start-4" };
const LG_COLS: Record<number, string> = { 3: "lg:grid-cols-3", 4: "lg:grid-cols-4" };

const none = () => "";

export function countGrid(count: number, max: 2 | 3 | 4 = 3): CountGrid {
  const n = Math.max(0, Math.floor(count) || 0);
  if (n <= 1) return { grid: "grid mx-auto w-full max-w-md", item: none };
  if (n === 2 || (n === 4 && max === 3)) return { grid: `grid ${TWO_UP}`, item: none };
  if (n === 3 && max >= 3) return { grid: "grid md:grid-cols-3", item: none };
  if (n === 4 && max === 4) return { grid: "grid sm:grid-cols-2 lg:grid-cols-4", item: none };
  const cols = max === 2 ? 2 : max === 4 && n % 4 === 0 ? 4 : 3;
  if (cols === 2) {
    if (n % 2 === 0) return { grid: `grid ${TWO_UP}`, item: none };
    return { grid: "grid mx-auto max-w-4xl sm:grid-cols-4", item: (i) => (i === n - 1 ? "sm:col-span-2 sm:col-start-2" : "sm:col-span-2") };
  }
  if (n % 2 === 0 && n % cols === 0) return { grid: `grid sm:grid-cols-2 ${LG_COLS[cols]}`, item: none };
  const rest = n % cols;
  return {
    grid: `grid sm:grid-cols-4 ${LG_TRACKS[cols * 2]}`,
    item: (i) => {
      const smOrphan = n % 2 === 1 && i === n - 1;
      const lgOrphan = rest > 0 && i === n - rest;
      return ["sm:col-span-2", smOrphan && "sm:col-start-2", lgOrphan ? LG_START[cols - rest + 1] : smOrphan && "lg:col-start-auto"].filter(Boolean).join(" ");
    },
  };
}
