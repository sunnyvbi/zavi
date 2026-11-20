import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { parseUiBlock, type UiBlock } from "@zavi/shared";
import type { RunArtifact } from "../../features/agents/runArtifacts";
import { signArtifactUrl } from "../../features/agents/runArtifacts";
import { SkeletonBlock } from "../Skeleton";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";
import { Card } from "./ui";
import { ChartBlock } from "./uiblocks/ChartBlock";
import { HtmlBlock } from "./uiblocks/HtmlBlock";
import { KpiBlock } from "./uiblocks/KpiBlock";
import { PostsBlock } from "./uiblocks/PostsBlock";
import { TableBlock } from "./uiblocks/TableBlock";

async function loadUiBlock(artifactId: string, signal?: AbortSignal): Promise<UiBlock | null> {
  try {
    const url = await signArtifactUrl(artifactId);
    if (!url) return null;
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    return parseUiBlock(await res.json());
  } catch {
    return null;
  }
}

export function UiBlockCard({
  artifact,
  fallback,
}: {
  artifact: RunArtifact;
  fallback: ReactNode;
}) {
  const query = useQuery({
    queryKey: ["ui-block-artifact", artifact.id],
    queryFn: ({ signal }) => loadUiBlock(artifact.id, signal),
    staleTime: Infinity,
  });

  if (query.isLoading) return <UiBlockSkeleton filename={artifact.filename} />;
  if (!query.data) return <>{fallback}</>;
  return <LoadedUiBlock block={query.data} />;
}

function LoadedUiBlock({ block }: { block: UiBlock }) {
  switch (block.kind) {
    case "chart":
      return <ChartBlock block={block} />;
    case "kpi":
      return <KpiBlock block={block} />;
    case "table":
      return <TableBlock block={block} />;
    case "posts":
      return <PostsBlock block={block} />;
    case "html":
      return <HtmlBlock block={block} />;
  }
}

function UiBlockSkeleton({ filename }: { filename: string }) {
  const styles = useStyles(makeStyles);
  return (
    <Card style={styles.card}>
      <View
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel={`Loading ${filename}`}
        style={styles.skeleton}
      >
        <View style={styles.head}>
          <SkeletonBlock width="42%" height={18} radius={6} />
        </View>
        <SkeletonBlock width="100%" height={14} radius={5} />
        <SkeletonBlock width="82%" height={14} radius={5} />
        <SkeletonBlock width="64%" height={14} radius={5} />
        <Text style={styles.loading}>Loading visual...</Text>
      </View>
    </Card>
  );
}

const makeStyles = (colors: Colors) => StyleSheet.create({
  card: {
    minHeight: 112,
    borderRadius: radius.lg,
  },
  skeleton: { gap: space.sm },
  head: { marginBottom: space.xs },
  loading: {
    fontSize: 12,
    lineHeight: 16,
    fontFamily: font.family.regular,
    color: colors.muted,
  },
});
