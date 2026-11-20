import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "../../auth/AuthProvider";
import type { ConsentStatus } from "../creator/phase";

function storageKey(userId: string): string {
  return `zavi.consent.ai_data.${userId}`;
}

export type AiConsent = {
  agreed: boolean;
  needsGate: boolean;
  canSend: () => boolean;
  agree: () => void;
  decline: () => void;
  declined: boolean;
  status: ConsentStatus;
};

type Known = { userId: string | null; resolved: boolean; agreed: boolean; declined: boolean };

const Ctx = createContext<AiConsent | null>(null);

export function AiConsentProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const [known, setKnown] = useState<Known>({ userId: null, resolved: false, agreed: false, declined: false });
  const resolvedRef = useRef(false);
  const agreedRef = useRef(false);
  const userRef = useRef<string | null>(null);

  useEffect(() => {
    userRef.current = userId;
    resolvedRef.current = false;
    agreedRef.current = false;
    setKnown({ userId, resolved: false, agreed: false, declined: false });
    if (!userId) return;
    let alive = true;
    AsyncStorage.getItem(storageKey(userId))
      .then((v) => {
        if (!alive) return;
        const value = v === "1";
        resolvedRef.current = true;
        agreedRef.current = agreedRef.current || value;
        setKnown((k) => (k.userId === userId ? { ...k, resolved: true, agreed: k.agreed || value } : k));
      })
      .catch(() => {
        if (!alive) return;
        resolvedRef.current = true;
        setKnown((k) => (k.userId === userId ? { ...k, resolved: true } : k));
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  const agree = useCallback(() => {
    const id = userRef.current;
    if (!id) return;
    resolvedRef.current = true;
    agreedRef.current = true;
    setKnown((k) => (k.userId === id ? { ...k, resolved: true, agreed: true, declined: false } : k));
    void AsyncStorage.setItem(storageKey(id), "1").catch(() => {});
  }, []);

  const decline = useCallback(() => {
    const id = userRef.current;
    if (!id) return;
    setKnown((k) => (k.userId === id && !k.agreed ? { ...k, declined: true } : k));
  }, []);

  const canSend = useCallback(() => resolvedRef.current && agreedRef.current, []);

  const value = useMemo<AiConsent>(() => {
    const current = known.userId === userId;
    const resolved = current && known.resolved;
    const agreed = current && known.agreed;
    const declined = current && known.declined;
    const status: ConsentStatus = !resolved ? "loading" : agreed ? "agreed" : declined ? "declined" : "needed";
    return { agreed, needsGate: resolved && !agreed, canSend, agree, decline, declined, status };
  }, [known, userId, canSend, agree, decline]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAiConsent(): AiConsent {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAiConsent must be used inside <AiConsentProvider>");
  return ctx;
}
