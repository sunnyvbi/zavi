import { useEffect, useState, type ReactNode } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "../Icon";
import { PageSkeleton } from "./HtmlArtifactViewer";
import { fetchArtifactPreviewUrl } from "../../features/artifacts/api";
import { CSV_ROW_CAP, csvPreview } from "../../features/artifacts/csv";
import type { Artifact } from "../../features/artifacts/types";
import { font, space, type Colors } from "../../theme/tokens";
import { useStyles, useTheme } from "../../theme/theme";

const MAX_CSV_CHARS = 2_000_000;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function loadCsv(id: string): Promise<string> {
  const hit = cache.get(id);
  if (hit !== undefined) return Promise.resolve(hit);
  const running = inflight.get(id);
  if (running) return running;
  const job = fetchArtifactPreviewUrl(id)
    .then(async ({ signed_url }) => {
      const text = await (await fetch(signed_url)).text();
      if (text.length > MAX_CSV_CHARS) throw new Error("too large");
      cache.set(id, text);
      return text;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

function useCsv(artifact: Artifact | null) {
  const [text, setText] = useState<string | null>(() => (artifact ? cache.get(artifact.id) ?? null : null));
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setText(artifact ? cache.get(artifact.id) ?? null : null);
    setFailed(false);
    if (!artifact) return;
    let alive = true;
    loadCsv(artifact.id)
      .then((t) => {
        if (alive) setText(t);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [artifact]);
  return { text, failed };
}

type TableProps = { header: string[]; body: string[][]; columns?: number; compact?: boolean };

function Table({ header, body, columns, compact = false }: TableProps) {
  const styles = useStyles(makeStyles);
  const cols = header.slice(0, columns ?? header.length);
  const cell = compact ? styles.cellSmall : styles.cell;
  return (
    <View>
      <View style={styles.headRow}>
        {cols.map((h, i) => (
          <Text key={i} style={[cell, styles.headCell, !compact && styles.cellWidth, compact && styles.cellFlex]} numberOfLines={1}>
            {h || `Column ${i + 1}`}
          </Text>
        ))}
      </View>
      {body.map((row, r) => (
        <View key={r} style={[styles.row, r % 2 === 1 && styles.rowAlt]}>
          {cols.map((_, c) => (
            <Text key={c} style={[cell, styles.bodyCell, !compact && styles.cellWidth, compact && styles.cellFlex]} numberOfLines={compact ? 1 : 3}>
              {row[c] ?? ""}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

export function CsvThumb({ artifact, fallback }: { artifact: Artifact; fallback: ReactNode }) {
  const styles = useStyles(makeStyles);
  const { text, failed } = useCsv(artifact);
  if (failed) return <>{fallback}</>;
  if (text === null) {
    return (
      <View style={styles.cover}>
        <PageSkeleton compact />
      </View>
    );
  }
  const { header, body } = csvPreview(text, 4);
  if (header.length === 0) return <>{fallback}</>;
  return (
    <View style={styles.cover} pointerEvents="none">
      <Table header={header} body={body} columns={3} compact />
    </View>
  );
}

export function CsvPreview({ artifact, fallback }: { artifact: Artifact; fallback: ReactNode }) {
  const styles = useStyles(makeStyles);
  const { text, failed } = useCsv(artifact);
  if (failed) return <>{fallback}</>;
  if (text === null) {
    return (
      <View style={styles.frame}>
        <PageSkeleton compact />
      </View>
    );
  }
  const { header, body } = csvPreview(text, 6);
  if (header.length === 0) return <>{fallback}</>;
  return (
    <View style={styles.frame} pointerEvents="none">
      <ScrollView horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false}>
        <Table header={header} body={body} />
      </ScrollView>
    </View>
  );
}

export function CsvViewer({ artifact, onClose }: { artifact: Artifact | null; onClose: () => void }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { text, failed } = useCsv(artifact);
  const data = text === null ? null : csvPreview(text, CSV_ROW_CAP);
  return (
    <Modal visible={!!artifact} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[styles.safe, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <View style={styles.bar}>
          <Text style={styles.title} numberOfLines={1}>
            {artifact?.title ?? ""}
          </Text>
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
        {failed ? (
          <Text style={styles.note}>This spreadsheet can't be shown here. Download it to see it.</Text>
        ) : data === null ? (
          <PageSkeleton />
        ) : data.header.length === 0 ? (
          <Text style={styles.note}>This spreadsheet is empty.</Text>
        ) : (
          <ScrollView contentContainerStyle={styles.viewerContent}>
            <ScrollView horizontal showsHorizontalScrollIndicator>
              <Table header={data.header} body={data.body} />
            </ScrollView>
            {data.more ? <Text style={styles.note}>{`Showing the first ${CSV_ROW_CAP} rows. Download the file for the rest.`}</Text> : null}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

const makeStyles = (colors: Colors) =>
  StyleSheet.create({
    safe: { flex: 1, backgroundColor: colors.bg },
    bar: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
    title: { flex: 1, minWidth: 0, includeFontPadding: false, fontFamily: font.family.semi, fontSize: font.size.lg, color: colors.ink },
    close: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.soft, alignItems: "center", justifyContent: "center" },
    pressed: { opacity: 0.7 },
    cover: { ...StyleSheet.absoluteFill, backgroundColor: colors.bg, overflow: "hidden" },
    frame: { overflow: "hidden", aspectRatio: 1.25, backgroundColor: colors.bg },
    viewerContent: { padding: space.lg, gap: space.md },
    headRow: { flexDirection: "row", backgroundColor: colors.avatarGreen, borderBottomWidth: 1, borderBottomColor: colors.line },
    row: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.bg },
    rowAlt: { backgroundColor: colors.soft },
    cell: { paddingHorizontal: 12, paddingVertical: 8, fontFamily: font.family.regular, fontSize: 12, lineHeight: 16 },
    cellSmall: { paddingHorizontal: 6, paddingVertical: 4, fontFamily: font.family.regular, fontSize: 8, lineHeight: 11 },
    cellWidth: { width: 150 },
    cellFlex: { flex: 1 },
    headCell: { fontFamily: font.family.semi, color: colors.ink },
    bodyCell: { color: colors.muted },
    note: { padding: space.lg, fontFamily: font.family.regular, fontSize: 12, color: colors.muted },
  });
