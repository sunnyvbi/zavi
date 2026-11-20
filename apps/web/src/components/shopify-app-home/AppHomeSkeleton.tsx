import { Skeleton } from "@/components/ui/Skeleton";
import { AppHomeCard } from "./AppHomeCard";

function CardSkeleton({ lines }: { lines: number }) {
  return (
    <AppHomeCard className="space-y-3 p-4">
      <Skeleton className="h-4 w-24" />
      {Array.from({ length: lines }, (_, i) => <Skeleton key={i} className="h-3 w-full" />)}
    </AppHomeCard>
  );
}

export function AppHomeSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_320px]">
      <div className="space-y-4"><CardSkeleton lines={4} /><CardSkeleton lines={3} /><CardSkeleton lines={5} /></div>
      <div className="space-y-4"><CardSkeleton lines={4} /><CardSkeleton lines={2} /></div>
    </div>
  );
}
