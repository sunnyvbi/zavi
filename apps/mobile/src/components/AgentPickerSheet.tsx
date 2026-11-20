import { forwardRef, useCallback, useState, type ReactNode } from "react";
import { Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from "@gorhom/bottom-sheet";
import { useBackClosesSheet } from "./AppBottomSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { showDialog } from "./DialogHost";
import { Icon } from "./Icon";
import { SkeletonBlock } from "./Skeleton";
import { hintText } from "./ZaviTextField";
import { ZaviGlance } from "./ZaviGlance";
import { ChannelLogo } from "./channels/ChannelGlyph";
import { planName } from "./billing/CurrentPlanCard";
import { CardButton } from "./reply/ui";
import { useAgents } from "../features/agents/hooks";
import { GROWTH_SLUG, customAgentRows } from "../features/agents/pickerAgents";
import { planName as channelPlanName, waitingLabel, type ListRow } from "../features/channels/channelList";
import { channelAgentSlug } from "../features/channels/display";
import { useChannelList } from "../features/channels/hooks";
import { useCanManage } from "../features/settings/api";
import { isBillingEnabled, useSignupAvailability } from "../auth/signup";
import { CHANNELS_ENABLED } from "../lib/flags";
import { useReduceMotion } from "../lib/motion";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

const OPERATOR = "operator";

export type ChatTopic = { slug: string; channel?: string };

export const AgentPickerSheet = forwardRef<
  BottomSheetModal,
  {
    current: ChatTopic;
    onPick: (topic: ChatTopic) => void;
  }
>(function AgentPickerSheet({ current, onPick }, ref) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const router = useRouter();
  const canManage = useCanManage();
  const billingEnabled = isBillingEnabled(useSignupAvailability().data);
  const agents = useAgents();
  const channels = useChannelList();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = (...texts: (string | null | undefined)[]) =>
    !needle || texts.some((t) => t?.toLowerCase().includes(needle));

  const channelRows = CHANNELS_ENABLED
    ? channels.rowsFor().filter((r) => !r.comingSoon && matches(r.name, r.description))
    : [];
  const builtRows = agents.data ? customAgentRows(agents.data).filter((a) => matches(a.name)) : [];
  const showAnything = matches("Anything", "Zavi");
  const showGrowth = matches("Growth strategy", "Chief Growth Officer");
  const channelsLoading = channels.isLoading || (channels.isError && channels.isRefetching);
  const nothing =
    !showAnything && !showGrowth && channelRows.length === 0 && builtRows.length === 0 && !channelsLoading;

  const dismiss = useCallback(() => {
    if (ref && typeof ref !== "function") ref.current?.dismiss();
  }, [ref]);

  const renderBackdrop = useCallback(
    (p: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
    ),
    [],
  );

  const isCurrent = (t: ChatTopic) => t.slug === current.slug && (t.channel ?? null) === (current.channel ?? null);

  function pick(topic: ChatTopic) {
    dismiss();
    onPick(topic);
  }

  function openLocked(row: ListRow) {
    const plan = channelPlanName(row.planTier);
    if (!plan) return;
    dismiss();
    if (canManage && billingEnabled) router.push("/settings/billing");
    else if (billingEnabled) void showDialog({ title: `Needs ${plan} plan`, message: `Ask an owner or admin to upgrade to ${plan} to open ${row.name}.` });
    else void showDialog({ title: `Needs ${plan} plan`, message: `${row.name} isn't included in your plan.` });
  }

  const onSheetChange = useBackClosesSheet();
  return (
    <BottomSheetModal
      ref={ref}
      onChange={onSheetChange}
      snapPoints={["80%"]}
      enableDynamicSizing={false}
      enablePanDownToClose
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      animateOnMount={!reduceMotion}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBg}
      handleIndicatorStyle={styles.grabber}
      onAnimate={(_from, to) => {
        if (to === -1) Keyboard.dismiss();
      }}
      onDismiss={() => setQuery("")}
    >
      <View style={styles.body}>
        <View style={styles.top}>
          <View style={styles.head}>
            <Text style={styles.title}>Talk about</Text>
            <Pressable
              style={({ pressed }) => [styles.close, pressed && styles.pressed]}
              onPress={dismiss}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Close"
            >
              <Icon name="close" size={18} color={colors.ink} strokeWidth={2} />
            </Pressable>
          </View>

          <View style={styles.searchBox}>
            <Icon name="search" size={18} color={colors.muted} strokeWidth={2} />
            <BottomSheetTextInput
              value={query}
              onChangeText={setQuery}
              placeholder={hintText("Search topics")}
              placeholderTextColor={colors.muted}
              keyboardAppearance={keyboardAppearance}
              cursorColor={colors.ink}
              selectionColor={textSelectionColor}
              selectionHandleColor={colors.ink}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={styles.searchInput}
            />
          </View>
        </View>

        <BottomSheetScrollView
          style={styles.list}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: space.lg + insets.bottom }}
          keyboardShouldPersistTaps="handled"
        >
          {showAnything ? (
            <TopicRow
              lead
              icon={
                <View style={[styles.leadIcon, isCurrent({ slug: OPERATOR }) && styles.leadIconCurrent]}>
                  <ZaviGlance size={44} />
                </View>
              }
              name="Anything"
              blurb="Ask Zavi about your business. It brings in the right help on its own."
              current={isCurrent({ slug: OPERATOR })}
              onPress={() => pick({ slug: OPERATOR })}
            />
          ) : null}
          {showGrowth ? (
            <TopicRow
              icon={
                <View style={styles.letterIcon}>
                  <Icon name="trending" size={16} color={colors.ink} strokeWidth={2} />
                </View>
              }
              name="Growth strategy"
              blurb="Your plan, the real constraint, the channels to bet on."
              current={isCurrent({ slug: GROWTH_SLUG })}
              onPress={() => pick({ slug: GROWTH_SLUG })}
            />
          ) : null}

          {CHANNELS_ENABLED && (channelsLoading || channels.isError || channelRows.length > 0) ? (
            <Text style={styles.section}>Your channels</Text>
          ) : null}
          {!CHANNELS_ENABLED ? null : channelsLoading ? (
            [0, 1, 2].map((i) => (
              <View key={i} style={styles.row} accessibilityLabel="Loading">
                <SkeletonBlock width={32} height={32} radius={16} />
                <SkeletonBlock width={160} height={14} />
              </View>
            ))
          ) : channels.isError ? (
            <View style={styles.state}>
              <Text style={styles.muted}>Couldn't load your channels.</Text>
              <CardButton label="Retry" variant="secondary" onPress={() => void channels.refetch()} />
            </View>
          ) : (
            channelRows.map((r) => {
              const topic = { slug: channelAgentSlug(r.slug), channel: r.slug };
              const plan = channelPlanName(r.planTier);
              return (
                <TopicRow
                  key={r.slug}
                  icon={<ChannelLogo slug={r.slug} size={32} />}
                  name={r.name}
                  lockedPlan={plan}
                  newCount={plan ? 0 : r.unseen}
                  current={isCurrent(topic)}
                  onPress={() => (plan ? openLocked(r) : pick(topic))}
                />
              );
            })
          )}

          {builtRows.length > 0 ? <Text style={styles.section}>Agents you built</Text> : null}
          {builtRows.map((a) => (
            <TopicRow
              key={a.slug}
              icon={
                <View style={styles.letterIcon}>
                  <Text style={styles.letter}>{a.name.charAt(0).toUpperCase()}</Text>
                </View>
              }
              name={a.name}
              lockedPlan={a.lockedTier ? planName(a.lockedTier) : null}
              locksRow
              current={isCurrent({ slug: a.slug })}
              onPress={() => pick({ slug: a.slug })}
            />
          ))}

          {nothing ? (
            <View style={styles.empty}>
              <View style={styles.emptyIcon}>
                <Icon name="search" size={22} color={colors.muted} strokeWidth={2} />
              </View>
              <Text style={styles.emptyTitle}>Nothing found</Text>
              <Text style={styles.emptyText}>{`Nothing matches "${query.trim()}". Try a different word.`}</Text>
              <CardButton label="Clear search" variant="secondary" onPress={() => setQuery("")} />
            </View>
          ) : null}
        </BottomSheetScrollView>
      </View>
    </BottomSheetModal>
  );
});

