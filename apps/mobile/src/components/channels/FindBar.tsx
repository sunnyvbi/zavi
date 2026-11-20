import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { AppBottomSheet } from "../AppBottomSheet";
import { Icon } from "../Icon";
import { OptionSheet } from "../OptionSheet";
import { hintText } from "../ZaviTextField";
import { ChannelLogo } from "./ChannelGlyph";
import { platformChannel } from "../../features/channels/creatorProfile";
import {
  NO_FILTERS,
  activeCount,
  pillLabel,
  type CreatorFilterLabels,
  type CreatorFilterOptions,
  type FilterOption,
  type FindFilters,
} from "../../features/channels/ugc";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

type Pick = "price" | "days" | "followers" | "country" | "order" | null;

export function FindBar({
  value: f,
  onChange,
  keywordDraft,
  onKeywordDraft,
  onSearch,
  options,
  labels,
  orders,
}: {
  value: FindFilters;
  onChange: (next: FindFilters) => void;
  keywordDraft: string;
  onKeywordDraft: (v: string) => void;
  onSearch: () => void;
  options: CreatorFilterOptions | null;
  labels: CreatorFilterLabels | null;
  orders: FilterOption[];
}) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor } = useTheme();
  const [platformOpen, setPlatformOpen] = useState(false);
  const [pick, setPick] = useState<Pick>(null);
  const [nichesOpen, setNichesOpen] = useState(false);
  const set = (patch: Partial<FindFilters>) => onChange({ ...f, ...patch });
  const platformName = f.platform ? options?.platforms.find((p) => p.value === f.platform)?.label ?? f.platform : labels?.platforms.any ?? "Any platform";
  const any = activeCount(f) > 0 || keywordDraft.trim() !== "";
  const toggleNiche = (n: string) => set({ niches: f.niches.includes(n) ? f.niches.filter((x) => x !== n) : [...f.niches, n] });

  const pills: Array<{ key: Exclude<Pick, null>; name: string; any: string; list: FilterOption<string | number>[]; value: string | number | null }> = labels && options
    ? [
        { key: "price", name: labels.max_price_cents.name, any: labels.max_price_cents.any, list: options.max_price_cents, value: f.maxPriceCents },
        { key: "days", name: labels.max_delivery_days.name, any: labels.max_delivery_days.any, list: options.max_delivery_days, value: f.maxDeliveryDays },
        { key: "followers", name: labels.min_followers.name, any: labels.min_followers.any, list: options.min_followers, value: f.minFollowers },
        { key: "country", name: labels.countries.name, any: labels.countries.any, list: options.countries, value: f.country || null },
      ].filter((p) => p.list.length > 0)
    : [];
  const open = pills.find((p) => p.key === pick) ?? null;

  function choose(key: Exclude<Pick, null>, v: string | number | null) {
    if (key === "price") set({ maxPriceCents: v === null ? null : Number(v) });
    else if (key === "days") set({ maxDeliveryDays: v === null ? null : Number(v) });
    else if (key === "followers") set({ minFollowers: v === null ? null : Number(v) });
    else if (key === "country") set({ country: v === null ? "" : String(v) });
  }

  return (
    <View style={styles.wrap}>
      <View style={styles.bar}>
        <View style={styles.platform}>
          <Pressable style={({ pressed }) => [styles.platformMain, pressed && styles.pressed]} onPress={() => setPlatformOpen(true)} accessibilityRole="button" accessibilityLabel={`${labels?.platforms.name ?? "Platform"}: ${platformName}`}>
            <View style={styles.segText}>
              <Text style={styles.segLabel}>{labels?.platforms.name ?? "Platform"}</Text>
              <View style={styles.platformValue}>
                {f.platform && platformChannel(f.platform) ? <ChannelLogo slug={platformChannel(f.platform) as string} size={22} /> : null}
                <Text style={[styles.segValue, f.platform ? styles.segValueOn : null]} numberOfLines={1}>
                  {platformName}
                </Text>
              </View>
            </View>
            {f.platform ? null : <Icon name="chevronDown" size={14} color={colors.muted} />}
          </Pressable>
          {f.platform ? (
            <Pressable style={({ pressed }) => [styles.clearKeyword, pressed && styles.pressed]} onPress={() => set({ platform: "" })} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Clear ${platformName}`}>
              <Icon name="close" size={14} color={colors.ink} strokeWidth={2} />
            </Pressable>
          ) : null}
        </View>
        <View style={styles.divider} />
        <View style={styles.keyword}>
          <View style={styles.segText}>
            <Text style={styles.segLabel}>{labels?.keyword.name ?? "Keyword or niche"}</Text>
            <TextInput
              value={keywordDraft}
              onChangeText={onKeywordDraft}
              onPressIn={() => setNichesOpen(true)}
              onSubmitEditing={() => {
                setNichesOpen(false);
                onSearch();
              }}
              placeholder={hintText(labels?.keyword.placeholder ?? "Search names, handles, niches or packages")}
              placeholderTextColor={colors.muted}
              cursorColor={colors.ink}
              selectionColor={textSelectionColor}
              selectionHandleColor={colors.ink}
              autoCorrect={false}
              autoFocus={false}
              returnKeyType="search"
              accessibilityLabel={labels?.keyword.name ?? "Search creators"}
              style={styles.keywordInput}
            />
          </View>
          {keywordDraft.length > 0 ? (
            <Pressable
              style={({ pressed }) => [styles.clearKeyword, pressed && styles.pressed]}
              onPress={() => {
                onKeywordDraft("");
                onSearch();
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
            >
              <Icon name="close" size={14} color={colors.ink} strokeWidth={2} />
            </Pressable>
          ) : null}
        </View>
      </View>

      {nichesOpen && options && options.niches.length > 0 ? (
        <View style={styles.nicheRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bleedLeft} contentContainerStyle={styles.nicheScroll} keyboardShouldPersistTaps="handled" accessibilityLabel={labels?.niches.name ?? "Niches"}>
            {options.niches.map((n) => {
              const on = f.niches.includes(n.value);
              return (
                <Pressable key={n.value} style={[styles.niche, on && styles.nicheOn]} onPress={() => toggleNiche(n.value)} accessibilityRole="button" accessibilityState={{ selected: on }}>
                  {on ? <Icon name="tick" size={12} color={colors.onInk} /> : null}
                  <Text style={[styles.nicheText, on && styles.nicheTextOn]}>{n.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
          <Pressable
            style={styles.nicheClose}
            onPress={() => (f.niches.length > 0 ? set({ niches: [] }) : setNichesOpen(false))}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={f.niches.length > 0 ? "Clear selected niches" : "Hide niches"}
          >
            <Icon name="close" size={14} color={colors.ink} strokeWidth={2} />
          </Pressable>
        </View>
      ) : null}

      {pills.length > 0 || orders.length > 0 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.bleed} contentContainerStyle={styles.pills} keyboardShouldPersistTaps="handled">
          {pills.map((p) => {
            const on = p.value !== null;
            return (
              <Pressable key={p.key} style={[styles.pill, on && styles.pillOn]} onPress={() => setPick(p.key)} accessibilityRole="button" accessibilityLabel={`${p.name}: ${pillLabel(p.list, p.value, p.any)}`}>
                <Text style={[styles.pillText, on && styles.pillTextOn]} numberOfLines={1}>
                  {pillLabel(p.list, p.value, p.name)}
                </Text>
                <Icon name="chevronDown" size={12} color={on ? colors.onInk : colors.muted} />
              </Pressable>
            );
          })}
          {orders.length > 0 ? (
            <Pressable style={styles.pill} onPress={() => setPick("order")} accessibilityRole="button" accessibilityLabel={`${labels?.order.name ?? "Sort"}: ${pillLabel(orders, f.order, "Sort")}`}>
              <Text style={styles.pillText}>{pillLabel(orders, f.order, labels?.order.name ?? "Sort")}</Text>
              <Icon name="chevronDown" size={12} color={colors.muted} />
            </Pressable>
          ) : null}
          {any ? (
            <Pressable
              onPress={() => {
                onKeywordDraft("");
                onChange({ ...NO_FILTERS, order: f.order });
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Clear all filters"
              style={styles.clear}
            >
              <Text style={styles.clearText}>Clear all</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      ) : null}

      {f.niches.length > 0 && !nichesOpen ? (
        <View style={styles.chosen}>
          {f.niches.map((n) => (
            <Pressable key={n} style={styles.chosenChip} onPress={() => toggleNiche(n)} accessibilityRole="button" accessibilityLabel={`Remove ${n}`}>
              <Text style={styles.chosenText}>{n}</Text>
              <Icon name="close" size={11} color={colors.ink} strokeWidth={2} />
            </Pressable>
          ))}
        </View>
      ) : null}

      <AppBottomSheet open={platformOpen} onClose={() => setPlatformOpen(false)} title={labels?.platforms.name ?? "Platform"}>
        <View style={styles.grid}>
          {(options?.platforms ?? []).map((p) => {
            const on = f.platform === p.value;
            const channel = platformChannel(p.value);
            return (
              <Pressable
                key={p.value}
                style={[styles.tile, on && styles.tileOn]}
                onPress={() => {
                  set({ platform: on ? "" : p.value });
                  setPlatformOpen(false);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
              >
                {channel ? <ChannelLogo slug={channel} size={28} /> : null}
                <Text style={styles.tileText}>{p.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Pressable
          style={styles.anyButton}
          onPress={() => {
            set({ platform: "" });
            setPlatformOpen(false);
          }}
          accessibilityRole="button"
        >
          <Text style={styles.anyText}>{labels?.platforms.any ?? "Any platform"}</Text>
        </Pressable>
      </AppBottomSheet>

      <OptionSheet<string | number | null>
        open={!!open}
        title={open?.name ?? ""}
        message={open?.key === "followers" ? labels?.min_followers.note : undefined}
        options={open ? [{ value: null, label: open.any }, ...open.list.map((o) => ({ value: o.value as string | number | null, label: o.label }))] : []}
        value={open?.value ?? null}
        onPick={(v) => open && choose(open.key, v)}
        onClose={() => setPick(null)}
      />
      <OptionSheet<string>
        open={pick === "order"}
        title={labels?.order.name ?? "Sort"}
        options={orders.map((o) => ({ value: o.value, label: o.label }))}
        value={String(f.order)}
        onPick={(v) => set({ order: v })}
        onClose={() => setPick(null)}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    wrap: { paddingTop: space.md, gap: space.sm },
    bar: { borderWidth: 1, borderColor: colors.line, borderRadius: 22, backgroundColor: colors.bg, overflow: "hidden" },
    platform: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 56, paddingLeft: 16, paddingRight: 14 },
    platformMain: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, minHeight: 56 },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line, marginHorizontal: 12 },
    keyword: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 56, paddingLeft: 16, paddingRight: 14 },
    segText: { flex: 1, minWidth: 0, gap: 1 },
    segLabel: { fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
    segValue: { flexShrink: 1, fontFamily: font.family.regular, fontSize: 14, color: colors.muted },
    segValueOn: { fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
    platformValue: { flexDirection: "row", alignItems: "center", gap: 8 },
    keywordInput: { padding: 0, minHeight: 20, fontFamily: font.family.medium, fontSize: 15, color: colors.ink },
    clearKeyword: { width: 28, height: 28, alignItems: "center", justifyContent: "center", borderRadius: 14, backgroundColor: colors.soft },
    pressed: { opacity: 0.7 },
    bleed: { marginHorizontal: -space.lg },
    bleedLeft: { marginLeft: -space.lg },
    nicheRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
    nicheScroll: { gap: 8, paddingLeft: space.lg, paddingRight: space.sm },
    nicheClose: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 16, backgroundColor: colors.soft },
    niche: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 34, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.soft },
    nicheOn: { backgroundColor: colors.ink },
    nicheText: { fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    nicheTextOn: { color: colors.onInk },
    pills: { gap: 8, alignItems: "center", paddingHorizontal: space.lg },
    pill: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg },
    pillOn: { backgroundColor: colors.ink, borderColor: colors.ink },
    pillText: { maxWidth: 190, fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    pillTextOn: { color: colors.onInk },
    clear: { paddingHorizontal: 6, minHeight: 36, justifyContent: "center" },
    clearText: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink, textDecorationLine: "underline" },
    chosen: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    chosenChip: { flexDirection: "row", alignItems: "center", gap: 5, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, backgroundColor: colors.soft },
    chosenText: { fontFamily: font.family.medium, fontSize: 12, color: colors.ink },
    grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
    tile: { width: "30%", flexGrow: 1, alignItems: "center", gap: 8, paddingVertical: 14, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    tileOn: { borderColor: colors.ink, backgroundColor: colors.soft },
    tileText: { fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    anyButton: { marginTop: space.md, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md, backgroundColor: colors.soft },
    anyText: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
  });
