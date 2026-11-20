"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createBrowserSupabase } from "@/lib/supabase";
import { creatorApi, landingFor } from "./api";
import { creatorHome, signedUpAsCreator } from "./finishSignup";

export function useSignedInCreator(next: string | null): boolean {
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
          let home = await creatorApi.home();
          if (home.home === "/start" && signedUpAsCreator(user)) home = (await creatorHome(user, "", home)).home;
          if (alive && home.home === "/creator") {
            leaving = true;
            router.replace(landingFor("/creator", next));
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
