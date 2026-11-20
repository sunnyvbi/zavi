const { PGlite } = require('@electric-sql/pglite');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const assert = require('node:assert/strict');
(async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create table tenant_users(tenant_id uuid, user_id uuid, role text);
      create table channel_actions(id uuid primary key, tenant_id uuid, channel_slug text,
        body jsonb, status text default 'pending', exec_class text, exec_status text, exec_payload jsonb,
        action_type text, card_kind text, primary_label text, done_label text, how_to jsonb);
      create table channel_action_events(tenant_id uuid, action_id uuid, event text,
        actor_kind text check(actor_kind in ('founder','channel_run','system')), actor_user_id uuid,
        event_key text, unique(action_id,event_key));
    `);
    await db.exec(readFileSync(resolve(__dirname, '../../../supabase/migrations/20260926090000_channel_campaign_action_review.sql'), 'utf8'));
    const tenant = '10000000-0000-4000-8000-000000000001';
    const other = '10000000-0000-4000-8000-000000000002';
    const action = '10000000-0000-4000-8000-000000000003';
    const owner = '10000000-0000-4000-8000-000000000004';
    const member = '10000000-0000-4000-8000-000000000005';
    const body = { step: { responsibility: 'client', deliverable: { presentation: { type: 'campaign_draft' } } } };
    const payload = { currency: 'USD', campaign: { name: 'Reviewed draft', lifetime_budget_micros: 100000000 } };
    await db.query('insert into tenant_users values($1,$2,$3),($1,$4,$5)', [tenant, owner, 'owner', member, 'member']);
    await db.query('insert into channel_actions(id,tenant_id,channel_slug,body) values($1,$2,$3,$4)', [action, tenant, 'chatgpt_ads', body]);
    const call = async (t = tenant, u = owner, p = payload, b = body) => (await db.query('select prepare_channel_campaign_action($1,$2,$3,$4,$5,$6) as result', [t, action, u, b, p, { rows: [] }])).rows[0].result;
    assert.equal((await call(other)).ok, false, 'cross-tenant access refused');
    assert.equal((await call(tenant, member)).ok, false, 'member cannot prepare');
    assert.equal((await call(tenant, owner, payload, {})).ok, false, 'stale draft refused');
    const replies = await Promise.all([call(), call()]);
    assert.ok(replies.every(r => r.ok));
    assert.equal(replies.filter(r => r.replayed).length, 1, 'double submit replays');
    const row = (await db.query('select * from channel_actions')).rows[0];
    assert.equal(row.exec_class, 'chatgpt_ads.create_campaign_bundle');
    assert.equal(row.exec_status, null, 'preparing is not approval');
    assert.equal(row.card_kind, 'executes');
    assert.equal(row.primary_label, 'Create paused campaign');
    assert.equal((await db.query('select count(*)::int as n from channel_action_events')).rows[0].n, 1);
    assert.equal((await call(tenant, owner, { ...payload, currency: 'EUR' })).ok, false, 'cannot mutate prepared payload');
    await db.query("update channel_actions set exec_status='dispatching'");
    assert.equal((await call()).ok, true, 'lost response can replay without overwriting a dispatch');
    assert.equal((await call(tenant, owner, { ...payload, currency: 'EUR' })).ok, false);
    await db.exec('set role authenticated');
    await assert.rejects(call(), /permission denied/);
    console.log('PASS: review RPC tenant/role isolation, stale drafts, immutable payload, replay, no auto-approval, audit, service-only permissions.');
  } finally { await db.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
