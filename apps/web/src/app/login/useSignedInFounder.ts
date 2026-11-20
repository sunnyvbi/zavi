"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase";
import { creatorApi, landingFor } from "@/lib/creator/api";
import { signedUpAsCreator } from "@/lib/creator/finishSignup";
import { isCreatorPath } from "@/lib/safe-next";

type Home = "/workspace" | "/creator" | "/start";

export function signedInLanding(home: Home, next: string): string {
  if (home === "/creator") return landingFor("/creator", next);
  if (home === "/workspace") return isCreatorPath(next) ? "/workspace" : next;
  return isCreatorPath(next) || next === "/workspace" ? "/start" : next;
}

export function useSignedInFounder(next: string): boolean {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  useEffect(() => {
    let alive = true;
    void (async () => {
      let leaving = false;
      try {
        const { data } = await createBrowserSupabase().auth.getSession();
        const user = data.session?.user ?? null;
        if (user) {
          const { home } = await creatorApi.home();
          if (alive) {
            leaving = true;
            router.replace(home === "/start" && signedUpAsCreator(user) ? "/creators/login" : signedInLanding(home, next));
          }
        }
      } catch {
        leaving = false;
      }
      if (alive && !leaving) setChecking(false);
    })();
    return () => {
      alive = false;
    };
  }, [router, next]);
  return checking;
}
