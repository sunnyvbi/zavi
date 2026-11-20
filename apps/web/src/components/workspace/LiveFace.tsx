import type { ReactNode } from "react";

export function LiveFace({ face, children }: { face?: ReactNode; children: ReactNode }) {
  if (!face) return <>{children}</>;
  return (
    <div className="flex items-start gap-2">
      <div className="mt-2 flex h-6 w-6 shrink-0 items-center justify-center">{face}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
