import { useQuery } from "@tanstack/react-query";
import { adReviewPresentationSchema, type AdReviewCreative, type AdReviewResponse } from "@zavi/shared";
import { Image, StyleSheet, Text, View } from "react-native";
import { campaignFetch } from "../../features/channels/managedCampaignsHooks";
import { useActiveTenant } from "../../features/workspaces/useActiveTenant";
import { CardButton } from "../reply/ui";
import { openCampaignWeb } from "./CampaignWorkspace";
import { font, radius, space, type Colors } from "../../theme/tokens";
import { useStyles } from "../../theme/theme";

export function CampaignAdReview({ actionId, actionStatus, execStatus }: { actionId: string; actionStatus?: string; execStatus?: string | null }) {
  const styles = useStyles(makeStyles);
  const tenant = useActiveTenant();
  const review = useQuery({
    queryKey: ["campaign-ad-review", tenant, actionId, actionStatus, execStatus],
    enabled: tenant !== "none",
    queryFn: async () => {
      const response = await campaignFetch<AdReviewResponse>(`/api/channel-actions/${encodeURIComponent(actionId)}/ad-review`);
      return { review: response.review ? adReviewPresentationSchema.parse(response.review) : null, editable: response.editable === true, limitations: response.limitations ?? [] };
    },
  });
  const preview = review.data?.review;
  const editable = review.data?.editable === true && actionStatus === "pending" && (!execStatus || execStatus === "failed");
  return <View style={styles.wrap}>
    <Text style={styles.label}>Saved ad preview</Text>
    {review.isLoading ? <Text style={styles.body}>Reading the saved campaign…</Text> : null}
    {review.isError ? <Text style={styles.body}>The preview could not be read. Open the web review to check this action.</Text> : null}
    {preview?.cost ? <Text style={styles.body}>{preview.cost}</Text> : null}
    {preview?.schedule ? <View>
      <Text style={styles.label}>Schedule (UTC)</Text>
      <Text style={styles.body}>Start: {preview.schedule.start ?? "Not set"}</Text>
      <Text style={styles.body}>End: {preview.schedule.end ?? "Not set"}</Text>
    </View> : null}
    {preview?.creatives.map((creative, index) => <Creative key={index} creative={creative} />)}
    {!review.isLoading && !review.isError && !preview ? <Text style={styles.body}>No saved creative preview is available for this action.</Text> : null}
    {review.data?.limitations.map((message, index) => <Text key={index} style={styles.body}>{message}</Text>)}
    <Text style={styles.body}>{editable ? "Edit the creative and exact UTC schedule, then approve separately on the web." : "This is a read-only preview. Open the web review to check the action’s current status."}</Text>
    <CardButton label={editable ? "Review and edit on web" : "View action on web"} onPress={() => void openCampaignWeb()} />
  </View>;
}

function Creative({ creative }: { creative: AdReviewCreative }) {
  const styles = useStyles(makeStyles);
  const tenant = useActiveTenant();
  const image = useQuery({
    queryKey: ["campaign-ad-image", tenant, creative.image_path],
    enabled: tenant !== "none" && !!creative.image_path,
    queryFn: async () => (await campaignFetch<{ signed_url: string }>(`/api/chat/image-url?path=${encodeURIComponent(creative.image_path!)}`)).signed_url,
  });
  const imageUrl = creative.image_path ? image.data : creative.image_url;
  return <View style={styles.creative}>
    {imageUrl ? <Image source={{ uri: imageUrl }} style={styles.image} accessibilityLabel="Saved ad image" /> : null}
    {image.isError ? <Text style={styles.body}>The saved image could not be previewed. Review it on the web.</Text> : null}
    {creative.title ? <Text style={styles.label}>{creative.title}</Text> : null}
    {creative.body ? <Text style={styles.body}>{creative.body}</Text> : null}
    {creative.target_url ? <Text style={styles.body} selectable>{creative.target_url}</Text> : null}
  </View>;
}
const makeStyles = (colors: Colors) => StyleSheet.create({
  wrap: { gap: space.md, marginTop: space.lg },
  creative: { gap: space.sm, padding: space.md, backgroundColor: colors.soft, borderRadius: radius.md },
  label: { fontFamily: font.family.medium, fontSize: 14, lineHeight: 18, color: colors.ink },
  body: { fontFamily: font.family.regular, fontSize: 14, lineHeight: 21, color: colors.textSecondary },
  image: { width: "100%", height: 180, borderRadius: radius.md },
});
