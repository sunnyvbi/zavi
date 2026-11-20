
import type { Metadata } from "next";
import { Suspense } from "react";
import LoginForm from "./LoginForm";

export const metadata: Metadata = { title: "Zavi for creators: sign in" };

export default function CreatorLoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
