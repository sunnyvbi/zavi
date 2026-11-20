import { useEffect, useState } from "react";
import { Text } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useAuth } from "../../auth/AuthProvider";
import { useWorkspace } from "../../features/workspaces/WorkspaceProvider";
import { useAcceptInvite } from "../../features/invites/acceptInvite";
import { inviteFailure, type InviteFailure } from "../../features/invites/outcome";
import { clearPendingInvite, setPendingInvite } from "../../features/invites/pendingInvite";
import { track } from "../../lib/analytics";
import { resetTo } from "../../lib/nav";
import { PHASE_ROUTE } from "../../features/creator/phase";
import {
  AuthError,
  AuthLink,
  AuthNote,
  AuthShell,
  AuthWaiting,
  makeAuthStyles,
} from "../../components/auth/AuthShell";
import { useStyles } from "../../theme/theme";

type Outcome = { kind: "joined"; switched: boolean } | { kind: Exclude<InviteFailure, "failed" | "signedout"> };

export default function InviteAccept() {
  const authStyles = useStyles(makeAuthStyles);
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { session, loading: authLoading, signOut } = useAuth();
  const { loading: workspacesLoading, tenants, activeTenantId } = useWorkspace();
  const accept = useAcceptInvite();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [joinError, setJoinError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const signedIn = !!session;
  const myEmail = session?.user?.email ?? "another account";

  useEffect(() => {
    if (authLoading || !id) return;
    void (signedIn ? clearPendingInvite() : setPendingInvite(id));
  }, [authLoading, signedIn, id]);

  const goHome = () => resetTo("/");
  const goChat = () => resetTo(PHASE_ROUTE.chat);

  function join() {
    if (!id) return;
    setJoinError(false);
    accept.mutate(id, {
      onSuccess: ({ switched }) => {
        track("invite_accepted");
        setOutcome({ kind: "joined", switched });
      },
      onError: (e) => {
        const failure = inviteFailure(e);
        if (failure === "failed" || failure === "signedout") setJoinError(true);
        else setOutcome({ kind: failure });
      },
    });
  }

  async function switchToInvitedEmail() {
    if (!id) return;
    setSigningOut(true);
    await setPendingInvite(id);
    setOutcome(null);
    await signOut().catch(() => {});
    setSigningOut(false);
  }

  if (authLoading || (signedIn && workspacesLoading) || signingOut) {
    return <AuthWaiting label="Checking your invite…" />;
  }

  if (!id || outcome?.kind === "notfound") {
    return (
      <AuthShell
        onBack={goHome}
        title="We can't find this invite"
        sub="It may have been deleted. Ask the person who invited you to send a new one."
        cta="Go to Zavi"
        onCta={goHome}
      />
    );
  }

  if (!signedIn) {
    return (
      <AuthShell
        onBack={goHome}
        title="Sign in to join the workspace"
        sub="Use the email this invite was sent to. We'll bring you right back to it."
        cta="Sign in and continue"
        onCta={() => router.push("/(auth)/login")}
      >
        <AuthLink lead="New to Zavi? " label="Create an account" onPress={() => router.push("/(auth)/signup")} />
      </AuthShell>
    );
  }

  if (outcome?.kind === "joined") {
    const name = tenants.find((t) => t.tenant_id === activeTenantId)?.display_name;
    return (
      <AuthShell
        onBack={goChat}
        eyebrow="Invite accepted"
        title={outcome.switched && name ? `You've joined ${name}.` : "You've joined the workspace."}
        sub={
          outcome.switched
            ? "Your own workspace stays in the workspace menu."
            : "Couldn't open it on this phone yet. Switch to it from the workspace menu."
        }
        cta={outcome.switched && name ? `Go to ${name}` : "Go to Zavi"}
        onCta={goChat}
      />
    );
  }

  if (outcome?.kind === "already") {
    return (
      <AuthShell
        onBack={goChat}
        title="You're already in this workspace"
        sub="Nothing to accept. Head straight in."
        cta="Go to Zavi"
        onCta={goChat}
      />
    );
  }

  if (outcome?.kind === "revoked") {
    return (
      <AuthShell
        onBack={goHome}
        title="This invite was cancelled"
        sub="Ask the person who invited you to send a new one."
        cta="Go to Zavi"
        onCta={goHome}
      />
    );
  }

  if (outcome?.kind === "wrong") {
    return (
      <AuthShell
        onBack={goHome}
        title="Wrong account for this invite"
        sub={
          <>
            {"This invite was sent to a different email. You're signed in as "}
            <Text style={authStyles.strong}>{myEmail}</Text>
            {"."}
          </>
        }
        cta="Sign out and use the invited email"
        onCta={() => void switchToInvitedEmail()}
      >
        <AuthLink label="Stay signed in" onPress={goHome} />
      </AuthShell>
    );
  }

  return (
    <AuthShell
      onBack={goHome}
      title="Join the workspace"
      sub={
        <>
          {"You've been invited to a Zavi workspace. You're signed in as "}
          <Text style={authStyles.strong}>{myEmail}</Text>
          {"."}
        </>
      }
      cta="Join workspace"
      onCta={join}
      busy={accept.isPending}
    >
      <AuthNote>Joining switches the app to that workspace. Your own workspace stays in the workspace menu.</AuthNote>
      {joinError ? <AuthError>Couldn&apos;t join. Check your connection and try again.</AuthError> : null}
      <AuthLink label="Not now" onPress={goHome} disabled={accept.isPending} />
    </AuthShell>
  );
}
