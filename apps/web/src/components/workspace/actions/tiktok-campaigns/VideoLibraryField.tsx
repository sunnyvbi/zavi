import { useEffect, useId, useState } from "react";
import { campaignFetch } from "../managed-campaigns/api";
import { SheetSelect, sheetInput as input, sheetLabel as label, sheetHint as hint } from "../managed-campaigns/AdsSheet";
import { TIKTOK_CAMPAIGN_API, type TiktokCampaignOptions } from "./types";

type LibraryVideo = TiktokCampaignOptions["videos"][number];
type VideoPage = { videos: LibraryVideo[]; next_page: number | null; page: number; truncated: boolean };
export function VideoLibraryField({ advertiserId, value, onChange, options, disabled }: { advertiserId: string; value: string; onChange: (id: string) => void; options: TiktokCampaignOptions | null; disabled: boolean }) {
  const id = useId();
  const [videos, setVideos] = useState<LibraryVideo[]>(options?.videos ?? []);
  const [nextPage, setNextPage] = useState<number | null>(options?.videos_next_page ?? null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setVideos(options?.videos ?? []); setNextPage(options?.videos_next_page ?? null); setError(""); }, [options]);
  const selected = videos.find(v => v.video_id === value);
  const matches = videos.filter(v => `${v.name} ${v.video_id}`.toLowerCase().includes(search.toLowerCase()));
  async function loadMore() {
    if (!nextPage || loading || disabled) return;
    setLoading(true); setError("");
    try {
      const page = await campaignFetch<VideoPage>(`${TIKTOK_CAMPAIGN_API}/campaign-videos?advertiser_id=${encodeURIComponent(advertiserId)}&page=${nextPage}`);
      setVideos(current => [...new Map([...current, ...page.videos].map(v => [v.video_id, v])).values()]);
      setNextPage(page.next_page);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load more videos. Try again."); }
    finally { setLoading(false); }
  }
  return <div className="space-y-2">
    <label className={label} htmlFor={`${id}-search`}>Search loaded videos</label>
    <input id={`${id}-search`} className={input} value={search} disabled={disabled} placeholder="Name or video ID" onChange={e => setSearch(e.target.value)} />
    <label className={label} htmlFor={`${id}-video`}>Video in this ad account</label>
    <SheetSelect id={`${id}-video`} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}><option value="">Choose a video</option>{value && !matches.some(v => v.video_id === value) && <option value={value}>{selected?.name ?? "Selected video"} · {value}</option>}{matches.map(v => <option key={v.video_id} value={v.video_id}>{v.name} · {v.video_id}</option>)}</SheetSelect>
    {!matches.length && <p className={hint}>{search ? "No loaded videos match your search." : "No videos have been loaded from this ad account."}</p>}
    {selected?.preview_url && <img className="max-h-72 max-w-full rounded-xl" src={selected.preview_url} alt="Selected ad video cover" />}
    {nextPage && <button type="button" className="text-sm underline" disabled={disabled || loading} onClick={() => void loadMore()}>{loading ? "Loading videos…" : "Load more videos"}</button>}
    {options?.videos_truncated && !nextPage && <p className={hint}>The library list is partial. Upload or choose a Zavi video below if your video is missing.</p>}
    {options?.videos_error && <p role="status" className={hint}>Your ad library could not be loaded. Your current video selection is preserved.</p>}
    {error && <p role="alert" className={hint}>{error}</p>}
    <p className={hint}>Search applies to {videos.length} loaded videos. The image is the video cover.</p>
  </div>;
}
