
import type { ProgressItem } from "./api";

export function nextSteps(args: {
  incoming: ProgressItem[];
  mySeq: number;
  currentSeq: number;
  previous: ProgressItem[];
}): ProgressItem[] {
  if (args.mySeq !== args.currentSeq) return args.previous;

  return args.incoming;
}
