import { useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BottomSheetModal } from "@gorhom/bottom-sheet";
import { Screen } from "../../components/Screen";
import { WorkspaceLogo } from "../../components/WorkspaceLogo";
import { Icon } from "../../components/Icon";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { showDialog } from "../../components/DialogHost";
import { CreditsMiniCard } from "../../components/billing/CreditsMiniCard";
import {
  BackHeader,
  Badge,
  ListGroup,
  Row,
  SectionLabel,
  settingsStyles,
} from "../../components/settings/SettingsUI";
import { WorkspaceSheet, roleLabel } from "../../components/settings/WorkspaceSheet";
import { useAuth } from "../../auth/AuthProvider";
import { isBillingEnabled, useSignupAvailability } from "../../auth/signup";
import { useCanManage, useCredits, useMyRole } from "../../features/settings/api";
import { useWorkspace } from "../../features/workspaces/WorkspaceProvider";
import { appearanceLabel, useAppearance } from "../../lib/appearance";
import { track } from "../../lib/analytics";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export default function Settings() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { session, signOut } = useAuth();
  const { tenants, activeTenantId } = useWorkspace();
  const { preference } = useAppearance();
  const role = useMyRole();
  const creditsQ = useCredits();
  const canManage = useCanManage();
  const signupAvailability = useSignupAvailability();
  const workspaceSheet = useRef<BottomSheetModal>(null);

  const [confirmingSignOut, setConfirmingSignOut] = useState(false);

  function signOutConfirmed() {
    setConfirmingSignOut(false);
    track("logged_out");
    void signOut().catch((e: unknown) =>
      showDialog({
        title: "Couldn't log out",
        message: e instanceof Error && e.message ? e.message : "Something went wrong. Please try again.",
      }),
    );
  }

  const email = session?.user?.email ?? "";
  const fullName =
    (typeof session?.user?.user_metadata?.full_name === "string"
      ? session.user.user_metadata.full_name.trim()
      : "") || (email ? email.split("@")[0] : "Signed in");
  const activeTenant = tenants.find((t) => t.tenant_id === activeTenantId);
  const billingEnabled = isBillingEnabled(signupAvailability.data);
  const canBuy = canManage && billingEnabled;
  const initials = initialsFromName(fullName);

  return (
    <Screen>
      <BackHeader title="Settings" />
      {}
      <ScrollView
        contentContainerStyle={[settingsStyles.content, { paddingBottom: insets.bottom + 20 }]}
      >
        <View style={styles.identity}>
          <View style={styles.identityAvatar}>
            <Text style={styles.identityInitials}>{initials}</Text>
          </View>
          <View style={styles.identityText}>
            <Text style={styles.name} numberOfLines={1}>
              {fullName}
            </Text>
            {email ? (
              <Text style={styles.sub} numberOfLines={1}>
                {email}
              </Text>
            ) : null}
          </View>
          {role ? <Badge tone="neutral">{roleLabel(role)}</Badge> : null}
        </View>

        {activeTenant && billingEnabled && creditsQ.data ? (
          <View style={styles.creditsCard}>
            <CreditsMiniCard
              c={creditsQ.data}
              canBuy={canBuy}
              onOpenBilling={() => router.push("/settings/billing")}
            />
          </View>
        ) : null}

        <SectionLabel first>Essentials</SectionLabel>
        <ListGroup>
          <Row chip label="Account" icon="user" onPress={() => router.push("/settings/account")} />
          {}
          {activeTenant ? (
            <Row
              chip
              label="Channel notifications"
              icon="bell"
              onPress={() => router.push("/settings/channel-notifications")}
            />
          ) : null}
          <Row
            chip
            label="Appearance"
            icon="sun"
            detail={appearanceLabel(preference)}
            onPress={() => router.push("/settings/appearance")}
          />
          {}
          <Row chip label="Privacy" icon="shieldCheck" onPress={() => router.push("/settings/privacy")} />
        </ListGroup>

        {}
        {activeTenant ? (
          <>
            <SectionLabel
              right={
                <Pressable
                  style={({ pressed }) => [styles.switcher, pressed && styles.switcherPressed]}
                  onPress={() => workspaceSheet.current?.present()}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Current workspace ${activeTenant.display_name}. Change workspace`}
                >
                  <WorkspaceLogo
                    website={activeTenant.website}
                    size={22}
                    fallback={
                      <View style={styles.switcherAvatar}>
                        <Text style={styles.switcherAvatarText}>{workspaceInitial(activeTenant.display_name)}</Text>
                      </View>
                    }
                  />
                  <Text style={styles.switcherText} numberOfLines={1}>
                    {activeTenant.display_name}
                  </Text>
                  <Icon name="chevron" size={20} color={colors.wire.ink} />
                </Pressable>
              }
            >
              Workspace
            </SectionLabel>
            <ListGroup>
              <Row chip label="Company" icon="building" onPress={() => router.push("/settings/company")} />
              <Row chip label="Connectors" icon="blocks" onPress={() => router.push("/toolkit")} />
              {}
              {canManage ? (
                <Row chip label="MCP" icon="bot" onPress={() => router.push("/settings/mcp")} />
              ) : null}
              <Row chip label="Members" icon="users" onPress={() => router.push("/settings/team")} />
              <Row chip label="Rules" icon="scroll" onPress={() => router.push("/settings/rules")} />
              {billingEnabled ? (
                <Row
                  chip
                  label="Billing & credits"
                  icon="card"
                  onPress={() => router.push("/settings/billing")}
                />
              ) : null}
            </ListGroup>
          </>
        ) : null}

        <SectionLabel>Help & demo</SectionLabel>
        <ListGroup>
          <Row
            chip
            label="Send feedback"
            icon="mail"
            sub="Goes straight to the Zavi team"
            onPress={() => router.push("/settings/feedback")}
          />
        </ListGroup>

        <Pressable style={styles.logout} onPress={() => setConfirmingSignOut(true)} accessibilityRole="button">
          <Icon name="logout" size={17} color={colors.red} strokeWidth={1.9} />
          <Text style={styles.logoutText}>Log out</Text>
        </Pressable>

        {}
        <Pressable
          style={styles.deleteAccount}
          onPress={() => router.push("/delete-account")}
          accessibilityRole="button"
          accessibilityLabel="Delete account"
        >
          <Text style={styles.deleteAccountText}>Delete account</Text>
        </Pressable>
      </ScrollView>

      <WorkspaceSheet ref={workspaceSheet} />
      <ConfirmDialog
        visible={confirmingSignOut}
        icon="logout"
        title="Log out?"
        message="You'll need to sign in again to get back to your workspace."
        cancelLabel="Cancel"
        confirmLabel="Log out"
        destructive
        onCancel={() => setConfirmingSignOut(false)}
        onConfirm={signOutConfirmed}
      />
    </Screen>
  );
}

function initialsFromName(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

function workspaceInitial(name: string): string {
  return name.trim()[0]?.toUpperCase() ?? "?";
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  identity: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: 2,
    marginBottom: space.xs,
  },
  identityAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.wire.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  identityInitials: {
    fontFamily: font.family.semi,
    fontSize: 16,
    lineHeight: 22,
    color: colors.onInk,
    includeFontPadding: false,
  },
  identityText: { flex: 1, minWidth: 0 },
  name: {
    fontFamily: font.family.bold,
    fontSize: 17,
    lineHeight: 22,
    color: colors.wire.ink,
    includeFontPadding: false,
  },
  sub: {
    marginTop: 4,
    fontFamily: font.family.regular,
    fontSize: font.size.md,
    lineHeight: 18,
    color: colors.wire.mute,
    includeFontPadding: false,
  },
  creditsCard: { marginTop: space.xs },
  switcher: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "66%",
    paddingLeft: 4,
    paddingRight: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.wire.line,
    backgroundColor: colors.bg,
  },
  switcherPressed: { backgroundColor: colors.soft },
  switcherAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.wire.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  switcherAvatarText: {
    fontFamily: font.family.semi,
    fontSize: 11,
    lineHeight: 14,
    color: colors.onInk,
    includeFontPadding: false,
  },
  switcherText: {
    flexShrink: 1,
    fontFamily: font.family.semi,
    fontSize: 13,
    lineHeight: 17,
    color: colors.wire.ink,
    includeFontPadding: false,
  },
  logout: {
    marginTop: space.xl,
    height: 46,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.wire.line,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  logoutText: {
    fontFamily: font.family.semi,
    fontSize: 15,
    lineHeight: 18,
    color: colors.red,
    includeFontPadding: false,
  },
  deleteAccount: { marginTop: space.sm, height: 44, alignItems: "center", justifyContent: "center" },
  deleteAccountText: {
    fontFamily: font.family.medium,
    fontSize: font.size.md,
    lineHeight: 17,
    color: colors.wire.mute,
    includeFontPadding: false,
  },
});
