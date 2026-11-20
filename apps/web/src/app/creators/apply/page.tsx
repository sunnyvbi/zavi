
import type { Metadata } from "next";
import { Suspense } from "react";
import ApplyFlow from "./ApplyFlow";

export const metadata: Metadata = { title: "Zavi for creators: sign up" };

export default function CreatorApplyPage() {
  return (
    <Suspense>
      <ApplyFlow />
    </Suspense>
  );
}
