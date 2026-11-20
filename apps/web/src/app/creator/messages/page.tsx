
import type { Metadata } from "next";
import { Suspense } from "react";
import { CreatorChrome } from "@/components/creator/CreatorChrome";
import { CreatorMessages } from "@/components/creator/CreatorMessages";

export const metadata: Metadata = {
  title: "Your messages",
  robots: { index: false, follow: false },
};

export default function CreatorMessagesPage() {
  return (
    <CreatorChrome title="Messages">
      {}
      <Suspense fallback={null}>
        <CreatorMessages />
      </Suspense>
    </CreatorChrome>
  );
}
