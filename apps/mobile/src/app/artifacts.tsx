import * as WebBrowser from "expo-web-browser";
import { MediaViewer, inAppVideoAvailable, type MediaItem } from "../components/MediaViewer";
import { forwardRef, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Keyboard,
  BackHandler,
  FlatList,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { BottomSheetBackdrop, BottomSheetModal, BottomSheetTextInput, BottomSheetView } from "@gorhom/bottom-sheet";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useFocusEffect, useRouter } from "expo-router";
import { BackIcon, Icon } from "../components/Icon";
import { FocusRing } from "../components/ZaviTextField";
import { useReduceMotion } from "../lib/motion";
import { ArtifactGlyph } from "../components/artifacts/ArtifactGlyph";
import {
  ArtifactActionSheet,
  ArtifactCard,
  ArtifactFilterPills,
  ArtifactListRow,
  ArtifactPreviewTile,
  ArtifactSearchField,
  ArtifactsEmptyState,
  ArtifactsErrorState,
  ArtifactsSkeleton,
  CsvPreview,
  CsvViewer,
  UiBlockArtifactView,
  UiBlockViewer,
  isUiBlockArtifact,
  HtmlArtifactPreview,
  HtmlArtifactViewer,
  SiteArtifactItem,
  artifactTypeGlyph,
  isHtmlArtifact,
  artifactTypeLabel,
  type ArtifactAction,
} from "../components/artifacts";
import { fetchArtifactPreviewUrl } from "../features/artifacts/api";
import { isCsv } from "../features/artifacts/csv";
import { mergeArtifactEntries, visibleSites, type ArtifactEntry } from "../features/artifacts/sites";
import {
  useArtifactDownloadUrl,
  useArtifacts,
  useDeleteArtifact,
  useRenameArtifact,
} from "../features/artifacts/hooks";
import type { Artifact, ArtifactFilter } from "../features/artifacts/types";
import { font, radius, space, type Colors } from "../theme/tokens";
import { useStyles, useTheme } from "../theme/theme";
import { KeyboardAvoider } from "../components/KeyboardAvoider";

type ArtifactLayout = "grid" | "list";

