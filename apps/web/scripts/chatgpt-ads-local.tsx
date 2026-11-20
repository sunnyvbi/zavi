import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelActionCard } from '../src/components/workspace/actions/ChannelActionCard';
import { CampaignWorkspace } from '../src/components/workspace/actions/managed-campaigns/CampaignWorkspace';
import { CampaignSafetyControls } from '../src/components/workspace/actions/managed-campaigns/CampaignSafetyControls';
import { chatgpt_ads } from '../src/components/workspace/actions/platforms/chatgpt_ads';
function LocalAds() {
  const [data,setData]=useState<any>(null), [message,setMessage]=useState(''), [busy,setBusy]=useState(false);
  async function refresh() {const r=await fetch('/sandbox/state');if(!r.ok)throw new Error('Local database unavailable');setData(await r.json());}
  useEffect(()=>{void refresh().catch(e=>setMessage(e.message));},[]);
  async function scenario(action:string) {
    setBusy(true);
    try {const r=await fetch('/sandbox/scenario',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});const b=await r.json();if(!r.ok)throw new Error(b.error.message);setMessage(b.message);await refresh();window.dispatchEvent(new Event('focus'));}
    catch(e){setMessage(e instanceof Error?e.message:'Scenario failed');}finally{setBusy(false);}
  }
  return <main className="mx-auto max-w-6xl p-4 sm:p-8"><h1 className="text-2xl font-semibold">ChatGPT Ads · local test workspace</h1><p className="my-3 text-sm">Real PostgreSQL wallet tables and shared campaign controls. Identity, payments and the ad network are simulated. This is separate from your developer account. No sign-in or real card is needed. Restart the server to reset.</p>
    <section className="my-5 rounded-xl border border-rule bg-bone p-4"><h2 className="font-semibold">Test scenarios</h2><div className="mt-3 flex flex-wrap gap-2">{[['topup','Simulate $100 top-up'],['enable-refill','Enable test refill'],['dispute','Dispute $10'],['refund','Refund latest top-up'],['failed-refund','Fail latest refund'],['spend','Record $80 campaign spend'],['claim','Check refill claim'],['lock','Toggle channel lock'],['downgrade','Toggle downgrade'],['metrics','Toggle metrics outage']].map(([a,label])=><button disabled={busy} className="rounded-lg border border-rule bg-cream px-3 py-2 text-sm disabled:opacity-40" key={a} onClick={()=>void scenario(a)}>{label}</button>)}</div><p role="status" className="mt-3 text-sm">{message}</p></section>
    {!data?.locked && data?.actions && <section className="my-6 space-y-4"><h2 className="text-xl font-medium">Next steps · simulated action approval</h2>{data.actions.map((a:any)=><ChannelActionCard key={a.id} action={a} platform={chatgpt_ads} handlers={{onSetStatus:()=>{},onRedo:()=>{},onApprove:async action=>{const r=await fetch(`/sandbox/actions/${action.id}/approve`,{method:'POST'});const out=await r.json();await refresh();if(!r.ok)throw new Error(out.error.message);return true;}}} />)}</section>}
    {data?.locked ? <><p>Channel locked. Only balance and pause controls are available.</p><CampaignSafetyControls spec={chatgpt_ads.campaignWorkspace!}/></> : <CampaignWorkspace spec={chatgpt_ads.campaignWorkspace!} payload={data?.payload} days={30} loading={!data} onRefresh={()=>void refresh()} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<LocalAds/>);
