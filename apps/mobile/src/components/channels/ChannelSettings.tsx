import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { StateLine } from "./UgcParts";
import { OptionSheet } from "../OptionSheet";
import { Icon } from "../Icon";
import { TextLink } from "../growth/StoryKit";
import { FocusRing } from "../ZaviTextField";
import { apiFetch } from "../../lib/api";
import {
  addItem,
  canEditSettings,
  emptyListText,
  firstItem,
  OWNER_ADMIN_ONLY,
  saveNote,
  toggleOn,
  visibleItems,
  type ListField,
  type SettingItem,
} from "../../features/channels/channelSettings";
import { useChannelSettings, useSaveSetting } from "../../features/channels/ugcHooks";
import { useMyRole } from "../../features/settings/api";
import { elsewhereText, type AnySettingField } from "../../features/channels/settingsConfig";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const DEFAULT_NOTE = "Applies on the next run. Nothing changes in your account until you approve an action.";

export function ChannelSettings({ slug, fields, onSaved }: { slug: string; fields: AnySettingField[]; onSaved?: () => void }) {
  const styles = useStyles(makeStyles);
  const q = useChannelSettings(slug);
  const save = useSaveSetting(slug);
  const canEdit = canEditSettings(useMyRole());
  const [values, setValues] = useState<Record<string, SettingItem[]>>({});
  const [dirty, setDirty] = useState<string[]>([]);
  const [note, setNote] = useState(DEFAULT_NOTE);
  const [fresh, setFresh] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState<string | null>(null);

  useEffect(() => {
    if (!q.data) return;
    setValues((v) => {
      const next = { ...v };
      for (const f of fields) if (!dirty.includes(f.id)) next[f.id] = q.data[f.id] ?? [];
      return next;
    });
  }, [q.data, dirty, fields]);

  function edit(id: string, items: SettingItem[]) {
    setValues((v) => ({ ...v, [id]: items }));
    setDirty((d) => (d.includes(id) ? d : [...d, id]));
    setNote(DEFAULT_NOTE);
  }

  async function saveAll() {
    const changed = dirty;
    const failed: string[] = [];
    const statuses: Array<number | null> = [];
    for (const id of changed) {
      try {
        await save.mutateAsync({ fieldId: id, items: values[id] ?? [] });
      } catch (e) {
        failed.push(id);
        const status = (e as { status?: unknown } | null)?.status;
        statuses.push(typeof status === "number" ? status : null);
      }
    }
    setDirty(failed);
    setNote(saveNote(statuses, changed.length));
    if (failed.length === 0) onSaved?.();
  }

  async function suggest(endpoint: string) {
    setSuggesting(endpoint);
    try {
      const res = await apiFetch(endpoint, { method: "POST", retryOnNetworkError: false });
      if (!res.ok) throw new Error(String(res.status));
      setDirty([]);
      await q.refetch();
      setFresh((f) => (f.includes(endpoint) ? f : [...f, endpoint]));
      setNote("Zavi added what it found. Suggested rows are marked.");
    } catch {
      setNote("Zavi couldn't draft suggestions right now. Try again in a minute.");
    } finally {
      setSuggesting(null);
    }
  }

  const ordered = [...fields.filter((f) => f.kind === "list"), ...fields.filter((f) => f.kind !== "list")];

  if (!q.data) {
    return (
      <View style={styles.content}>
        <Text style={styles.sub}>What this channel is pointed at. Changes apply on the next run.</Text>
        {q.isError ? (
          <Text style={styles.box}>Settings for this channel aren't available yet. Nothing is lost — the channel keeps running on what it already has.</Text>
        ) : (
          <StateLine loading={q.isLoading} error={false} onRetry={() => void q.refetch()} />
        )}
      </View>
    );
  }

  return (
    <View style={styles.content}>
      <Text style={styles.sub}>What this channel is pointed at. Changes apply on the next run.</Text>
      {ordered.map((f) => {
        const items = values[f.id] ?? [];
        if (f.kind === "choice") {
          const current = firstItem(items) ?? "";
          return (
            <View key={f.id} style={styles.card}>
              <Text style={styles.label}>{f.label}</Text>
              <Text style={styles.sub}>{f.help}</Text>
              <View style={styles.options}>
                {f.options.map((o) => {
                  const on = current === o.value;
                  return (
                    <Pressable
                      key={o.value}
                      style={[styles.option, on && styles.optionOn]}
                      onPress={() => edit(f.id, [{ item: o.value }])}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                    >
                      <Text style={[styles.optionText, on && styles.optionTextOn]}>{o.label}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>
          );
        }
        if (f.kind === "number" || f.kind === "text") {
          const readOnly = elsewhereText(f);
          return (
            <ValueCard
              key={f.id}
              field={f}
              value={firstItem(items) ?? ""}
              readOnly={readOnly}
              onChange={(v) => edit(f.id, v.trim() ? [{ item: v }] : [])}
            />
          );
        }
        if (f.kind === "toggle") {
          const on = toggleOn(items);
          return (
            <View key={f.id} style={styles.card}>
              <View style={styles.toggleRow}>
                <View style={styles.flex}>
                  <Text style={styles.label}>{f.label}</Text>
                  <Text style={styles.sub}>{f.help}</Text>
                </View>
                <Switch value={on} onValueChange={(v) => edit(f.id, [{ item: v ? "on" : "off" }])} accessibilityLabel={f.label} />
              </View>
              <Text style={styles.itemText}>{on ? f.on : f.off}</Text>
            </View>
          );
        }
        return (
          <ListCard
            key={f.id}
            field={f}
            items={items}
            fresh={!!f.suggest && fresh.includes(f.suggest)}
            suggesting={!!f.suggest && suggesting === f.suggest}
            onSuggest={f.suggest ? () => void suggest(f.suggest as string) : undefined}
            onChange={(next) => edit(f.id, next)}
          />
        );
      })}
      {canEdit ? (
        <Pressable
          style={[styles.save, (save.isPending || dirty.length === 0) && styles.disabled]}
          disabled={save.isPending || dirty.length === 0}
          onPress={() => void saveAll()}
          accessibilityRole="button"
        >
          <Text style={styles.saveText}>{save.isPending ? "Saving…" : "Save settings"}</Text>
        </Pressable>
      ) : null}
      <Text style={styles.sub} accessibilityLiveRegion="polite">
        {canEdit ? note : OWNER_ADMIN_ONLY}
      </Text>
    </View>
  );
}

function ValueCard({
  field,
  value,
  readOnly,
  onChange,
}: {
  field: Extract<AnySettingField, { kind: "number" | "text" }>;
  value: string;
  readOnly: string | null;
  onChange: (value: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor } = useTheme();
  const isNumber = field.kind === "number";
  return (
    <View style={styles.card}>
      <Text style={styles.label}>{field.label}</Text>
      <Text style={styles.sub}>{field.help}</Text>
      <View style={styles.valueRow}>
        {isNumber && field.prefix ? <Text style={styles.affix}>{field.prefix}</Text> : null}
        <FocusRing radius={radius.sm} style={[styles.inputBox, readOnly ? styles.disabled : null]}>
          {(focus) => (
            <TextInput
              style={styles.input}
              value={value}
              onChangeText={onChange}
              editable={!readOnly}
              placeholder={field.kind === "text" ? field.placeholder : undefined}
              placeholderTextColor={colors.muted}
              selectionColor={textSelectionColor}
              cursorColor={colors.ink}
              selectionHandleColor={colors.ink}
              keyboardType={isNumber ? "decimal-pad" : "default"}
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={300}
              accessibilityLabel={field.label}
              onFocus={focus.onFocus}
              onBlur={focus.onBlur}
            />
          )}
        </FocusRing>
        {isNumber && field.suffix ? <Text style={styles.affix}>{field.suffix}</Text> : null}
      </View>
      {readOnly ? <Text style={styles.sub}>{readOnly}</Text> : null}
    </View>
  );
}

function ListCard({
  field,
  items,
  fresh,
  suggesting,
  onSuggest,
  onChange,
}: {
  field: ListField;
  items: SettingItem[];
  fresh: boolean;
  suggesting: boolean;
  onSuggest?: () => void;
  onChange: (items: SettingItem[]) => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor } = useTheme();
  const [draft, setDraft] = useState("");
  const [picking, setPicking] = useState<string | null>(null);
  const visible = visibleItems(items, field, fresh);
  const empty = emptyListText(items, visible);
  const add = () => {
    onChange(addItem(items, draft, field));
    setDraft("");
  };
  const set = (item: string, patch: Partial<SettingItem>) => onChange(items.map((x) => (x.item === item ? { ...x, ...patch } : x)));
  const pickingRow = items.find((x) => x.item === picking);
  const typeOptions = field.itemTypeOptions
    ? [{ value: "", label: field.itemTypeOptions.unsetLabel }, ...field.itemTypeOptions.options]
    : (field.itemTypes ?? []).map((t) => ({ value: t, label: t }));

  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <View style={styles.flex}>
          <Text style={styles.label}>{field.label}</Text>
          <Text style={styles.sub}>{field.help}</Text>
        </View>
        {onSuggest ? (
          <Pressable
            style={[styles.suggest, suggesting && styles.disabled]}
            onPress={onSuggest}
            disabled={suggesting}
            accessibilityRole="button"
          >
            <Text style={styles.suggestText}>{suggesting ? "Looking…" : "Suggest"}</Text>
          </Pressable>
        ) : null}
      </View>
      <View style={styles.addRow}>
        <FocusRing radius={radius.sm} style={styles.inputBox}>
          {(focus) => (
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder={`Add to ${field.label.toLowerCase()}`}
              placeholderTextColor={colors.muted}
              selectionColor={textSelectionColor}
              cursorColor={colors.ink}
              selectionHandleColor={colors.ink}
              maxLength={300}
              returnKeyType="done"
              onSubmitEditing={add}
              accessibilityLabel={`Add to ${field.label.toLowerCase()}`}
              onFocus={focus.onFocus}
              onBlur={focus.onBlur}
            />
          )}
        </FocusRing>
        <Pressable style={[styles.add, !draft.trim() && styles.disabled]} disabled={!draft.trim()} onPress={add} accessibilityRole="button">
          <Text style={styles.addText}>Add</Text>
        </Pressable>
      </View>
      {empty ? <Text style={styles.sub}>{empty}</Text> : null}
      {visible.map((x) => {
        const typed = !!field.itemTypes || !!field.itemTypeOptions;
        const typeLabel = field.itemTypeOptions
          ? field.itemTypeOptions.options.find((o) => o.value === x.item_type)?.label ?? field.itemTypeOptions.unsetLabel
          : x.item_type ?? "problem";
        const typeChip = typed ? (
          <Pressable
            style={[styles.select, field.itemTypeOptions ? styles.selectWide : null]}
            onPress={() => setPicking(x.item)}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={field.itemTypeOptions ? field.itemTypeOptions.label(x.item) : `Type for ${x.item}`}
          >
            <Text style={styles.selectText} numberOfLines={1}>
              {typeLabel}
            </Text>
            <Icon name="chevronDown" size={12} color={colors.muted} strokeWidth={2} />
          </Pressable>
        ) : null;
        return (
          <View key={x.item} style={styles.item}>
            <View style={styles.itemHead}>
              <View style={styles.flex}>
                <Text style={styles.itemText} numberOfLines={2}>
                  {x.item}
                </Text>
                {x.detail ? (
                  <Text style={styles.sub} numberOfLines={1}>
                    {x.detail}
                  </Text>
                ) : null}
              </View>
              {}
              {field.itemTypeOptions ? null : typeChip}
              {x.status === "tracking" || x.status === "paused" ? (
                <Pressable
                  style={[styles.pill, x.status === "tracking" ? styles.pillOn : styles.pillOff]}
                  onPress={() => set(x.item, { status: x.status === "tracking" ? "paused" : "tracking" })}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={x.status === "tracking" ? `Pause ${x.item}` : `Resume ${x.item}`}
                >
                  <Text style={[styles.pillText, x.status === "tracking" ? styles.pillTextOn : null]}>{x.status}</Text>
                </Pressable>
              ) : x.status === "dismissed" ? (
                <View style={[styles.pill, styles.pillOff]}>
                  <Text style={styles.pillText}>dismissed</Text>
                </View>
              ) : null}
              {x.status === "suggested" ? null : (
                <Pressable
                  style={styles.remove}
                  onPress={() => onChange(items.filter((y) => y.item !== x.item))}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${x.item}`}
                >
                  <Icon name="close" size={14} color={colors.ink} strokeWidth={2} />
                </Pressable>
              )}
            </View>
            {field.itemTypeOptions ? typeChip : null}
            {x.status === "suggested" ? (
              <View style={styles.itemLinks}>
                <TextLink label="Track it" onPress={() => set(x.item, { status: "tracking" })} />
                <TextLink label="Dismiss" onPress={() => set(x.item, { status: "dismissed" })} />
              </View>
            ) : null}
          </View>
        );
      })}
      <OptionSheet
        open={!!pickingRow}
        title={pickingRow ? (field.itemTypeOptions ? field.itemTypeOptions.label(pickingRow.item) : `Type for ${pickingRow.item}`) : ""}
        options={typeOptions}
        value={field.itemTypeOptions ? pickingRow?.item_type ?? "" : pickingRow?.item_type ?? "problem"}
        onPick={(v) => pickingRow && set(pickingRow.item, { item_type: v || null })}
        onClose={() => setPicking(null)}
      />
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    content: { gap: space.md, marginTop: space.lg },
    flex: { flex: 1 },
    sub: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    box: {
      padding: space.md,
      borderRadius: radius.sm,
      backgroundColor: colors.soft,
      fontFamily: font.family.regular,
      fontSize: 13,
      lineHeight: 19,
      color: colors.textSecondary,
    },
    card: { gap: space.sm, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.md },
    cardHead: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
    label: { fontFamily: font.family.medium, fontSize: 14, color: colors.ink },
    options: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
    option: { minHeight: 40, paddingHorizontal: 12, justifyContent: "center", borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm },
    optionOn: { backgroundColor: colors.ink, borderColor: colors.ink },
    optionText: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    optionTextOn: { color: colors.onInk },
    toggleRow: { flexDirection: "row", alignItems: "center", gap: space.md },
    suggest: { minHeight: 34, paddingHorizontal: 12, justifyContent: "center", borderWidth: 1, borderColor: colors.line, borderRadius: radius.sm },
    suggestText: { fontFamily: font.family.semi, fontSize: 13, color: colors.ink },
    addRow: { flexDirection: "row", gap: space.sm },
    valueRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
    affix: { fontFamily: font.family.medium, fontSize: 14, color: colors.textSecondary },
    inputBox: { flex: 1 },
    input: { minHeight: 40, paddingHorizontal: space.md, fontFamily: font.family.medium, fontSize: 15, color: colors.ink },
    add: { minHeight: 40, paddingHorizontal: 14, justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.ink },
    addText: { fontFamily: font.family.semi, fontSize: 13, color: colors.onInk },
    item: { gap: 6, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
    itemHead: { flexDirection: "row", alignItems: "center", gap: space.sm },
    itemText: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 20, color: colors.ink },
    itemLinks: { flexDirection: "row", alignItems: "baseline", gap: space.lg },
    pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill },
    pillOn: { backgroundColor: colors.status.greenBg },
    pillOff: { backgroundColor: colors.soft },
    pillText: { fontFamily: font.family.semi, fontSize: 12, color: colors.textSecondary },
    pillTextOn: { color: colors.status.greenText },
    select: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      minHeight: 28,
      paddingHorizontal: 8,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.pill,
    },
    selectWide: { alignSelf: "flex-start", maxWidth: "100%" },
    selectText: { flexShrink: 1, fontFamily: font.family.medium, fontSize: 12, color: colors.ink },
    remove: { width: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: colors.soft },
    save: { minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.sm, backgroundColor: colors.ink },
    saveText: { fontFamily: font.family.semi, fontSize: 14, color: colors.onInk },
    disabled: { opacity: 0.4 },
  });
