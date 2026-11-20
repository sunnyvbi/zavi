// @ts-nocheck
import express from 'express';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { tenant, state, adsWebhookStripe } from './fixtures';
import * as routes from '../../src/routes/channels/chatgpt-ads';
import * as wallet from '../../src/routes/channels/chatgpt-ads-wallet';
import { stripeAdsWebhook } from '../../src/routes/webhooks/stripe-ads';
import { executeCampaignAction } from '../../src/services/connectors/chatgpt-ads/action-execution';
import { readWallet } from '../../src/services/channels/chatgpt-ads/wallet';

async function main() {
  process.env.CHATGPT_ADS_FUNDING_ENABLED='true';
  process.env.STRIPE_ADS_WEBHOOK_SECRET='whsec_local_simulation';
  process.env.CHATGPT_ADS_SERVING_APPROVED='true';
  process.env.CHATGPT_ADS_ADVERTISER_WEBSITE='https://example.com';
  state.db = new PGlite();
  await state.db.exec('create role anon; create role authenticated; create role service_role; create table tenants(id uuid primary key, slug text);');
  for (const file of ['20260924183000_chatgpt_ads_wallet.sql','20260925083000_chatgpt_ads_wallet_controls.sql','20260925120000_chatgpt_ads_resource_bindings.sql','20260925121000_chatgpt_ads_daily_coverage.sql','20261005100050_ads_wallet_creator_consent.sql','20261017090000_chatgpt_ads_wallet_final_release.sql','20261101161000_shared_ads_wallet_bindings.sql']) await state.db.exec(readFileSync(resolve(process.env.ADS_LOCAL_REPO,'supabase/migrations',file),'utf8'));
  await state.db.query("insert into tenants values ($1,'upcar-local')",[tenant]);
  await state.db.query("insert into ads_wallets(tenant_id,stripe_customer_id,payment_method_id) values ($1,'cus_local','pm_local')",[tenant]);
  await state.db.query("insert into ads_conversion_sources(source_id,tenant_id) values ('local_source',$1)",[tenant]);
  await state.db.query("insert into ads_resource_bindings(resource_id,tenant_id,kind,source_id) values ('local_event',$1,'conversion_event','local_source'),('local_audience',$1,'audience',null),('local_feed',$1,'product_feed',null)",[tenant]);
  await state.db.exec(`create table tenant_users(tenant_id uuid, user_id uuid, role text);
    create table channel_actions(id uuid primary key, tenant_id uuid, channel_slug text, title text,
      body jsonb, status text default 'pending', exec_class text, exec_status text, exec_payload jsonb,
      approved_by uuid, action_type text, card_kind text, primary_label text, done_label text, how_to jsonb);
    create table channel_action_events(tenant_id uuid, action_id uuid, event text, actor_kind text,
      actor_user_id uuid, event_key text, unique(action_id,event_key));`);
  await state.db.exec(readFileSync(resolve(process.env.ADS_LOCAL_REPO,'supabase/migrations/20260926090000_channel_campaign_action_review.sql'),'utf8'));
  await state.db.query("insert into tenant_users values ($1,$1,'owner')",[tenant]);
  const actionId='00000000-0000-4000-8000-000000000002';
  const draft={type:'campaign_draft',name:'Local campaign test',bidding_type:'clicks',group:{name:'Local buyer intent',context_hints:['Which option fits my trip?']},ads:[{name:'Local card',title:'Find a car for your trip',body:'Explore available cars',target_url:'https://example.com/cars',image_url:'https://example.com/car.png',tracking:'utm_source=chatgpt&utm_medium=paid'}]};
  await state.db.query("insert into channel_actions(id,tenant_id,channel_slug,title,body,action_type,card_kind,primary_label) values($1,$2,'chatgpt_ads','Let Zavi create a paused test campaign',$3,'create_ad','task','Review and create')",[actionId,tenant,{step:{responsibility:'client',body:'Review the draft, choose your test budget and let Zavi create the campaign and ad.',deliverable:{kind:'ad',content:'A local sample campaign. All provider writes are simulated.',presentation:draft}}}]);
  const app=express();
  app.use((req,res,next)=> { if(req.headers.host!=='127.0.0.1:4318' || (req.headers.origin && req.headers.origin!=='http://127.0.0.1:4318')) return res.status(403).end(); next(); });
  app.post('/api/webhooks/stripe/ads',express.raw({type:'application/json'}),stripeAdsWebhook);
  app.use(express.json());
  const base='/api/channels/chatgpt_ads';
  app.get(`${base}/wallet`,(req,res)=> { const json=res.json.bind(res); res.json=data=>json({...data,funding_enabled:false}); return wallet.chatgptWallet(req,res); }); app.post(`${base}/wallet/disable-refill`,wallet.chatgptDisableRefill); app.post(`${base}/wallet/checkout`,(_req,res)=>res.status(503).json({error:{message:'Hosted Checkout is unavailable in this simulator. Use the labelled test scenarios.'}}));
  app.get(`${base}/actions/:actionId/review`,routes.chatgptReviewAction);
  app.post(`${base}/actions/:actionId/prepare`,routes.chatgptPrepareAction);
  app.post('/sandbox/actions/:id/approve',async(req,res)=> {
    try {
      const row=(await state.db.query('select * from channel_actions where id=$1 and tenant_id=$2',[req.params.id,tenant])).rows[0];
      if(!row?.exec_class)throw new Error('Review this draft first.');
      if(row.exec_status==='executed')return res.json({ok:true});
      await state.db.query("update channel_actions set exec_status='dispatching',approved_by=$2 where id=$1",[row.id,tenant]);
      try { await executeCampaignAction(row.id,tenant,tenant); }
      catch(e) { await state.db.query("update channel_actions set exec_status='failed' where id=$1",[row.id]);throw e; }
      await state.db.query("update channel_actions set exec_status='executed',status='acted' where id=$1",[row.id]);
      res.json({ok:true});
    } catch(e) {res.status(400).json({error:{message:e.message}});}
  });
  app.get(`${base}/locations`,routes.chatgptLocations);
  app.get(`${base}/resources`,routes.chatgptResources);
  app.get(`${base}/campaigns/:campaignId`,routes.chatgptReadCampaign);
  app.get(`${base}/campaigns/:campaignId/report`,routes.chatgptReport);
  app.post(`${base}/campaigns/:campaignId/ad-groups/:groupId/edit`,routes.chatgptEditGroup);
  app.get(`${base}/safety`,routes.chatgptSafety);
  app.get(`${base}/campaigns/:campaignId/entities`,routes.chatgptEntities);
  app.post(`${base}/campaigns`,routes.chatgptCreateCampaign);
  app.post(`${base}/campaigns/:campaignId`,routes.chatgptUpdateCampaign);
  app.post(`${base}/campaigns/:campaignId/ad-groups`,routes.chatgptCreateGroup);
  app.post(`${base}/campaigns/:campaignId/ad-groups/:groupId`,routes.chatgptUpdateGroup);
  app.post(`${base}/campaigns/:campaignId/creatives`,routes.chatgptSaveCreative);
  app.post(`${base}/campaigns/:campaignId/creatives/:adId`,routes.chatgptSaveCreative);
  app.post(`${base}/campaigns/:campaignId/ads/:adId`,routes.chatgptUpdateAd);
  app.get('/sandbox/state',async (_req,res)=>res.json({locked:state.locked||state.downgraded,metricsFail:state.metricsFail,actions:(await state.db.query('select id,channel_slug,title,body,status,exec_class is not null as executable,exec_status,action_type,card_kind,primary_label,done_label,how_to from channel_actions')).rows,wallet:await readWallet(tenant),payload:{source:'chatgpt_ads_api',currency:'USD',campaign_name_prefix:'zv-upcar-local--',campaigns:state.campaigns,no_campaigns_for_tenant:!state.campaigns.length,totals_across_your_campaigns_only:{},setup_notice:'Local simulation: no real ads or payments. Enter your own test budget; campaigns start paused.'}}));
  app.post('/sandbox/scenario',async(req,res)=> {
    try {
      const action=req.body.action;
      if(action==='lock')state.locked=!state.locked;
      else if(action==='downgrade')state.downgraded=!state.downgraded;
      else if(action==='metrics')state.metricsFail=!state.metricsFail;
      else if(action==='enable-refill')await state.db.query('update ads_wallets set auto_refill_enabled=true where tenant_id=$1',[tenant]);
      else if(action==='claim') { const r=await state.db.query('select ads_wallet_claim_refill($1) as id',[tenant]); return res.json({message:r.rows[0].id?'Local refill claim created/reused (no charge).':'No refill claim allowed.'}); }
      else if(action==='spend') {
        const campaign=state.campaigns[0];if(!campaign)throw new Error('Create a local campaign first.');
        await state.db.query('select ads_wallet_reserve($1,$2,8000,0)',[tenant,campaign.id]);
        await state.db.query('select ads_wallet_settle_spend($1,$2,8000)',[tenant,campaign.id]);
      } else {
        let type, pi;
        if(action==='topup') {
          const order=crypto.randomUUID(),id=`pi_${crypto.randomUUID()}`;
          await state.db.query("insert into ads_wallet_orders(id,tenant_id,kind,amount_cents) values ($1,$2,'topup',10000)",[order,tenant]);
          pi={id,customer:'cus_local',status:'succeeded',currency:'usd',amount:10000,amount_received:10000,metadata:{kind:'chatgpt_ads_wallet',order_id:order},latest_charge:{id:`ch_${id}`,amount_refunded:0,disputed:false}};
          state.intents.set(id,pi);state.lastIntent=id;type='payment_intent.succeeded';
        } else {
          pi=state.intents.get(state.lastIntent);if(!pi)throw new Error('Simulate a top-up first.');
          if(action==='dispute') {pi.latest_charge.disputed=true;state.disputes.set(pi.latest_charge.id,[{id:'dp_local',amount:1000,currency:'usd',status:'needs_response'}]);type='charge.dispute.created';}
          else if(action==='refund'||action==='failed-refund') {pi.latest_charge.amount_refunded=10000;state.refunds.set(pi.latest_charge.id,[{id:'re_local',amount:10000,currency:'usd',status:action==='refund'?'succeeded':'failed'}]);type=action==='refund'?'charge.refunded':'refund.failed';}
          else throw new Error('Unknown scenario');
        }
        const payload=JSON.stringify({id:`evt_${++state.event}`,object:'event',type,created:state.event,livemode:false,data:{object:type==='payment_intent.succeeded'?{id:pi.id}:{payment_intent:pi.id}}});
        const signature=adsWebhookStripe().webhooks.generateTestHeaderString({payload,secret:process.env.STRIPE_ADS_WEBHOOK_SECRET});
        const result=await fetch('http://127.0.0.1:4318/api/webhooks/stripe/ads',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':signature},body:payload});
        if(!result.ok)throw new Error('Local signed webhook failed');
      }
      res.json({message:'Local scenario applied. No real money or ads changed.'});
    } catch(error) {res.status(400).json({error:{message:error.message}});}
  });
  app.use(express.static(process.env.ADS_LOCAL_BUILD));
  app.listen(4318,'127.0.0.1',()=>console.log('ChatGPT Ads isolated sandbox: http://127.0.0.1:4318 — real wallet SQL; simulated Stripe, identity and ad network. Restart resets all local data.'));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
