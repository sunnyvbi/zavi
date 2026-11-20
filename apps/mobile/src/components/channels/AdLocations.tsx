import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { AppBottomSheet } from "../AppBottomSheet";
import { Icon } from "../Icon";
import { CardButton } from "../reply/ui";
import { FocusRing } from "../ZaviTextField";
import {
  MAX_PLACES,
  SOURCE_LABEL,
  countryText,
  initialPicked,
  needsYouLine,
  ordersHint,
  pickedSubtitle,
  saveLabel,
  savedLine,
  togglePlace,
  unsupportedLine,
  type ActiveStatus,
  type AdPlace,
  type LocationStatus,
  type Suggestions,
} from "../../features/channels/adLocations";
import { fetchLocationStatus, fetchSuggestions, saveLocations, searchPlaces } from "../../features/channels/adLocationsApi";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

export function AdLocationsCard({ slug, channelName }: { slug: string; channelName: string }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [status, setStatus] = useState<LocationStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [keepBusy, setKeepBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await fetchLocationStatus(slug);
    if (next) setStatus(next);
    return next;
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = !!status && status.state !== "none" && status.pending;
  useEffect(() => {
    if (!pending) return;
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      void load().then((s) => {
        if (!s || s.state === "none" || !s.pending || tries >= 10) clearInterval(t);
      });
    }, 3000);
    return () => clearInterval(t);
  }, [pending, load]);

  if (!status || status.state === "none") return null;
  const s = status;

  async function keepCountry() {
    if (s.state === "none") return;
    setKeepBusy(true);
    setError(null);
    const err = await saveLocations(slug, s, []);
    if (err) setError(err);
    await load();
    setKeepBusy(false);
  }

  const hint = s.state === "needs_you" ? ordersHint(s.order_cities) : null;

  return (
    <View style={styles.card} accessibilityLabel="Where your ads show">
      <View style={styles.head}>
        <Icon name="pin" size={16} color={colors.muted} />
        <Text style={styles.title}>Where your ads show</Text>
        {s.state === "needs_you" ? <Text style={styles.badge}>Needs you</Text> : null}
      </View>

      <Text style={styles.body}>
        {s.state === "unsupported" ? unsupportedLine(channelName, slug) : s.state === "needs_you" ? needsYouLine(s, channelName) : savedLine(s)}
      </Text>
      {hint ? (
        <View style={styles.hint}>
          <Icon name="sparkles" size={16} color={colors.status.greenDot} />
          <Text style={styles.hintText}>{hint}</Text>
        </View>
      ) : null}

      {s.last_error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {`Your last change didn't go through: ${s.last_error}`}
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      {s.state !== "unsupported" ? (
        <View style={styles.buttons}>
          {s.state === "needs_you" ? (
            <CardButton label="Keep the whole country" variant="secondary" onPress={() => void keepCountry()} busy={keepBusy} />
          ) : null}
          <CardButton label={s.state === "needs_you" ? "Pick places" : "Edit places"} onPress={() => setOpen(true)} disabled={s.pending} />
        </View>
      ) : null}

      <AdLocationsSheet
        open={open}
        slug={slug}
        channelName={channelName}
        status={s.state === "unsupported" ? null : s}
        onClose={() => setOpen(false)}
        onSaved={() => {
          setOpen(false);
          void load();
        }}
      />
    </View>
  );
}