function TopicRow({
  icon,
  name,
  blurb = null,
  lead = false,
  current,
  lockedPlan = null,
  locksRow = false,
  newCount = 0,
  onPress,
}: {
  icon: ReactNode;
  name: string;
  blurb?: string | null;
  lead?: boolean;
  current: boolean;
  lockedPlan?: string | null;
  locksRow?: boolean;
  newCount?: number;
  onPress: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const disabled = locksRow && !!lockedPlan;
  return (
    <>
      <Pressable
        style={({ pressed }) => [
          lead ? styles.leadRow : styles.row,
          lead && current && styles.leadCurrent,
          pressed && !disabled && styles.rowPressed,
          lockedPlan && styles.locked,
        ]}
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ selected: current, disabled }}
        accessibilityLabel={
          lockedPlan ? `${name}, needs the ${lockedPlan} plan` : newCount > 0 ? `${name}, ${newCount} new` : name
        }
      >
        {icon}
        <View style={styles.rowText}>
          <Text style={lead ? styles.leadName : styles.name} numberOfLines={1}>
            {name}
          </Text>
          {blurb ? (
            <Text style={styles.blurb} numberOfLines={lead ? undefined : 1}>
              {blurb}
            </Text>
          ) : null}
        </View>
        {lockedPlan ? (
          <View style={styles.badge}>
            <Icon name="lock" size={12} color={colors.muted} />
            <Text style={styles.badgeText}>{`${lockedPlan} plan`}</Text>
          </View>
        ) : current && lead ? (
          <View style={styles.leadTick}>
            <Icon name="tick" size={12} color={colors.onAccent} strokeWidth={2.6} />
          </View>
        ) : current ? (
          <Icon name="tick" size={16} color={colors.green} strokeWidth={2} />
        ) : newCount > 0 ? (
          <View style={styles.newPill}>
            <View style={styles.newDot} />
            <Text style={styles.newText}>{`${waitingLabel(newCount)} new`}</Text>
          </View>
        ) : null}
      </Pressable>
      {lead ? null : <View style={styles.divider} />}
    </>
  );
}

