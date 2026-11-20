import { forwardRef, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Dimensions, Keyboard, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { Markdown } from "../Markdown";
import {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetModal,
  BottomSheetTextInput,
  BottomSheetView,
} from "@gorhom/bottom-sheet";
import { useBackClosesSheet } from "../AppBottomSheet";
import { FocusRing, hintText } from "../ZaviTextField";
import { useKeyboardOpen, useKeyboardTop } from "../useKeyboardReveal";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReduceMotion } from "../../lib/motion";
import { track } from "../../lib/analytics";
import { Icon } from "../Icon";
import { brainstormChat, brainstormResearch, brainstormSummarize } from "../../features/onboarding/brainstorm";
import {
  BRAINSTORM_MAX_TURNS,
  MIN_IDEA,
  RESEARCH_STEPS,
  canUseIdea,
  hasLandscape,
  type BrainstormMsg,
  type Landscape,
} from "../../features/onboarding/idea";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const GRABBER_H = 28;

function useKeyboardHeight(): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "ios") return;
    const show = Keyboard.addListener("keyboardWillShow", (e) => setH(e.endCoordinates.height));
    const hide = Keyboard.addListener("keyboardWillHide", () => setH(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return h;
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export const BrainstormSheet = forwardRef<
  BottomSheetModal,
  { seedIdea: string; onUseIdea: (brief: string) => void }
>(function BrainstormSheet({ seedIdea, onUseIdea }, ref) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboardOpen = useKeyboardOpen();
  const reduceMotion = useReduceMotion();
  const { height: screenH } = useWindowDimensions();
  const keyboard = useKeyboardHeight();
  const keyboardTop = useKeyboardTop();
  const bottomEdge =
    Platform.OS === "android" ? (keyboardTop ?? Dimensions.get("screen").height) : screenH - keyboard;
  const bodyH = bottomEdge - insets.top - GRABBER_H;
  const [open, setOpen] = useState(false);
  const onClose = useCallback(() => {
    if (ref && typeof ref !== "function") ref.current?.dismiss();
  }, [ref]);
  const renderBackdrop = useCallback(
    (p: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
    ),
    [],
  );
  const [messages, setMessages] = useState<BrainstormMsg[]>([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const [done, setDone] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [landscape, setLandscape] = useState<Landscape | null>(null);
  const [researching, setResearching] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const followed = useRef(0);
  const list = useRef<{ scrollToEnd: (o?: { animated?: boolean }) => void }>(null);

  const userTurns = messages.filter((m) => m.role === "user").length;

  useEffect(() => {
    if (!researching) return;
    setStep(0);
    const t = setInterval(() => setStep((s) => Math.min(s + 1, RESEARCH_STEPS.length - 1)), 5000);
    return () => clearInterval(t);
  }, [researching]);

  const fetchNext = useCallback(
    async (history: BrainstormMsg[]) => {
      const opening = history.length === 0;
      let ok = false;
      setThinking(true);
      setError(null);
      try {
        const r = await brainstormChat(seedIdea, landscape, history);
        ok = true;
        setMessages((prev) => [...prev, { role: "agent", text: r.message, options: r.options, recommended: r.recommended }]);
        if (r.done) setDone(true);
      } catch (e) {
        setError(errorText(e, "Network hiccup. Try again."));
      } finally {
        setThinking(false);
        if (opening && !ok) started.current = false;
      }
    },
    [seedIdea, landscape],
  );

  const runResearch = useCallback(async () => {
    let ok = false;
    setResearching(true);
    setError(null);
    try {
      const r = await brainstormResearch(seedIdea);
      ok = true;
      setLandscape(r.landscape);
      setMessages([{ role: "agent", text: r.message }]);
    } catch (e) {
      setError(errorText(e, "Network hiccup. Try again."));
    } finally {
      setResearching(false);
      if (!ok) started.current = false;
    }
  }, [seedIdea]);

  useEffect(() => {
    if (!open || started.current || messages.length > 0 || researching) return;
    started.current = true;
    if (seedIdea.trim().length >= MIN_IDEA) void runResearch();
    else void fetchNext([]);
  }, [open, researching, messages.length, seedIdea, runResearch, fetchNext]);

  function retry() {
    if (!landscape && messages.length === 0) void runResearch();
    else void fetchNext(messages);
  }

  function send(text: string) {
    const t = text.trim();
    if (!t || thinking || done || userTurns >= BRAINSTORM_MAX_TURNS) return;
    const next: BrainstormMsg[] = [...messages, { role: "user", text: t }];
    setMessages(next);
    setInput("");
    void fetchNext(next);
  }

  async function useThisIdea() {
    if (summarizing || thinking) return;
    setSummarizing(true);
    setError(null);
    try {
      const brief = await brainstormSummarize(seedIdea, landscape, messages);
      track("onboarding_brainstorm_idea_used");
      onUseIdea(brief);
      onClose();
    } catch (e) {
      setError(errorText(e, "Couldn't pull that together. Try again."));
    } finally {
      setSummarizing(false);
    }
  }

  const header = hasLandscape(landscape) && !researching ? <LandscapeCard landscape={landscape as Landscape} /> : null;

  const onSheetChange = useBackClosesSheet();
  return (
    <BottomSheetModal
      ref={ref}
      snapPoints={["100%"]}
      topInset={insets.top}
      enableDynamicSizing={false}
      enablePanDownToClose
      enableContentPanningGesture={false}
      animateOnMount={!reduceMotion}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBg}
      handleIndicatorStyle={styles.grabber}
      keyboardBehavior="extend"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onChange={(i) => {
        onSheetChange(i);
        setOpen(i >= 0);
      }}
      onDismiss={() => setOpen(false)}
    >
      <BottomSheetView style={{ height: bodyH }}>
        <View style={styles.head}>
          <View style={styles.headText}>
            <Text style={styles.title}>Brainstorm your idea</Text>
            <Text style={styles.sub}>Think it through with Zavi, then drop it in the box and build.</Text>
          </View>
          <Text style={styles.turns}>{`${userTurns} / ${BRAINSTORM_MAX_TURNS}`}</Text>
          <Pressable
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
            onPress={onClose}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Icon name="close" size={18} color={colors.ink} strokeWidth={2} />
          </Pressable>
        </View>

        {researching ? (
          <View style={styles.research}>
            <ActivityIndicator color={colors.muted} />
            <Text style={styles.researchTitle}>Researching your idea…</Text>
            <Text style={styles.sub}>{RESEARCH_STEPS[step]}</Text>
          </View>
        ) : (
          <BottomSheetFlatList
            ref={list as never}
            data={messages}
            keyExtractor={(_: BrainstormMsg, i: number) => String(i)}
            style={styles.flex}
            contentContainerStyle={styles.messages}
            keyboardShouldPersistTaps="handled"
            ListHeaderComponent={header}
            onContentSizeChange={() => {
              if (messages.length !== followed.current) {
                followed.current = messages.length;
                list.current?.scrollToEnd({ animated: true });
              }
            }}
            ListFooterComponent={
              <View style={styles.foot}>
                {thinking ? <Text style={styles.sub}>Zavi is thinking…</Text> : null}
                {error ? (
                  <View style={styles.errorRow}>
                    <Text style={styles.errorText}>{error}</Text>
                    <Pressable style={styles.retry} onPress={retry} disabled={thinking || researching} accessibilityRole="button">
                      <Text style={styles.retryText}>Retry</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            }
            renderItem={({ item: m }: { item: BrainstormMsg }) =>
              m.role === "user" ? (
                <View style={styles.userRow}>
                  <View style={styles.userBubble}>
                    <Text style={styles.userText}>{m.text}</Text>
                  </View>
                </View>
              ) : (
                <View style={styles.agentRow}>
                  <View style={styles.agentBubble}>
                    <Markdown body={m.text} />
                  </View>
                  {m.options?.length ? (
                    <View style={styles.options}>
                      {m.options.map((opt) => {
                        const suggested = m.recommended === opt;
                        return (
                          <Pressable
                            key={opt}
                            style={[styles.option, suggested && styles.optionSuggested, (thinking || done) && styles.dim]}
                            onPress={() => send(opt)}
                            disabled={thinking || done}
                            accessibilityRole="button"
                            accessibilityLabel={suggested ? `${opt}, suggested` : opt}
                          >
                            <Text style={styles.optionText}>{suggested ? `✦ ${opt}` : opt}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                </View>
              )
            }
          />
        )}

        {canUseIdea({ userTurns, done, landscape, messages: messages.length }) ? (
          <Pressable
            style={[styles.use, done && styles.useDone, (summarizing || thinking || researching) && styles.dim]}
            onPress={() => void useThisIdea()}
            disabled={summarizing || thinking || researching}
            accessibilityRole="button"
          >
            <Text style={[styles.useText, done && styles.useTextDone]}>{summarizing ? "Pulling it together…" : "Use this idea →"}</Text>
          </Pressable>
        ) : null}

        <View style={[styles.composerWrap, { paddingBottom: keyboardOpen ? space.sm : space.sm + insets.bottom }]}>
          <FocusRing radius={radius.lg}>
            {(focus) => (
              <View style={styles.composer}>
                <BottomSheetTextInput
                  keyboardAppearance={keyboardAppearance}
                  style={styles.input}
                  value={input}
                  onChangeText={setInput}
                  placeholder={hintText(done ? "That's plenty. Drop it in the box." : "Reply, or tap a suggestion…")}
                  placeholderTextColor={colors.muted}
                  multiline
                  editable={!done && !researching && userTurns < BRAINSTORM_MAX_TURNS}
                  cursorColor={colors.ink}
                  selectionColor={textSelectionColor}
                  selectionHandleColor={colors.ink}
                  onFocus={focus.onFocus}
                  onBlur={focus.onBlur}
                  accessibilityLabel="Reply"
                />
                <Pressable
                  style={[styles.send, (!input.trim() || thinking || done || researching) && styles.dim]}
                  onPress={() => send(input)}
                  disabled={!input.trim() || thinking || done || researching}
                  accessibilityRole="button"
                  accessibilityLabel="Send"
                >
                  <Icon name="send" size={16} color={colors.onInk} />
                </Pressable>
              </View>
            )}
          </FocusRing>
        </View>
      </BottomSheetView>
    </BottomSheetModal>
  );
});

function LandscapeCard({ landscape: l }: { landscape: Landscape }) {
  const styles = useStyles(makeStyles);
  const row = (label: string, text?: string) =>
    text ? (
      <View style={styles.lrow} key={label}>
        <Text style={styles.lcaps}>{label}</Text>
        <Text style={styles.ltext}>{text}</Text>
      </View>
    ) : null;
  return (
    <View style={styles.landscape}>
      <View style={styles.lhead}>
        <Text style={styles.lcapsInk}>✦ Market landscape</Text>
        <Text style={styles.lbadge}>{l.grounded ? "web-researched" : "quick read"}</Text>
      </View>
      {l.market ? <Text style={styles.lmarket}>{l.market}</Text> : null}
      {(l.competitors?.length ?? 0) > 0 ? (
        <View style={styles.lrow}>
          <Text style={styles.lcaps}>Who's already here</Text>
          {l.competitors?.slice(0, 6).map((c, i) => (
            <Text key={i} style={styles.ltext}>
              <Text style={styles.lname}>{c.name}</Text>
              {c.angle ? ` — ${c.angle}` : ""}
            </Text>
          ))}
        </View>
      ) : null}
      {row("The gap", l.gap)}
      {row("Sharpest wedge", l.wedge)}
      {row("Smallest v1", l.v1)}
      {(l.sources?.length ?? 0) > 0 ? <Text style={styles.lsrc}>{`Based on ${l.sources?.length} live source${l.sources?.length === 1 ? "" : "s"}.`}</Text> : null}
    </View>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    sheetBg: { backgroundColor: colors.surfaceRaised, borderRadius: 27 },
    grabber: { width: 35, height: 4, backgroundColor: colors.borderRaised },
    flex: { flex: 1 },
    head: { flexDirection: "row", alignItems: "flex-start", gap: space.md, marginHorizontal: space.lg, marginTop: space.xs, marginBottom: space.md },
    headText: { flex: 1, minWidth: 0, gap: 2 },
    title: { fontSize: font.size.title, fontFamily: font.family.bold, includeFontPadding: false, letterSpacing: -0.5, color: colors.ink },
    close: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.soft, alignItems: "center", justifyContent: "center" },
    pressed: { opacity: 0.7 },
    sub: { fontFamily: font.family.regular, fontSize: 12, lineHeight: 17, color: colors.muted },
    turns: { fontFamily: font.family.semi, fontSize: 11, color: colors.muted },
    research: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm, padding: space.xl },
    researchTitle: { fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
    messages: { padding: space.lg, gap: space.md },
    foot: { gap: space.sm },
    userRow: { alignItems: "flex-end" },
    userBubble: { maxWidth: "80%", paddingHorizontal: space.md, paddingVertical: 10, borderRadius: radius.lg + 3, backgroundColor: colors.bubbleUserBg },
    userText: { fontFamily: font.family.medium, fontSize: 16, lineHeight: 24, color: colors.bubbleUserText },
    agentRow: { width: "100%", alignItems: "flex-start", gap: space.sm },
    agentBubble: { width: "100%" },
    options: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
    option: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg },
    optionSuggested: { borderColor: colors.status.amberDot, backgroundColor: colors.soft },
    optionText: { fontFamily: font.family.medium, fontSize: 13, color: colors.ink },
    dim: { opacity: 0.4 },
    errorRow: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm, borderRadius: radius.sm, backgroundColor: colors.soft },
    errorText: { flex: 1, fontFamily: font.family.regular, fontSize: 12, color: colors.status.redText },
    retry: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line },
    retryText: { fontFamily: font.family.semi, fontSize: 12, color: colors.ink },
    use: { marginHorizontal: space.lg, minHeight: 46, alignItems: "center", justifyContent: "center", borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.soft },
    useDone: { backgroundColor: colors.ink, borderColor: colors.ink },
    useText: { fontFamily: font.family.semi, fontSize: 15, color: colors.ink },
    useTextDone: { color: colors.onInk },
    composerWrap: { paddingHorizontal: space.lg, paddingTop: space.sm },
    composer: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm },
    input: { flex: 1, maxHeight: 120, minHeight: 34, fontFamily: font.family.medium, fontSize: 15, color: colors.ink },
    send: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: 16, backgroundColor: colors.ink },
    landscape: { gap: space.sm, padding: space.md, marginBottom: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg },
    lhead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
    lcapsInk: { fontFamily: font.family.semi, fontSize: 12, letterSpacing: 1, textTransform: "uppercase", color: colors.ink },
    lbadge: { fontFamily: font.family.semi, fontSize: 10, color: colors.muted },
    lmarket: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.muted },
    lrow: { gap: 2, padding: space.sm, borderRadius: radius.sm, backgroundColor: colors.soft },
    lcaps: { fontFamily: font.family.semi, fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: colors.muted },
    ltext: { fontFamily: font.family.regular, fontSize: 13, lineHeight: 19, color: colors.ink },
    lname: { fontFamily: font.family.semi },
    lsrc: { fontFamily: font.family.regular, fontSize: 11, color: colors.muted },
  });
