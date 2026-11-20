
import type { Metadata } from "next";
import { Suspense } from "react";
import { CreatorChrome } from "@/components/creator/CreatorChrome";
import { BriefsBoardSkeleton, CreatorBriefsBoard } from "@/components/creator/CreatorBriefs";

export const metadata: Metadata = {
  title: "Briefs for you",
  robots: { index: false, follow: false },
};

export default function CreatorBriefsPage() {
  return (
    <CreatorChrome title="Briefs" wide>
      <Suspense fallback={<BriefsBoardSkeleton />}>
        <CreatorBriefsBoard />
      </Suspense>
    </CreatorChrome>
  );
}
