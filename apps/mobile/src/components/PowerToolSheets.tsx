import { forwardRef, useCallback, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import {
  BottomSheetBackdrop,
  BottomSheetFlatList,
  BottomSheetModal,
  BottomSheetTextInput,
} from "@gorhom/bottom-sheet";
import { useBackClosesSheet } from "./AppBottomSheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./Icon";
import { FocusRing } from "./ZaviTextField";
import { useReduceMotion } from "../lib/motion";
import { ago, approvalSummary, libraryFiles } from "../features/agents/composerTools";
import { ArtifactPreviewTile } from "./artifacts/ArtifactPreviewTile";
import { agentName } from "../features/agents/replyCards";
import { usePendingApprovals, type Decision } from "../features/approvals/hooks";
import { useArtifacts } from "../features/artifacts/hooks";
import type { Artifact } from "../features/artifacts/types";
import { repoErrorText, useGithubRepos, useSetDefaultRepo } from "../features/connectors/githubRepos";
import { useCanManage } from "../features/settings/api";
import { ApiFetchError } from "../lib/api";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";

type Ref = React.RefObject<BottomSheetModal | null> | React.ForwardedRef<BottomSheetModal>;

function dismissRef(ref: Ref) {
  if (ref && typeof ref !== "function") ref.current?.dismiss();
}

function PickSheet<T>({
  sheetRef,
  title,
  subtitle,
  data,
  keyOf,
  renderRow,
  empty,
  search,
  footer,
  onDismiss,
}: {
  sheetRef: Ref;
  title: string;
  subtitle: string;
  data: T[];
  keyOf: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  empty: ReactNode;
  search?: ReactNode;
  footer?: ReactNode;
  onDismiss?: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const renderBackdrop = useCallback(
    (p: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
    ),
    [],
  );
  const onSheetChange = useBackClosesSheet();
  return (
    <BottomSheetModal
      ref={sheetRef}
      onChange={onSheetChange}
      snapPoints={["60%", "90%"]}
      enableDynamicSizing={false}
      enablePanDownToClose
      animateOnMount={!reduceMotion}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBg}
      handleIndicatorStyle={styles.grabber}
      onDismiss={onDismiss}
    >
      {}
      <View style={[styles.content, styles.headWrap]}>
        <View style={styles.head}>
          <Text style={styles.title}>{title}</Text>
          <Pressable
            style={({ pressed }) => [styles.close, pressed && styles.pressed]}
            onPress={() => dismissRef(sheetRef)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Icon name="close" size={18} color={colors.ink} strokeWidth={2} />
          </Pressable>
        </View>
        <Text style={styles.subtitle}>{subtitle}</Text>
        {search}
      </View>
      <BottomSheetFlatList
        data={data}
        keyExtractor={keyOf}
        style={styles.list}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: space.xl + insets.bottom }]}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        ListFooterComponent={footer ? <View style={styles.footer}>{footer}</View> : null}
        ListEmptyComponent={<View style={styles.emptyWrap}>{empty}</View>}
        renderItem={({ item }) => <>{renderRow(item)}</>}
      />
    </BottomSheetModal>
  );
}

export const LibraryFileSheet = forwardRef<
  BottomSheetModal,
  { busyId: string | null; onPick: (file: Artifact) => void }
>(function LibraryFileSheet({ busyId, onPick }, ref) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { artifacts, isLoading, isError, refetch } = useArtifacts();
  const files = libraryFiles(artifacts);
  return (
    <PickSheet
      sheetRef={ref}
      title="Attach a file Zavi already has"
      subtitle="Your newest 12 files that can go into a chat: PDF, text, Word, CSV, Markdown and images."
      data={files}
      keyOf={(a) => a.id}
      empty={
        isLoading ? (
          <View style={styles.loading}>
            <ActivityIndicator color={colors.muted} />
            <Text style={styles.empty}>Loading your files…</Text>
          </View>
        ) : isError ? (
          <Retry text="Couldn't load your files." onRetry={() => void refetch()} />
        ) : (
          <Text style={styles.empty}>No files yet. Anything Zavi makes for you shows up here.</Text>
        )
      }
      renderRow={(a) => {
        const busy = busyId === a.id;
        return (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed, busyId && !busy && styles.off]}
            onPress={() => onPick(a)}
            disabled={!!busyId}
            accessibilityRole="button"
            accessibilityState={{ busy, disabled: !!busyId }}
          >
            <ArtifactPreviewTile artifact={a} compact />
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {a.filename}
              </Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {busy ? "Attaching…" : `From ${a.source?.kind === "task" ? "a task" : "chat"}, ${ago(a.created_at)}`}
              </Text>
            </View>
            {busy ? <ActivityIndicator size="small" color={colors.muted} /> : null}
          </Pressable>
        );
      }}
    />
  );
});

