import { Archive, CircleAlert, Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Skeleton } from "@/components/ui/Skeleton";
import type { ArtifactView } from "./types";

const SKELETON_HEIGHTS = ["h-40", "h-56", "h-36", "h-48", "h-40", "h-64", "h-36", "h-52", "h-44", "h-40", "h-60", "h-36"];

export function ArtifactLoading({ view }: { view: ArtifactView }) {
  if (view === "list") {
    return (
      <div className="space-y-3" role="status" aria-label="Loading artifacts">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="flex items-center gap-4 rounded-xl border border-rule bg-cream p-3">
            <Skeleton className="h-16 w-24" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div
      className="columns-[9.5rem] gap-2.5 sm:columns-[11rem]"
      role="status"
      aria-label="Loading artifacts"
    >
      {SKELETON_HEIGHTS.map((height, item) => (
        <Skeleton key={item} className={`${height} mb-2.5 w-full break-inside-avoid rounded-xl`} />
      ))}
    </div>
  );
}

export function ArtifactError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div role="alert" className="flex min-h-96 flex-col items-center justify-center text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-dangerBg text-danger">
        <CircleAlert className="h-6 w-6" aria-hidden="true" />
      </span>
      <h2 className="mt-4 text-base font-semibold text-ink">Artifacts couldn&rsquo;t load</h2>
      <p className="mt-2 max-w-md text-base text-inkMuted">{message}</p>
      <Button onClick={onRetry} className="mt-4">Try again</Button>
    </div>
  );
}

export function ArtifactEmpty({ filtered, onCreate }: { filtered: boolean; onCreate: () => void }) {
  return (
    <div className="flex min-h-96 flex-col items-center justify-center px-6 text-center">
      <Archive className="h-12 w-12 text-inkMuted" strokeWidth={1.5} aria-hidden="true" />
      <h2 className="mt-5 text-base font-semibold text-ink">
        {filtered ? "No artifacts match your search" : "Your artifacts will live here"}
      </h2>
      <p className="mt-2 max-w-md text-base leading-6 text-inkMuted">
        {filtered
          ? "Try a different search or artifact type."
          : "Reports, documents, images, slides, websites, dashboards, and files created in your chats will appear here."}
      </p>
      {!filtered && (
        <Button onClick={onCreate} className="mt-5 bg-ink text-cream hover:bg-inkSoft">
          <Plus className="h-4 w-4" aria-hidden="true" />
          Create artifact
        </Button>
      )}
    </div>
  );
}
