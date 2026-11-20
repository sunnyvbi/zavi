import { sheetInput as input, sheetLabel as label, sheetHint as hint } from "../managed-campaigns/AdsSheet";

export function validVideoSource(value: string): boolean {
  if (!value) return false;
  if (!value.startsWith("url:")) return /^(library|upload|zavi):.+/.test(value);
  if (!/^https:\/\/\S+$/i.test(value.slice(4))) return false;
  try { const url = new URL(value.slice(4)); return url.protocol === "https:" && !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}

export function VideoUrlField({ value, onChange, disabled }: { value: string; onChange: (source: string) => void; disabled: boolean }) {
  const url = value.startsWith("url:") ? value.slice(4) : "";
  return <div>
    <label className={label}>Public HTTPS video URL<input className={input} type="url" placeholder="https://example.com/video.mp4" value={url} disabled={disabled} onChange={e => onChange(e.target.value ? `url:${e.target.value.trim()}` : "")} /></label>
    <p className={hint}>Or use a public video link that opens without signing in. We upload a copy to your ad library. Choosing a link replaces your pending upload or library selection.</p>
    {url && !validVideoSource(value) && <p role="status" className={hint}>Enter an HTTPS video URL without a username or password.</p>}
  </div>;
}
