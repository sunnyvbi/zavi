import { Redirect } from "expo-router";
import { useAuth } from "../auth/AuthProvider";
import { useOnboarding } from "../features/onboarding/OnboardingProvider";
import { useCreatorProbe } from "../features/creator/hooks";
import { appPhase, gatePhase, PHASE_ROUTE } from "../features/creator/phase";
import { useAiConsent } from "../features/consent/useAiConsent";
import { useSetup } from "../features/setup/SetupProvider";

export default function Index() {
  const { session, loading } = useAuth();
  const { status } = useOnboarding();
  const creator = useCreatorProbe();
  const consent = useAiConsent();
  const setup = useSetup();
  if (loading) return null;
  const phase = gatePhase({
    phase: appPhase({ signedIn: !!session, onboarding: status, creator }),
    consent: consent.status,
    setup: setup.gate,
  });
  if (phase === "wait") return null;
  return <Redirect href={PHASE_ROUTE[phase]} />;
}
