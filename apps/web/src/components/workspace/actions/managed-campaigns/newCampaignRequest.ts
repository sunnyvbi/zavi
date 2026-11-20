
type Opener = () => void;
let opener: Opener | null = null;

export function registerNewCampaignOpener(fn: Opener): () => void {
  opener = fn;
  return () => {
    if (opener === fn) opener = null;
  };
}

export function openNewCampaign(): boolean {
  if (!opener) return false;
  opener();
  return true;
}
