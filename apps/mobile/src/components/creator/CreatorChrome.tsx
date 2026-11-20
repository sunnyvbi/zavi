import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { usePathname, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ErrorCard } from "../ErrorCard";
import { Screen, ScreenHeader } from "../Screen";
import { useAuth } from "../../auth/AuthProvider";
import { useCreatorIdentity } from "../../features/creator/hooks";
import { CREATOR_TABS, activeCreatorTab } from "../../features/creator/phase";
import type { CreatorIdentity } from "../../features/creator/identity";
import { track } from "../../lib/analytics";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const WEB = "https://www.zaviagent.com";

export function CreatorScreen({
  title,
  children,
  back,
}: {
  title: string;
  children: ReactNode;
  back?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data, isPending, isError } = useCreatorIdentity();
  const identity = data as CreatorIdentity | undefined;

  if (isPending) {
    return (
      <Screen>
        <ScreenHeader title={title} />
        <View style={styles.center}>
          <ActivityIndicator color={colors.ink} />
        </View>
      </Screen>
    );
  }

  if (isError || !identity) {
    return <Gate title={title} message="That did not load. Check your connection and try again." />;
  }
  if (identity.kind !== "creator") {
    return (
      <Gate
        title={title}
        message={identity.message}
        showWorkspace={identity.kind === "not_creator"}
        showFinishSignup={identity.kind === "blocked"}
      />
    );
  }

  const me = identity.me;
  const payoutBlocked = me.payout_country_supported === false;
  const payoutUnset = me.payout_country_supported !== false && !me.payout_account;

  return (
    <Screen>
      <ScreenHeader
        title={title}
        left={
          back ? (
            <Pressable onPress={() => router.back()} hitSlop={10} accessibilityRole="button">
              <Text style={styles.backText}>Back</Text>
            </Pressable>
          ) : undefined
        }
        right={
          <Text style={styles.who} numberOfLines={1}>
            {me.creator.display_name}
          </Text>
        }
      />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: space.xl * 2 }]}
        keyboardShouldPersistTaps="handled"
      >
        {payoutBlocked ? (
          <Note tone="warn">
            Zavi cannot pay creators in your country yet, so businesses cannot book you. Your page
            says the same thing to them. We will email you the moment that changes.
          </Note>
        ) : null}
        {payoutUnset ? (
          <Note>
            Payouts are not set up yet. You can accept work now. Set them up on Earnings before your
            first payment is due.
          </Note>
        ) : null}
        {children}
      </ScrollView>
      <CreatorTabBar bottomInset={insets.bottom} />
    </Screen>
  );
}

function CreatorTabBar({ bottomInset }: { bottomInset: number }) {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const pathname = usePathname() ?? "/creator";
  const active = activeCreatorTab(pathname);
  return (
    <View
      accessibilityRole="tablist"
      style={[styles.tabBar, { paddingBottom: Math.max(bottomInset, space.sm) }]}
    >
      {CREATOR_TABS.map((tab) => {
        const on = tab.path === active;
        return (
          <Pressable
            key={tab.path}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            onPress={() => router.replace(tab.path)}
            style={styles.tab}
          >
            <Text style={[styles.tabLabel, on ? styles.tabLabelOn : null]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Gate({
  title,
  message,
  showWorkspace,
  showFinishSignup,
}: {
  title: string;
  message: string;
  showWorkspace?: boolean;
  showFinishSignup?: boolean;
}) {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { signOut } = useAuth();
  return (
    <Screen>
      <ScreenHeader title={title} />
      <View style={styles.gate}>
        <Text style={styles.gateBody}>{message}</Text>
        {showWorkspace ? (
          <PrimaryButton label="Go to your workspace" onPress={() => router.replace("/chat")} />
        ) : null}
        {showFinishSignup ? (
          <PrimaryButton
            label="Finish your signup on zaviagent.com"
            onPress={() => {
              void Linking.openURL(`${WEB}/creators/apply`).catch(() => {});
            }}
          />
        ) : null}
        <SecondaryButton
          label="Log out"
          onPress={() => {
            track("logged_out");
            void signOut().catch(() => {});
          }}
        />
      </View>
    </Screen>
  );
}

export function DeadlineNote({ deadline }: { deadline: { line: string } | null }) {
  if (!deadline) return null;
  return <Note>{deadline.line}</Note>;
}

export function Note({
  children,
  tone = "plain",
}: {
  children: ReactNode;
  tone?: "plain" | "warn";
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={[styles.note, tone === "warn" ? styles.noteWarn : null]}>
      <Text style={[styles.noteText, tone === "warn" ? styles.noteTextWarn : null]}>{children}</Text>
    </View>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return <ErrorCard message={message} />;
}

export function Loading({ what }: { what: string }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={colors.muted} />
      <Text style={styles.loadingText}>Loading {what}.</Text>
    </View>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.emptyBox}>
      <Text style={styles.emptyText}>{children}</Text>
    </View>
  );
}

export function Card({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return <View style={styles.card}>{children}</View>;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return <Text style={styles.sectionTitle}>{children}</Text>;
}

export function KeyValue({
  label,
  value,
  strong,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvValue, strong ? styles.kvValueStrong : null]}>{value}</Text>
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.primary, disabled ? styles.buttonOff : null]}
    >
      <Text style={styles.primaryText}>{label}</Text>
    </Pressable>
  );
}

export function SecondaryButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[styles.secondary, disabled ? styles.buttonOff : null]}
    >
      <Text style={styles.secondaryText}>{label}</Text>
    </Pressable>
  );
}