function AdLocationsSheet({
  open,
  slug,
  channelName,
  status,
  onClose,
  onSaved,
}: {
  open: boolean;
  slug: string;
  channelName: string;
  status: ActiveStatus | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor } = useTheme();
  const [sugg, setSugg] = useState<Suggestions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<AdPlace[]>([]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<AdPlace[]>([]);
  const [searching, setSearching] = useState(false);
  const [applyAll, setApplyAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!open || !statusRef.current) return;
    let live = true;
    setSugg(null);
    setLoadError(null);
    setPicked([]);
    setQ("");
    setResults([]);
    setApplyAll(false);
    setError(null);
    void fetchSuggestions(slug, statusRef.current).then(({ sugg: next, error: err }) => {
      if (!live || !statusRef.current) return;
      setLoadError(err);
      setSugg(next);
      setPicked(initialPicked(statusRef.current, next));
    });
    return () => {
      live = false;
    };
  }, [open, slug]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      setSearching(true);
      const found = await searchPlaces(slug, term);
      if (live) {
        setResults(found);
        setSearching(false);
      }
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, slug]);

  if (!status) return null;
  const has = (p: AdPlace) => picked.some((x) => x.id === p.id);
  const full = picked.length >= MAX_PLACES;
  const shown = results.filter((p) => !has(p)).slice(0, 6);
  const suggested = sugg?.places ?? [];
  const mixed = status.targeting === "mixed";

  async function save() {
    if (!status) return;
    if (mixed && !applyAll) {
      setError("Tick the box to apply these places to every ad group.");
      return;
    }
    setBusy(true);
    setError(null);
    const err = await saveLocations(slug, status, picked, applyAll);
    setBusy(false);
    if (err) setError(err);
    else onSaved();
  }

  return (
    <AppBottomSheet
      open={open}
      onClose={onClose}
      title="Where your ads show"
      locked={busy}
    >
      <View style={styles.sheet}>
        <Text style={styles.body}>{pickedSubtitle(suggested, !!sugg)}</Text>

        {sugg?.orders === "no_db" ? (
          <Text style={styles.hintBox}>Connect your database and Zavi suggests places from where your customers actually buy.</Text>
        ) : null}
        {loadError ? <Text style={styles.body}>{loadError}</Text> : null}

        {suggested.length > 0 ? (
          <View style={styles.group}>
            <Text style={styles.caps}>Suggested</Text>
            {suggested.map((p) => (
              <Pressable
                key={p.id}
                style={[styles.option, has(p) && styles.optionOn]}
                onPress={() => setPicked((cur) => togglePlace(cur, p))}
                disabled={!has(p) && full}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: has(p), disabled: !has(p) && full }}
              >
                <View style={[styles.box, has(p) && styles.boxOn]}>{has(p) ? <Icon name="tick" size={13} color={colors.onInk} /> : null}</View>
                <View style={styles.optionText}>
                  <Text style={styles.optionName}>{p.name}</Text>
                  {p.reason ? <Text style={styles.small}>{p.reason}</Text> : null}
                </View>
                {p.source ? <Text style={styles.source}>{SOURCE_LABEL[p.source]}</Text> : null}
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={styles.group}>
          <Text style={styles.caps}>Add a place</Text>
          <FocusRing radius={radius.md}>
            {(focus) => (
              <BottomSheetTextInput
                value={q}
                onChangeText={setQ}
                editable={!full}
                placeholder="City, state or country"
                placeholderTextColor={colors.muted}
                selectionColor={textSelectionColor}
                cursorColor={colors.ink}
                selectionHandleColor={colors.ink}
                accessibilityLabel="Search places"
                autoCorrect={false}
                onFocus={focus.onFocus}
                onBlur={focus.onBlur}
                style={styles.input}
              />
            )}
          </FocusRing>
          {shown.map((p) => (
            <Pressable
              key={p.id}
              style={styles.result}
              onPress={() => {
                setPicked((cur) => togglePlace(cur, p));
                setQ("");
              }}
              accessibilityRole="button"
              accessibilityLabel={`Add ${p.name}`}
            >
              <Text style={styles.optionName}>{p.name}</Text>
              <Text style={styles.small}>{p.kind}</Text>
            </Pressable>
          ))}
          {!searching && q.trim().length >= 2 && results.length === 0 ? (
            <Text style={styles.small}>No places match. Try a city, state or country name.</Text>
          ) : null}

          <View style={styles.chips}>
            {picked.length === 0 ? (
              <Text style={styles.body}>{`Nothing picked: ads show across ${countryText(status.country ?? sugg?.country ?? null)}.`}</Text>
            ) : (
              picked.map((p) => (
                <Pressable
                  key={p.id}
                  style={styles.chip}
                  onPress={() => setPicked((cur) => togglePlace(cur, p))}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${p.name}`}
                >
                  <Text style={styles.chipText}>{p.name}</Text>
                  <Icon name="close" size={12} color={colors.ink} strokeWidth={2} />
                </Pressable>
              ))
            )}
          </View>
          {full ? <Text style={styles.small}>{`You can pick up to ${MAX_PLACES} places.`}</Text> : null}
        </View>

        {mixed ? (
          <Pressable
            style={styles.option}
            onPress={() => setApplyAll((v) => !v)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: applyAll }}
          >
            <View style={[styles.box, applyAll && styles.boxOn]}>{applyAll ? <Icon name="tick" size={13} color={colors.onInk} /> : null}</View>
            <Text style={[styles.optionName, styles.optionText]}>
              {`This campaign's ${status.ad_groups} ad groups show in different places today. Apply these places to every ad group.`}
            </Text>
          </Pressable>
        ) : null}

        <Text style={styles.small}>{`These places apply to this ${channelName} campaign only.`}</Text>
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <View style={styles.footer}>
          <CardButton label="Cancel" variant="secondary" onPress={onClose} disabled={busy} />
          <CardButton label={saveLabel(picked.length, busy)} onPress={() => void save()} disabled={busy || !sugg} />
        </View>
      </View>
    </AppBottomSheet>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    card: {
      marginTop: space.md,
      padding: space.lg,
      gap: space.sm,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: 16,
      backgroundColor: colors.panel,
    },
    head: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
    title: { fontFamily: font.family.semi, fontSize: 14, color: colors.ink },
    badge: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: radius.pill,
      overflow: "hidden",
      fontFamily: font.family.medium,
      fontSize: 12,
      color: colors.textSecondary,
      backgroundColor: colors.soft,
    },
    body: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
    hint: { flexDirection: "row", gap: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft },
    hintText: { flex: 1, fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
    hintBox: { padding: space.md, borderRadius: radius.md, backgroundColor: colors.soft, fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.textSecondary },
    error: { fontFamily: font.family.medium, fontSize: 13, lineHeight: 19, color: colors.red },
    buttons: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: space.sm, marginTop: space.xs },
    sheet: { gap: space.md },
    footer: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm, marginTop: space.sm },
    group: { gap: space.sm },
    caps: { fontFamily: font.family.semi, fontSize: 11, letterSpacing: 0.66, textTransform: "uppercase", color: colors.muted },
    small: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    option: {
      flexDirection: "row",
      alignItems: "center",
      gap: space.md,
      padding: space.md,
      borderWidth: 1,
      borderColor: colors.line,
      borderRadius: radius.md,
    },
    optionOn: { borderColor: colors.ink },
    optionText: { flex: 1, minWidth: 0 },
    optionName: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 19, color: colors.ink },
    box: { width: 20, height: 20, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.line, borderRadius: 6 },
    boxOn: { borderColor: colors.ink, backgroundColor: colors.ink },
    source: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.sm, overflow: "hidden", fontFamily: font.family.medium, fontSize: 12, color: colors.textSecondary, backgroundColor: colors.soft },
    input: {
      minHeight: 42,
      paddingHorizontal: space.md,
      fontFamily: font.family.medium,
      fontSize: 15,
      color: colors.ink,
    },
    result: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      minHeight: 44,
      paddingHorizontal: space.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
    chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingLeft: 10, paddingRight: 8, borderRadius: radius.md, backgroundColor: colors.soft },
    chipText: { fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
  });