export default function Artifacts() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filter, setFilter] = useState<ArtifactFilter>("all");
  const [layout, setLayout] = useState<ArtifactLayout>("grid");
  const [keyboardOpen, setKeyboardOpen] = useState(() => Keyboard.isVisible());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<MediaItem | null>(null);
  const [htmlView, setHtmlView] = useState<Artifact | null>(null);
  const [blockView, setBlockView] = useState<Artifact | null>(null);
  const [csvView, setCsvView] = useState<Artifact | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameTitle, setRenameTitle] = useState("");
  const actionSheetRef = useRef<BottomSheetModal>(null);
  const renameSheetRef = useRef<BottomSheetModal>(null);
  const scrollY = useRef(new Animated.Value(0)).current;
  const listRef = useRef<{ scrollToOffset: (o: { offset: number; animated?: boolean }) => void }>(null);
  const { artifacts, sites, isLoading: isFirstLoad, isPlaceholderData, isError, refetch } = useArtifacts(debouncedQuery, filter);
  const [pullRefreshing, setPullRefreshing] = useState(false);
  const isLoading = isFirstLoad || isPlaceholderData;
  const rename = useRenameArtifact();
  const remove = useDeleteArtifact();
  const download = useArtifactDownloadUrl();

  const visibleArtifacts = useMemo(
    () => artifacts.filter((artifact) => filter === "all" || artifact.type === filter),
    [artifacts, filter],
  );
  const entries = useMemo(
    () => mergeArtifactEntries(visibleSites(sites, filter), visibleArtifacts),
    [sites, filter, visibleArtifacts],
  );
  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedId) ?? null;
  const menuArtifact = artifacts.find((artifact) => artifact.id === menuId) ?? null;
  const busyAction: ArtifactAction | null = download.isPending
    ? "download"
    : rename.isPending
      ? "rename"
      : remove.isPending
        ? "delete"
        : null;

  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () =>
      setKeyboardOpen(true),
    );
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () =>
      setKeyboardOpen(false),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 500);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!selectedId && !menuId && !renameId) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (renameId) {
        renameSheetRef.current?.dismiss();
        return true;
      }
      if (menuId) {
        actionSheetRef.current?.dismiss();
        return true;
      }
      setSelectedId(null);
      return true;
    });
    return () => sub.remove();
  }, [selectedId, menuId, renameId]);

  function closeMenu() {
    actionSheetRef.current?.dismiss();
  }

  const openMenu = useCallback((artifact: Artifact) => {
    setMenuId(artifact.id);
    actionSheetRef.current?.present();
  }, []);

  function goBack() {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace("/chat");
  }

  const busy = !!busyAction;

  const focusedOnce = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (focusedOnce.current) void refetch();
      focusedOnce.current = true;
    }, [refetch]),
  );

  const pullToRefresh = useCallback(() => {
    setPullRefreshing(true);
    void refetch().finally(() => setPullRefreshing(false));
  }, [refetch]);

  const openSiteLive = useCallback((url: string) => {
    void WebBrowser.openBrowserAsync(url).catch(() => showError("Could not open this website."));
  }, []);
  useEffect(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, [filter, debouncedQuery]);

  const renderEntry = useCallback(
    ({ item }: { item: ArtifactEntry }) => {
      if (item.kind === "site") {
        const sessionId = item.site.build_session_id;
        const site = (
          <SiteArtifactItem
            site={item.site}
            layout={layout}
            onOpen={sessionId ? () => router.push({ pathname: "/build/[id]", params: { id: sessionId } }) : null}
            onOpenLive={openSiteLive}
          />
        );
        return layout === "grid" ? <View style={styles.gridItem}>{site}</View> : site;
      }
      return <ArtifactItem artifact={item.artifact} busy={busy} layout={layout} onSelect={setSelectedId} onMenu={openMenu} />;
    },
    [busy, layout, openMenu, openSiteLive, router, styles.gridItem],
  );

  function openArtifact(artifact: Artifact) {
    if (isCsv(artifact)) {
      setCsvView(artifact);
      return;
    }
    if (isUiBlockArtifact(artifact)) {
      setBlockView(artifact);
      return;
    }
    if (isHtmlArtifact(artifact)) {
      setHtmlView(artifact);
      return;
    }
    const media = artifact.type === "image" ? "image" : artifact.type === "video" ? "video" : null;
    void fetchArtifactPreviewUrl(artifact.id)
      .then(({ signed_url }) => {
        if (media === "image" || (media === "video" && inAppVideoAvailable())) {
          setPreview({ kind: media, url: signed_url, filename: artifact.filename });
          return;
        }
        return WebBrowser.openBrowserAsync(signed_url);
      })
      .catch(() => showError("Could not open this artifact."));
  }

  function downloadArtifact(artifact: Artifact) {
    void download
      .mutateAsync(artifact.id)
      .then(({ signed_url }) => Linking.openURL(signed_url))
      .catch(() => showError("Could not download this artifact."));
  }

  function beginRename(artifact: Artifact) {
    closeMenu();
    setRenameId(artifact.id);
    setRenameTitle(artifact.title);
    renameSheetRef.current?.present();
  }

  function saveRename() {
    const artifact = artifacts.find((item) => item.id === renameId);
    if (!artifact) return;
    const title = renameTitle.trim();
    if (!title || title.length > 160) {
      showError("Title must be between 1 and 160 characters.");
      return;
    }
    void rename
      .mutateAsync({ id: artifact.id, title })
      .then(() => {
        setRenameId(null);
        renameSheetRef.current?.dismiss();
      })
      .catch(() => showError("Could not rename this artifact."));
  }

  function confirmDelete(artifact: Artifact) {
    closeMenu();
    Alert.alert(
      "Delete artifact?",
      `Remove “${artifact.title}”? The source ${artifact.source.kind} will stay intact.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void remove
              .mutateAsync(artifact.id)
              .then(() => {
                if (selectedId === artifact.id) setSelectedId(null);
              })
              .catch(() => showError("Could not delete this artifact."));
          },
        },
      ],
    );
  }

  const sheets = (
    <>
      <ArtifactActionSheet
        ref={actionSheetRef}
        artifact={menuArtifact}
        busyAction={busyAction}
        onOpen={() => {
          closeMenu();
          if (menuArtifact) openArtifact(menuArtifact);
        }}
        onDownload={() => {
          closeMenu();
          if (menuArtifact) downloadArtifact(menuArtifact);
        }}
        onRename={() => menuArtifact && beginRename(menuArtifact)}
        onDelete={() => menuArtifact && confirmDelete(menuArtifact)}
        onClose={closeMenu}
        onDismiss={() => setMenuId(null)}
      />
      <RenameSheet
        ref={renameSheetRef}
        value={renameTitle}
        onChangeText={setRenameTitle}
        busy={rename.isPending}
        onSave={saveRename}
        onDismiss={() => setRenameId(null)}
      />
      <MediaViewer item={preview} onClose={() => setPreview(null)} />
      <HtmlArtifactViewer artifact={htmlView} onClose={() => setHtmlView(null)} />
      <UiBlockViewer artifact={blockView} onClose={() => setBlockView(null)} />
      <CsvViewer artifact={csvView} onClose={() => setCsvView(null)} />
    </>
  );

  const detail = selectedArtifact ? (
    <ArtifactDetail
      artifact={selectedArtifact}
      onBack={() => setSelectedId(null)}
      onOpen={() => openArtifact(selectedArtifact)}
      onDownload={() => downloadArtifact(selectedArtifact)}
      onMenu={() => openMenu(selectedArtifact)}
      onRename={() => beginRename(selectedArtifact)}
      onDelete={() => confirmDelete(selectedArtifact)}
      busy={!!busyAction}
    />
  ) : null;

  const list = (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          style={styles.headerButton}
          onPress={goBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back to navigation"
        >
          <BackIcon color={colors.ink} />
        </Pressable>
        <Text style={styles.headerTitle}>Artifacts</Text>
        <View style={styles.headerButton} />
      </View>

      <ArtifactFilterPills
        value={filter}
        onChange={(value) => {
          Keyboard.dismiss();
          setFilter(value);
        }}
      />

      <KeyboardAvoider style={styles.body}>
        <View style={styles.body}>
          {isLoading ? <ArtifactsSkeleton layout={layout} /> : null}
          {!isLoading && isError ? <ArtifactsErrorState onRetry={() => void refetch()} /> : null}
          {!isLoading && !isError ? (
            <Animated.FlatList
              ref={listRef as never}
              key={layout}
              data={entries}
              keyExtractor={entryKey}
              renderItem={renderEntry}
              numColumns={layout === "grid" ? 2 : 1}
              columnWrapperStyle={layout === "grid" && entries.length > 0 ? styles.gridRow : undefined}
              contentContainerStyle={[styles.scrollContent, entries.length === 0 && styles.scrollEmpty]}
              ListEmptyComponent={
                <ArtifactsEmptyState
                  body={query.trim() || filter !== "all" ? "Try another search or filter." : "Your artifacts will appear here."}
                />
              }
              refreshControl={
                <RefreshControl refreshing={pullRefreshing} onRefresh={pullToRefresh} tintColor={colors.muted} colors={[colors.ink]} />
              }
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
              initialNumToRender={4}
              maxToRenderPerBatch={4}
              windowSize={5}
              removeClippedSubviews={Platform.OS === "android"}
              scrollEventThrottle={16}
              onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
            />
          ) : null}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.topFade,
              {
                opacity: scrollY.interpolate({
                  inputRange: [0, 16, 40, 72],
                  outputRange: [0, 0.35, 0.8, 1],
                  extrapolate: "clamp",
                }),
              },
            ]}
          >
            <Svg width="100%" height="100%">
              <Defs>
                <LinearGradient id="artifactsTopFade" x1="0%" y1="0%" x2="0%" y2="100%">
                  <Stop offset="0" stopColor={colors.bg} stopOpacity={1} />
                  <Stop offset="0.35" stopColor={colors.bg} stopOpacity={0.85} />
                  <Stop offset="0.7" stopColor={colors.bg} stopOpacity={0.35} />
                  <Stop offset="1" stopColor={colors.bg} stopOpacity={0} />
                </LinearGradient>
              </Defs>
              <Rect width="100%" height="100%" fill="url(#artifactsTopFade)" />
            </Svg>
          </Animated.View>
        </View>
        <View style={[styles.searchFooter, { paddingBottom: keyboardOpen ? 14 : 14 + insets.bottom }]}>
          <View style={styles.searchFieldFlex}>
            <ArtifactSearchField value={query} onChangeText={setQuery} />
          </View>
          {keyboardOpen ? null : (
            <View style={styles.layoutToggle} accessibilityRole="radiogroup" accessibilityLabel="Artifact view">
              {(["grid", "list"] as const).map((option) => {
                const selected = layout === option;
                return (
                  <Pressable
                    key={option}
                    style={[styles.layoutOption, selected && styles.layoutOptionSelected]}
                    onPress={() => {
                      scrollY.setValue(0);
                      setLayout(option);
                    }}
                    accessibilityRole="radio"
                    accessibilityLabel={option === "grid" ? "Grid view" : "List view"}
                    accessibilityState={{ selected }}
                  >
                    <ArtifactGlyph name={option} size={18} color={selected ? colors.onInk : colors.muted} />
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      </KeyboardAvoider>
    </SafeAreaView>
  );

  return (
    <>
      {}
      <View style={styles.fill} accessibilityElementsHidden={!!detail} importantForAccessibility={detail ? "no-hide-descendants" : "auto"}>
        {list}
      </View>
      {detail ? <View style={styles.detailLayer}>{detail}</View> : null}
      {sheets}
    </>
  );
}

function ArtifactDetail({
  artifact,
  busy,
  onBack,
  onOpen,
  onDownload,
  onMenu,
  onRename,
  onDelete,
}: {
  artifact: Artifact;
  busy: boolean;
  onBack: () => void;
  onOpen: () => void;
  onDownload: () => void;
  onMenu: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const created = new Date(artifact.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.header}>
        <Pressable
          style={styles.headerButton}
          onPress={onBack}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back to artifacts"
        >
          <BackIcon color={colors.ink} />
        </Pressable>
        {}
        <Text style={styles.headerTitle} numberOfLines={1}>{artifactTypeLabel(artifact.type)}</Text>
        <Pressable
          style={styles.headerButton}
          onPress={onMenu}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`Artifact options for ${artifact.title}`}
        >
          <ArtifactGlyph name="more-horizontal" size={24} color={colors.ink} />
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.detailContent} showsVerticalScrollIndicator={false}>
        {isUiBlockArtifact(artifact) ? (
          <UiBlockArtifactView artifact={artifact} fallback={<ArtifactPreviewTile artifact={artifact} tall />} />
        ) : isCsv(artifact) ? (
          <Pressable style={styles.detailThumb} onPress={onOpen} disabled={busy} accessibilityRole="button" accessibilityLabel={`Preview ${artifact.title}`}>
            <CsvPreview artifact={artifact} fallback={<ArtifactPreviewTile artifact={artifact} tall />} />
          </Pressable>
        ) : (
        <Pressable
          style={styles.detailThumb}
          onPress={onOpen}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Preview ${artifact.title}`}
        >
          {isHtmlArtifact(artifact) ? (
            <HtmlArtifactPreview artifact={artifact} fallback={<ArtifactPreviewTile artifact={artifact} tall />} />
          ) : (
            <ArtifactPreviewTile artifact={artifact} tall />
          )}
        </Pressable>
        )}
        <Text style={styles.detailTitle}>{artifact.title}</Text>
        <View style={styles.metaRow}>
          <View style={styles.formatChip}>
            <ArtifactGlyph name={artifactTypeGlyph(artifact.type)} size={12} color={colors.ink} />
            <Text style={styles.formatChipText}>{artifactFormat(artifact)}</Text>
          </View>
          <Text style={styles.detailMeta}>{created}</Text>
          <Text style={styles.detailMeta}>·</Text>
          <Text style={styles.detailMeta}>{formatBytes(artifact.bytes)}</Text>
        </View>
        <Text style={styles.detailFrom}>
          {`From the ${artifact.source.kind} `}
          <Text style={styles.detailFromName}>{artifact.source.title}</Text>
        </Text>
        <View style={styles.actionList}>
          <Pressable
            style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
            onPress={onRename}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Rename ${artifact.title}`}
          >
            <ArtifactGlyph name="pencil" size={18} color={colors.ink} />
            <Text style={styles.actionLabel}>Rename</Text>
            <View style={styles.chevronRight}>
              <Icon name="chevron" size={18} color={colors.muted} />
            </View>
          </Pressable>
          <View style={styles.actionDivider} />
          <Pressable
            style={({ pressed }) => [styles.actionRow, pressed && styles.actionRowPressed]}
            onPress={onDelete}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${artifact.title}`}
          >
            <ArtifactGlyph name="trash" size={18} color={colors.status.redText} />
            <Text style={[styles.actionLabel, styles.actionDanger]}>Delete</Text>
          </Pressable>
        </View>
      </ScrollView>
      <View style={styles.detailFooter}>
        <Pressable
          style={[styles.footDownload, busy && styles.buttonDisabled]}
          onPress={onDownload}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Download ${artifact.title}`}
        >
          {busy ? <ActivityIndicator color={colors.ink} /> : <ArtifactGlyph name="download" size={16} color={colors.ink} />}
          <Text style={styles.footDownloadText}>{artifactFormat(artifact)}</Text>
        </Pressable>
        <Pressable
          style={[styles.footOpen, busy && styles.buttonDisabled]}
          onPress={onOpen}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={`Open ${artifact.title}`}
        >
          <ArtifactGlyph name="open" size={16} color={colors.onInk} />
          <Text style={styles.footOpenText}>Open</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const RenameSheet = forwardRef<BottomSheetModal, {
  value: string;
  onChangeText: (value: string) => void;
  busy: boolean;
  onSave: () => void;
  onDismiss: () => void;
}>(function RenameSheet({ value, onChangeText, busy, onSave, onDismiss }, ref) {
  const styles = useStyles(makeStyles);
  const { colors, keyboardAppearance, textSelectionColor } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const renderBackdrop = useCallback(
    (p: React.ComponentProps<typeof BottomSheetBackdrop>) => (
      <BottomSheetBackdrop {...p} appearsOnIndex={0} disappearsOnIndex={-1} pressBehavior="close" />
    ),
    [],
  );
  const close = () => {
    if (ref && typeof ref !== "function") ref.current?.dismiss();
  };
  return (
    <BottomSheetModal
      ref={ref}
      onDismiss={onDismiss}
      enableDynamicSizing
      enablePanDownToClose
      animateOnMount={!reduceMotion}
      backdropComponent={renderBackdrop}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      backgroundStyle={styles.sheetBackground}
      handleIndicatorStyle={styles.sheetHandle}
    >
      <BottomSheetView style={[styles.renameContent, { paddingBottom: space.lg + insets.bottom }]}>
        <View style={styles.renameHead}>
          <Text style={styles.sheetTitle}>Rename artifact</Text>
          <Pressable
            style={({ pressed }) => [styles.renameClose, pressed && styles.buttonDisabled]}
            onPress={close}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Icon name="close" size={18} color={colors.ink} strokeWidth={2} />
          </Pressable>
        </View>
        <FocusRing radius={radius.md}>
          {(focus) => (
            <BottomSheetTextInput
              keyboardAppearance={keyboardAppearance}
              style={styles.renameInput}
              value={value}
              onChangeText={onChangeText}
              maxLength={160}
              autoFocus
              selectTextOnFocus
              returnKeyType="done"
              onSubmitEditing={onSave}
              placeholder="Artifact title"
              placeholderTextColor={colors.muted}
              selectionColor={textSelectionColor}
              cursorColor={colors.ink}
              selectionHandleColor={colors.ink}
              onFocus={() => focus.onFocus()}
              onBlur={() => focus.onBlur()}
              accessibilityLabel="Artifact title"
            />
          )}
        </FocusRing>
        <Pressable
          style={[styles.saveButton, busy && styles.buttonDisabled]}
          onPress={onSave}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel="Save title"
        >
          {busy ? <ActivityIndicator color={colors.onInk} /> : <Text style={styles.saveButtonText}>Save</Text>}
        </Pressable>
      </BottomSheetView>
    </BottomSheetModal>
  );
});

const ArtifactItem = memo(function ArtifactItem({
  artifact,
  busy,
  layout,
  onSelect,
  onMenu,
}: {
  artifact: Artifact;
  busy: boolean;
  layout: ArtifactLayout;
  onSelect: (id: string) => void;
  onMenu: (artifact: Artifact) => void;
}) {
  const styles = useStyles(makeStyles);
  const select = useCallback(() => onSelect(artifact.id), [artifact.id, onSelect]);
  const menu = useCallback(() => onMenu(artifact), [artifact, onMenu]);

  if (layout === "list") {
    return <ArtifactListRow artifact={artifact} busy={busy} onPress={select} onOverflow={menu} />;
  }
  return (
    <View style={styles.gridItem}>
      <ArtifactCard artifact={artifact} busy={busy} onPress={select} onOverflow={menu} />
    </View>
  );
});

function entryKey(entry: ArtifactEntry): string {
  return entry.key;
}

function artifactFormat(artifact: Artifact): string {
  const extension = artifact.filename.split(".").pop()?.trim();
  return extension && extension.length <= 8 ? extension.toUpperCase() : artifact.type.toUpperCase();
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showError(message: string): void {
  Alert.alert("Artifacts", message);
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  headerButton: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    flex: 1,
    marginHorizontal: space.xs,
    fontFamily: font.family.semi,
    fontSize: 18,
    lineHeight: 24,
    textAlign: "center",
    textAlignVertical: "center",
    includeFontPadding: false,
    color: colors.ink,
  },
  body: { flex: 1, overflow: "hidden" },
  topFade: { position: "absolute", top: 0, left: 0, right: 0, height: 40 },
  scrollContent: { flexGrow: 1, gap: space.md, paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20 },
  scrollEmpty: { justifyContent: "center" },
  searchFooter: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: 11,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.bg,
  },
  gridRow: { gap: space.md },
  gridItem: { flex: 1, maxWidth: "50%" },
  searchFieldFlex: { flex: 1, minWidth: 0 },
  layoutToggle: {
    height: 49,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    padding: space.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.soft,
  },
  layoutOption: {
    width: 41,
    height: 41,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
  },
  layoutOptionSelected: { backgroundColor: colors.ink },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.md,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    backgroundColor: colors.bg,
  },
  fill: { flex: 1 },
  detailLayer: { ...StyleSheet.absoluteFill, backgroundColor: colors.bg },
  detailContent: { paddingHorizontal: space.lg, paddingTop: 20, paddingBottom: 20 },
  detailThumb: { overflow: "hidden", borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line },
  metaRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: space.sm },
  formatChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.soft },
  formatChipText: { includeFontPadding: false, fontFamily: font.family.medium, fontSize: 12, color: colors.ink },
  detailFrom: { marginTop: space.sm, includeFontPadding: false, fontFamily: font.family.regular, fontSize: 12, color: colors.muted },
  detailFromName: { fontFamily: font.family.medium, color: colors.ink },
  actionList: { marginTop: space.lg, overflow: "hidden", borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line },
  actionRow: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: space.lg },
  actionRowPressed: { backgroundColor: colors.soft },
  actionLabel: { flex: 1, includeFontPadding: false, fontFamily: font.family.regular, fontSize: font.size.base + 1, color: colors.ink },
  actionDanger: { color: colors.status.redText },
  actionDivider: { height: 1, backgroundColor: colors.line },
  chevronRight: { transform: [{ rotate: "-90deg" }] },
  detailFooter: { flexDirection: "row", gap: space.sm, paddingHorizontal: space.lg, paddingTop: 10, paddingBottom: space.md, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.bg },
  footDownload: { flex: 1, minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.bg },
  footDownloadText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: font.size.base, color: colors.ink },
  footOpen: { flex: 1.6, minHeight: 50, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, borderRadius: radius.pill, backgroundColor: colors.ink },
  footOpenText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: font.size.base, color: colors.onInk },
  detailTitle: { marginTop: space.lg, includeFontPadding: false, fontFamily: font.family.semi, fontSize: 21, lineHeight: 27, color: colors.ink },
  detailMeta: { includeFontPadding: false, fontFamily: font.family.regular, fontSize: font.size.sm, color: colors.muted },
  detailPreview: { marginTop: space.lg },
  openButton: {
    minHeight: 47,
    marginTop: space.lg,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.soft,
  },
  openButtonText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: font.size.base, color: colors.ink },
  downloadButton: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
  },
  downloadButtonText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: font.size.base, color: colors.onInk },
  buttonDisabled: { opacity: 0.6 },
  sheetBackground: {
    borderTopLeftRadius: 27,
    borderTopRightRadius: 27,
    backgroundColor: colors.surfaceRaised,
  },
  sheetHandle: { width: 35, height: 4, borderRadius: radius.pill, backgroundColor: colors.borderRaised },
  renameContent: { paddingHorizontal: space.lg, paddingTop: space.xs },
  renameHead: { flexDirection: "row", alignItems: "flex-start", gap: space.md, marginBottom: space.lg },
  renameClose: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.soft, alignItems: "center", justifyContent: "center" },
  sheetTitle: { flex: 1, minWidth: 0, includeFontPadding: false, fontFamily: font.family.bold, fontSize: font.size.title, letterSpacing: -0.5, color: colors.ink },
  renameInput: {
    minHeight: 42,
    paddingHorizontal: space.md,
    fontFamily: font.family.medium,
    includeFontPadding: false,
    fontSize: 15,
    color: colors.ink,
  },
  saveButton: {
    minHeight: 50,
    marginTop: space.md,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.ink,
  },
  saveButtonText: { includeFontPadding: false, fontFamily: font.family.semi, fontSize: font.size.base, color: colors.onInk },
});