export function SelfReported({ children }: { children: ReactNode }) {
  const styles = useStyles(makeStyles);
  return (
    <Text style={styles.selfReported}>
      <Text style={styles.selfReportedValue}>{children}</Text>
      <Text>  self-reported, not checked by Zavi</Text>
    </Text>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingHorizontal: space.lg, paddingTop: 20, gap: space.md },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  who: { fontSize: font.size.sm, color: colors.muted, maxWidth: 130 },
  backText: { fontSize: font.size.md, color: colors.muted },

  gate: { flex: 1, justifyContent: "center", padding: space.xl, gap: space.md },
  gateBody: { fontSize: font.size.base, lineHeight: 21, color: colors.ink },

  tabBar: {
    flexDirection: "row",
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.panel,
    paddingTop: space.sm,
  },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: space.sm },
  tabLabel: { fontSize: font.size.sm, color: colors.muted },
  tabLabelOn: { color: colors.ink, fontWeight: "700" },

  note: {
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.soft,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
  },
  noteWarn: { borderColor: colors.amber, backgroundColor: colors.warnBg },
  noteText: { fontSize: font.size.md, lineHeight: 19, color: colors.ink },
  noteTextWarn: { color: colors.amber },

  loading: { paddingVertical: space.xl, alignItems: "center", gap: space.sm },
  loadingText: { fontSize: font.size.md, color: colors.muted },

  emptyBox: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: space.lg,
  },
  emptyText: { fontSize: font.size.md, lineHeight: 20, color: colors.muted, textAlign: "center" },

  card: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: space.lg,
    backgroundColor: colors.panel,
    gap: space.sm,
  },
  sectionTitle: {
    fontSize: font.size.sm,
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    fontWeight: "700",
  },

  kv: { flexDirection: "row", justifyContent: "space-between", gap: space.md },
  kvLabel: { fontSize: font.size.md, color: colors.muted, flexShrink: 1 },
  kvValue: { fontSize: font.size.md, color: colors.ink },
  kvValueStrong: { fontWeight: "700" },

  primary: {
    backgroundColor: colors.ink,
    borderRadius: radius.pill,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: "center",
  },
  primaryText: { color: colors.onInk, fontSize: font.size.base, fontWeight: "700" },
  secondary: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.pill,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: "center",
  },
  secondaryText: { color: colors.ink, fontSize: font.size.base, fontWeight: "700" },
  buttonOff: { opacity: 0.45 },

  selfReported: { fontSize: font.size.sm, color: colors.muted },
  selfReportedValue: { fontSize: font.size.base, color: colors.ink, fontWeight: "700" },
});