const makeStyles = (colors: Colors, dark: boolean) => StyleSheet.create({
  sheetBg: { backgroundColor: colors.surfaceRaised, borderRadius: 20 },
  grabber: { width: 30, height: 4, backgroundColor: colors.borderRaised },
  body: { flex: 1 },
  top: { paddingHorizontal: 16, paddingTop: space.xs },
  list: { flex: 1 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    height: 46,
    marginTop: space.sm,
    marginBottom: space.xs,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.soft,
  },
  searchInput: {
    flex: 1,
    padding: 0,
    fontSize: 15,
    lineHeight: 20,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    color: colors.ink,
  },
  head: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    marginTop: space.xs,
    marginBottom: 15,
  },
  title: {
    flex: 1,
    fontSize: font.size.title,
    fontFamily: font.family.semi,
    includeFontPadding: false,
    letterSpacing: -0.5,
    color: colors.ink,
  },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.7 },
  leadRow: {
    marginBottom: space.xs,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  leadCurrent: {
    backgroundColor: colors.status.greenBg,
    borderColor: dark ? colors.greenFill : colors.avatarGreen,
    shadowColor: colors.greenFill,
    shadowOpacity: dark ? 0.45 : 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  leadIcon: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: dark ? colors.surfaceRaised : colors.avatarGreen,
    borderWidth: 1,
    borderColor: dark ? colors.borderRaised : colors.avatarGreen,
    alignItems: "center",
    justifyContent: "center",
  },
  leadIconCurrent: { borderColor: colors.greenFill, borderWidth: 1.5 },
  leadTick: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: colors.greenFill,
    alignItems: "center",
    justifyContent: "center",
  },
  leadName: { fontSize: 17, fontFamily: font.family.semi, includeFontPadding: false, color: colors.ink },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.lg,
    paddingHorizontal: space.xs,
  },
  divider: { height: 1, backgroundColor: colors.line },
  letterIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  letter: { fontSize: font.size.base, fontFamily: font.family.semi, includeFontPadding: false, color: colors.muted },
  rowPressed: { backgroundColor: colors.soft },
  locked: { opacity: 0.55 },
  rowText: { flex: 1, minWidth: 0, gap: 5 },
  name: { fontSize: font.size.base, fontFamily: font.family.semi, includeFontPadding: false, color: colors.ink },
  section: {
    marginTop: space.lg,
    fontSize: font.size.md,
    fontFamily: font.family.semi,
    includeFontPadding: false,
    color: colors.ink,
  },
  small: {
    marginBottom: space.xs,
    fontSize: font.size.sm,
    lineHeight: 17,
    fontFamily: font.family.regular,
    includeFontPadding: false,
    color: colors.muted,
  },
  blurb: { fontSize: font.size.sm, lineHeight: 18, fontFamily: font.family.regular, includeFontPadding: false, color: colors.textSecondary },
  muted: { fontSize: font.size.base, fontFamily: font.family.regular, includeFontPadding: false, color: colors.muted },
  empty: { alignItems: "center", gap: space.sm, paddingVertical: space.xl, paddingHorizontal: space.lg },
  emptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.xs,
  },
  emptyTitle: { fontSize: 16, lineHeight: 22, fontFamily: font.family.semi, includeFontPadding: false, color: colors.ink },
  emptyText: {
    marginBottom: space.sm,
    textAlign: "center",
    fontSize: font.size.md,
    lineHeight: 18,
    fontFamily: font.family.regular,
    includeFontPadding: false,
    color: colors.textSecondary,
  },
  state: { alignItems: "flex-start", gap: space.sm, paddingVertical: space.lg, paddingHorizontal: space.xs },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.soft,
  },
  newPill: { flexDirection: "row", alignItems: "center", gap: 5 },
  newDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.status.greenText },
  newText: { fontSize: font.size.xs, fontFamily: font.family.semi, includeFontPadding: false, color: colors.status.greenText },
  badgeText: { fontSize: font.size.xs, fontFamily: font.family.semi, includeFontPadding: false, color: colors.muted },
});
