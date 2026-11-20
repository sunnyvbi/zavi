import { Suspense } from "react";
import { WebsiteSignupResume } from "@/app/start/WebsiteSignupResume";

export default function PastWorkPage() {
  return <Suspense fallback={null}><WebsiteSignupResume /></Suspense>;
}
