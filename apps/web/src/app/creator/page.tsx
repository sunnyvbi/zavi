
import type { Metadata } from "next";
import { Suspense } from "react";
import { CreatorChrome } from "@/components/creator/CreatorChrome";
import { CreatorInbox } from "@/components/creator/CreatorInbox";

export const metadata: Metadata = {
  title: "Your Zavi inbox",
  robots: { index: false, follow: false },
};

export default function CreatorInboxPage() {
  return (
    <CreatorChrome title="Inbox">
      {}
      <Suspense fallback={null}>
        <CreatorInbox />
      </Suspense>
    </CreatorChrome>
  );
}
