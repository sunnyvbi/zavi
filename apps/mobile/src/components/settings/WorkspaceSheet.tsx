import { forwardRef, useCallback, useEffect, useState } from "react";
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
} from "@gorhom/bottom-sheet";
import { useBackClosesSheet } from "../AppBottomSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Icon } from "../Icon";
import { Avatar } from "../Avatar";
import { WorkspaceLogo } from "../WorkspaceLogo";
import { ZaviBorder } from "../ZaviTextField";
import { useWorkspace } from "../../features/workspaces/WorkspaceProvider";
import { useOnboarding } from "../../features/onboarding/OnboardingProvider";
import { track } from "../../lib/analytics";
import { ADD_WORKSPACE_ENABLED } from "../../lib/flags";
import { useReduceMotion } from "../../lib/motion";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";
import { ErrorCard, friendlyError } from "../ErrorCard";

export const WorkspaceSheet = forwardRef<BottomSheetModal>(function WorkspaceSheet(_props, ref) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { tenants, activeTenantId, switchTo } = useWorkspace();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const router = useRouter();
  const { startAddWorkspace } = useOnboarding();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pending) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => true);
    return () => sub.remove();
  }, [pending]);

  const renderBackdrop = useCallback(
    (p: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior={pending ? "none" : "close"} />
    ),
    [pending],
  );

  const close = () => {
    if (ref && typeof ref !== "function") ref.current?.dismiss();
  };

  function addWorkspace() {
    if (pending) return;
    track("workspace_add_started");
    close();
    startAddWorkspace();
    router.push("/(onboarding)/website");
  }

  async function pick(tenantId: string) {
    if (pending) return;
    if (tenantId === activeTenantId) {
      close();
      return;
    }
    setError(null);
    setPending(tenantId);
    try {
      await switchTo(tenantId);
      close();
    } catch (e) {
      setError(friendlyError(e, "Couldn't switch workspace. Try again."));
    } finally {
      setPending(null);
    }
  }

  const onSheetChange = useBackClosesSheet();
  return (
    <BottomSheetModal
      ref={ref}
      onChange={onSheetChange}
      enableDynamicSizing
      maxDynamicContentSize={560}
      enablePanDownToClose={!pending}
      animateOnMount={!reduceMotion}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBg}
      handleStyle={styles.handle}
      handleIndicatorStyle={styles.handleIndicator}
      onDismiss={() => setError(null)}
    >
      <BottomSheetScrollView
        contentContainerStyle={[styles.content, { paddingBottom: 20 + insets.bottom }]}
      >
        <Text style={styles.title}>Switch workspace</Text>
        <Text style={styles.sub}>Company, team and billing follow the workspace you pick.</Text>
        <View style={styles.list}>
          {tenants.map((t) => {
            const active = t.tenant_id === activeTenantId;
            const busy = pending === t.tenant_id;
            return (
              <ZaviBorder key={t.tenant_id} selected={active} radius={radius.lg}>
                <Pressable
                  style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
                  onPress={() => void pick(t.tenant_id)}
                  disabled={!!pending && !busy}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active, busy }}
                  accessibilityLabel={
                    active ? `${t.display_name}, current workspace` : `Switch to ${t.display_name}`
                  }
                >
                  <WorkspaceLogo
                    website={t.website}
                    size={34}
                    fallback={<Avatar slug={t.slug} name={t.display_name} size={34} bg={colors.soft} />}
                  />
                  <View style={styles.itemText}>
                    <Text style={styles.itemName} numberOfLines={1}>
                      {t.display_name}
                    </Text>
                    <Text style={styles.itemRole} numberOfLines={1}>
                      {roleLabel(t.role)}
                    </Text>
                  </View>
                  {busy ? (
                    <ActivityIndicator size="small" color={colors.muted} />
                  ) : active ? (
                    <Icon name="tick" size={18} color={colors.status.tick} />
                  ) : null}
                </Pressable>
              </ZaviBorder>
            );
          })}
        </View>
        {error ? <ErrorCard message={error} /> : null}
        {ADD_WORKSPACE_ENABLED ? (
          <Pressable
            style={({ pressed }) => [styles.add, pressed && styles.itemPressed]}
            onPress={addWorkspace}
            disabled={!!pending}
            accessibilityRole="button"
          >
            <View style={styles.addIcon}>
              <Icon name="plus" size={18} color={colors.ink} />
            </View>
            <Text style={styles.addText}>Add new workspace</Text>
          </Pressable>
        ) : null}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
});

export function roleLabel(role: string): string {
  if (!role) return "Member";
  return role.charAt(0).toUpperCase() + role.slice(1);
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  sheetBg: {
    backgroundColor: colors.surfaceRaised,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  handle: { paddingTop: space.lg, paddingBottom: space.md },
  handleIndicator: { width: 36, height: 5, borderRadius: radius.pill, backgroundColor: colors.borderRaised },
  content: { paddingHorizontal: space.lg },
  title: {
    fontFamily: font.family.semi,
    fontSize: 20,
    lineHeight: 26,
    includeFontPadding: false,
    color: colors.ink,
  },
  sub: {
    marginTop: 6,
    fontFamily: font.family.regular,
    fontSize: 14,
    lineHeight: 20,
    includeFontPadding: false,
    color: colors.textSecondary,
  },
  list: { marginTop: 20, gap: space.md },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 64,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  itemPressed: { backgroundColor: colors.soft },
  itemText: { flex: 1, minWidth: 0 },
  itemName: {
    fontFamily: font.family.semi,
    fontSize: 14,
    lineHeight: 18,
    includeFontPadding: false,
    color: colors.ink,
  },
  itemRole: {
    marginTop: 2,
    fontFamily: font.family.medium,
    fontSize: 12,
    lineHeight: 16,
    includeFontPadding: false,
    color: colors.muted,
  },
  add: {
    marginTop: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 64,
    paddingHorizontal: space.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.line,
    borderRadius: radius.lg,
  },
  addIcon: {
    width: 34,
    height: 34,
    borderRadius: radius.md,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  addText: { fontFamily: font.family.semi, fontSize: font.size.base, lineHeight: 20, includeFontPadding: false, color: colors.ink },
});