export const ApprovalPickerSheet = forwardRef<
  BottomSheetModal,
  { onPick: (decision: Decision, summary: string) => void }
>(function ApprovalPickerSheet({ onPick }, ref) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { data, isLoading, isError, refetch } = usePendingApprovals();
  return (
    <PickSheet
      sheetRef={ref}
      title="Ask about an approval"
      subtitle="Pick one. It rides along with your question."
      data={data ?? []}
      keyOf={(d) => d.id}
      empty={
        isLoading ? (
          <ActivityIndicator color={colors.muted} />
        ) : isError ? (
          <Retry text="Couldn't load your approvals." onRetry={() => void refetch()} />
        ) : (
          <Text style={styles.empty}>Nothing is waiting for you right now.</Text>
        )
      }
      renderRow={(d) => {
        const summary = approvalSummary(d.body);
        return (
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => {
              dismissRef(ref);
              onPick(d, summary);
            }}
            accessibilityRole="button"
          >
            <View style={styles.rowText}>
              <Text style={styles.rowTitle} numberOfLines={2}>
                {summary}
              </Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {d.agent_slug ? agentName(d.agent_slug) : "Zavi"} · waiting for you
              </Text>
            </View>
          </Pressable>
        );
      }}
    />
  );
});

export const RepoSheet = forwardRef<
  BottomSheetModal,
  { onManage: () => void; onPicked?: () => void }
>(function RepoSheet({ onManage, onPicked }, ref) {
  const styles = useStyles(makeStyles);
  const { colors, textSelectionColor, keyboardAppearance } = useTheme();
  const { data, isLoading, isError, refetch } = useGithubRepos();
  const setDefault = useSetDefaultRepo();
  const canEdit = useCanManage();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const repos = data?.repos ?? [];
  const q = query.trim().toLowerCase();
  const shown = repos.length > 5 && q ? repos.filter((r) => r.toLowerCase().includes(q)) : repos;
  const manage = () => {
    dismissRef(ref);
    onManage();
  };

  async function pick(repo: string) {
    if (!canEdit || setDefault.isPending) return;
    setError(null);
    if (repo === data?.default) {
      onPicked?.();
      dismissRef(ref);
      return;
    }
    try {
      await setDefault.mutateAsync(repo);
      onPicked?.();
      dismissRef(ref);
    } catch (e) {
      setError(
        e instanceof ApiFetchError && e.status === 403
          ? "Only admins can change the default repo."
          : repoErrorText(e instanceof Error ? e.message : "Couldn't change the repo."),
      );
    }
  }

  return (
    <PickSheet
      sheetRef={ref}
      title="GitHub repo"
      subtitle="Agents work in this repo"
      data={shown}
      keyOf={(r) => r}
      onDismiss={() => {
        setQuery("");
        setError(null);
      }}
      search={
        repos.length > 5 ? (
          <FocusRing radius={radius.sm}>
            {(focus) => (
              <BottomSheetTextInput
                keyboardAppearance={keyboardAppearance}
                value={query}
                onChangeText={setQuery}
                placeholder="Search repos…"
                placeholderTextColor={colors.muted}
                selectionColor={textSelectionColor}
                cursorColor={colors.ink}
                selectionHandleColor={colors.ink}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.search}
                onFocus={() => focus.onFocus()}
                onBlur={() => focus.onBlur()}
              />
            )}
          </FocusRing>
        ) : null
      }
      empty={
        isLoading ? (
          <Text style={styles.empty}>Loading repos…</Text>
        ) : isError ? (
          <Retry text="Couldn't load repos." onRetry={() => void refetch()} />
        ) : repos.length > 0 ? (
          <Text style={styles.empty}>No match.</Text>
        ) : (
          <Pressable onPress={manage} accessibilityRole="button" style={styles.manageRow}>
            <Text style={styles.retryText}>{data?.connected ? "Manage GitHub repos" : "Connect GitHub"}</Text>
          </Pressable>
        )
      }
      footer={
        repos.length === 0 ? null : error ? (
          <Text style={styles.footerError}>{error}</Text>
        ) : data && data.hiddenByScope > 0 ? (
          <Pressable onPress={manage} accessibilityRole="button">
            <Text style={styles.footerText}>
              {data.hiddenByScope} repo{data.hiddenByScope === 1 ? "" : "s"} hidden by your repo scope — manage →
            </Text>
          </Pressable>
        ) : canEdit ? (
          <Pressable onPress={manage} accessibilityRole="button">
            <Text style={styles.footerText}>Manage repos →</Text>
          </Pressable>
        ) : (
          <Text style={styles.footerText}>Only admins can change the default repo.</Text>
        )
      }
      renderRow={(repo) => {
        const current = repo === data?.default;
        const off = !canEdit || setDefault.isPending;
        return (
          <Pressable
            style={({ pressed }) => [styles.row, styles.repoRow, pressed && !off && styles.rowPressed]}
            onPress={() => void pick(repo)}
            disabled={off}
            accessibilityRole="button"
            accessibilityState={{ selected: current, disabled: off }}
          >
            <View style={styles.check}>{current ? <Icon name="tick" size={16} color={colors.ink} /> : null}</View>
            <Text style={[styles.repoName, current && styles.repoCurrent, off && !current && styles.repoOff]} numberOfLines={1}>
              {repo}
            </Text>
            {setDefault.isPending && setDefault.variables === repo ? (
              <ActivityIndicator size="small" color={colors.muted} />
            ) : null}
          </Pressable>
        );
      }}
    />
  );
});

