// @ts-nocheck
import Stripe from 'stripe';
export const tenant = '00000000-0000-4000-8000-000000000001';
export const state = { db: null, locked: false, downgraded: false, metricsFail: false, campaigns: [], groups: [], ads: [], intents: new Map(), refunds: new Map(), disputes: new Map(), event: 100, lastIntent: null };
const ident = value => { if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Unsupported SQL identifier'); return `"${value}"`; };
const tables = new Set(['tenants', 'ads_wallets', 'ads_wallet_orders', 'ads_campaign_funding', 'ads_campaign_reservations', 'ads_account_binding_details', 'ads_campaign_binding_details', 'ads_creative_uploads', 'ads_resource_bindings', 'channel_actions', 'tenant_users']);
export function serviceClient() {
  return {
    from(table) {
      if (!tables.has(table)) throw new Error('Local sandbox table not supported');
      let columns = '*', mutation, value, ignore = false, orderBy, page;
      const filters = [];
      const q = {
        select(v = '*') { columns = v; return q; },
        order(column) { orderBy = ident(column); return q; },
        range(start, end) { if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) throw new Error('Invalid local page'); page = [start, end]; return q; },
        eq(k,v) { filters.push([k,v]); return q; },
        is(k,v) { if (v !== null) throw new Error('Unsupported local filter'); filters.push([k,null]); return q; },
        insert(v) { mutation = 'insert'; value = Array.isArray(v) ? v[0] : v; return q; },
        upsert(v, options) { mutation = 'insert'; value = Array.isArray(v) ? v[0] : v; ignore = options?.ignoreDuplicates; return q; },
        update(v) { mutation = 'update'; value = v; return q; },
        async single() { const result = await run(); return { ...result, data: result.data?.[0] ?? null }; },
        async maybeSingle() { return q.single(); },
        then(ok, fail) { return run().then(ok,fail); },
      };
      async function run() {
        try {
          const args = [], arg = v => { args.push(v); return `$${args.length}`; };
          let sql;
          if (mutation === 'insert') sql = `insert into ${ident(table)} (${Object.keys(value).map(ident)}) values (${Object.values(value).map(arg)})${ignore ? ' on conflict do nothing' : ''} returning *`;
          else {
            sql = mutation === 'update' ? `update ${ident(table)} set ${Object.entries(value).map(([k,v]) => `${ident(k)}=${arg(v)}`).join(',')}` : `select ${columns === '*' ? '*' : columns.split(',').map(v => ident(v.trim())).join(',')} from ${ident(table)}`;
            if (filters.length) sql += ' where ' + filters.map(([k,v]) => v === null ? `${ident(k)} is null` : `${ident(k)}=${arg(v)}`).join(' and ');
            if (mutation) sql += ' returning *';
            else { if (orderBy) sql += ` order by ${orderBy}`; if (page) sql += ` limit ${arg(page[1]-page[0]+1)} offset ${arg(page[0])}`; }
          }
          return { data: (await state.db.query(sql,args)).rows, error: null };
        } catch (error) { console.error('Local SQL adapter:', error.message); return { data: null, error }; }
      }
      return q;
    },
    async rpc(name,args) {
      if (!['prepare_channel_campaign_action','ads_wallet_apply_payment','ads_wallet_claim_refill','ads_wallet_reserve','ads_wallet_reserve_daily','ads_wallet_settle_spend','ads_legacy_account_binding','ads_verify_account_binding','ads_bind_campaign','ads_claim_campaign_account','ads_select_account_binding','ads_wallet_reserve_bound','ads_wallet_reserve_chatgpt_daily_bound','ads_wallet_settle_bound','ads_wallet_finalize_bound'].includes(name)) throw new Error('Unsupported local RPC');
      try { const r = await state.db.query(`select ${ident(name)}(${Object.keys(args).map((k,i) => `${ident(k)} => $${i+1}`).join(',')}) as value`,Object.values(args)); return { data:r.rows[0].value,error:null }; }
      catch(error) { return {data:null,error}; }
    },
  };
}
export const requireAuth = async () => ({ tenant_id: tenant, user_id: tenant });
export const requireTenantRole = async () => true;
export const checkAgentTier = async () => ({ allowed: !state.downgraded, enforced: true });
export const isChannelLocked = async () => state.locked;
export const isChannelLockedStrict = async () => state.locked;
export const logEvent = async () => {};
export const getChatgptAdsApiKey = async () => 'isolated-simulation';
export const stableCreativeUpload = async () => ({ file_id: 'local-image' });
const sdk = new Stripe('sk_test_local_simulation');
export const adsWebhookStripe = () => sdk;
export const adsStripeMode = () => 'test';
export const requireAdsStripe = () => ({
  paymentIntents: { retrieve: async id => { const v = state.intents.get(id); if (!v) throw new Error('Missing local payment'); return v; } },
  refunds: { list: async ({charge}) => ({ data: state.refunds.get(charge) ?? [], has_more: false }) },
  disputes: { list: async ({charge}) => ({ data: state.disputes.get(charge) ?? [], has_more: false }) },
});
export const adsStripe = requireAdsStripe;
export async function chatgptAdsGet(_key,path,query = {}) {
  if (path === '/ad_account') return { id:'local', name:'Local Zavi simulation', status:'active',review:{status:'approved'},url:'https://example.com',currency_code:'USD',timezone:'UTC' };
  if (path.includes('/insights')) { if(state.metricsFail) throw new Error('Simulated reporting outage'); return {data:state.campaigns.filter(c => c.id === path.split('/')[2]).map(c => ({campaign_id:c.id,spend:0,impressions:0,clicks:0})),has_more:false}; }
  if(path==='/geo_lookup/search')return {results:[{id:'2000043',canonical_name:'California, United States'}]};
  if(path==='/conversions/event_settings') return {data:[{id:'local_event',name:'Local signup',event_type:'registration_completed',archived:false,source_ids:['local_source']}],has_more:false};
  if(path==='/custom_audiences')return {data:[{id:'local_audience',name:'Local customers',status:'ready'}],has_more:false};
  if(path==='/feeds')return {data:[{id:'local_feed',name:'Local catalog'}],has_more:false};
  if (path === '/campaigns') return {data:state.campaigns,has_more:false};
  if (path.startsWith('/campaigns/')) { const c=state.campaigns.find(c=>c.id===path.split('/')[2]); if(!c)throw new Error('Missing campaign'); return c; }
  if (path === '/ad_groups') return {data:state.groups.filter(g=>g.campaign_id===query.campaign_id),has_more:false};
  if (path === '/ads') return {data:state.ads.filter(a=>a.ad_group_id===query.ad_group_id),has_more:false};
  throw new Error('Unsupported simulated Ads API read');
}
const writes = new Map();
export async function chatgptAdsPost(_key,path,body,key) {
  if(path.endsWith('/preview'))return {preview_url:'https://example.com/local-preview'};
  if(key && writes.has(key)) return writes.get(key);
  const collection = path.startsWith('/campaigns') ? state.campaigns : path.startsWith('/ad_groups') ? state.groups : path.startsWith('/ads') ? state.ads : null;
  if(!collection) throw new Error('Unsupported simulated Ads API write');
  const id=path.split('/')[2]; let row;
  if(id) { row=collection.find(c=>c.id===id); if(!row)throw new Error('Missing simulated resource'); Object.assign(row,body,{updated_at:++state.event}); }
  else { row={...body,id:`local_${crypto.randomUUID().replaceAll('-','')}`,review_status:"in_review",created_at:Math.floor(Date.now()/1000),updated_at:++state.event}; collection.push(row); }
  if(key)writes.set(key,row); return row;
}