function Retry({ text, onRetry }: { text: string; onRetry: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.retry}>
      <Text style={styles.empty}>{text}</Text>
      <Pressable onPress={onRetry} hitSlop={8} accessibilityRole="button">
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  sheetBg: { backgroundColor: colors.panel2, borderRadius: 27 },
  grabber: { width: 35, height: 4, backgroundColor: colors.line },
  content: { paddingHorizontal: 15 },
  headWrap: { marginHorizontal: space.sm, marginTop: space.xs, marginBottom: space.md, gap: space.sm },
  head: { flexDirection: "row", alignItems: "center", gap: space.md },
  title: { flex: 1, fontSize: font.size.title, fontFamily: font.family.bold, letterSpacing: -0.5, color: colors.ink },
  subtitle: { fontSize: font.size.md, lineHeight: 19, fontFamily: font.family.regular, color: colors.muted },
  close: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.soft,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { opacity: 0.7 },
  sep: { height: 1, marginHorizontal: space.sm, backgroundColor: colors.line },
  row: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.sm,
    borderRadius: space.md,
  },
  rowPressed: { backgroundColor: colors.soft },
  off: { opacity: 0.4 },
  list: { flex: 1 },
  rowText: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontSize: 15, lineHeight: 21, fontFamily: font.family.medium, color: colors.ink },
  rowSub: { fontSize: font.size.sm, fontFamily: font.family.regular, color: colors.muted },
  emptyWrap: { paddingHorizontal: space.sm, paddingVertical: space.md },
  empty: { fontSize: font.size.base, lineHeight: 20, fontFamily: font.family.regular, color: colors.muted },
  loading: { flexDirection: "row", alignItems: "center", gap: space.sm },
  retry: { gap: space.sm, alignItems: "flex-start" },
  search: {
    height: 40,
    paddingHorizontal: space.md,
    fontSize: 15,
    fontFamily: font.family.medium,
    color: colors.ink,
  },
  footer: { paddingHorizontal: space.sm, paddingTop: space.md },
  footerText: { fontSize: font.size.sm, lineHeight: 18, fontFamily: font.family.regular, color: colors.muted },
  footerError: { fontSize: font.size.sm, lineHeight: 18, fontFamily: font.family.medium, color: colors.red },
  repoRow: { minHeight: 48 },
  check: { width: 18, alignItems: "center" },
  repoName: { flex: 1, fontSize: 15, fontFamily: font.family.regular, color: colors.ink },
  repoCurrent: { fontFamily: font.family.semi },
  repoOff: { color: colors.muted },
  manageRow: { paddingVertical: space.sm },
  retryText: { fontSize: font.size.base, fontFamily: font.family.semi, color: colors.ink },
});
