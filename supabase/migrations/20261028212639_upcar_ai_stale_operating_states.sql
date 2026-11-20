
begin;

update public.tenant_fact
   set value_text = replace(
         value_text,
         '**Not verified on the public web:** operating geography (internal notes say CA/AZ/TX/FL/NV), host counts, GMV, and ARR are not visible on the site and were not confirmed this run.',
         '**Operating geography (confirmed by the founder, 2026-10-17):** Upcar Rental is live in 20 states: AZ, CA, CO, DC, FL, GA, HI, IL, IN, MD, MO, NC, NJ, NV, OH, PA, TN, TX, UT, VA.' || E'\n\n' ||
         '**Not verified on the public web:** host counts, GMV, and ARR are not visible on the site and were not confirmed this run.'),
       updated_at = now()
 where tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'
   and key = 'company_story'
   and value_text like '%internal notes say CA/AZ/TX/FL/NV%';

update public.memory_note
   set body_markdown = replace(
         body_markdown,
         '**Not verified on the public web:** operating geography (internal notes say CA/AZ/TX/FL/NV), host counts, GMV, and ARR are not visible on the site and were not confirmed this run.',
         '**Operating geography (confirmed by the founder, 2026-10-17):** Upcar Rental is live in 20 states: AZ, CA, CO, DC, FL, GA, HI, IL, IN, MD, MO, NC, NJ, NV, OH, PA, TN, TX, UT, VA.' || E'\n\n' ||
         '**Not verified on the public web:** host counts, GMV, and ARR are not visible on the site and were not confirmed this run.'),
       metadata = jsonb_set(metadata, '{rendered_at}', to_jsonb(to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))),
       enrichment_state = 'pending',
       enrichment_attempts = 0,
       updated_at = now()
 where tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'
   and slug = 'company'
   and superseded_by is null
   and source = 'agent_write'
   and metadata ->> 'derived_from' = 'company_record'
   and body_markdown like '%internal notes say CA/AZ/TX/FL/NV%';

delete from public.memory_chunk c
 using public.memory_note n
 where c.note_id = n.id
   and c.tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'
   and n.tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'
   and n.slug = 'company'
   and n.superseded_by is null
   and n.enrichment_state = 'pending';

update public.memory_note
   set archived_at = now(),
       archive_reason = 'stale_operating_states_2026_10_28'
 where tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'
   and slug is null
   and archived_at is null
   and id in (
    '0155c8d4-cc46-4238-aa47-06ccdbbd7686',
    '079eabb9-2cc4-4e7f-b905-fe29d47912b8',
    '1b95709e-517a-4cdc-a018-9d1318f995e8',
    '24d40a45-fcae-4bb7-8f8b-3a924543b829',
    '3da537d8-d368-4532-990a-5ce44759e59f',
    '421196ea-3c34-4c16-83d4-9cfcf4035562',
    '48e9baad-0653-4fd5-9412-03a56376f7c4',
    '55cf334e-0a9b-41b9-bcc1-4a186a207792',
    '58149c69-2d36-4e40-a3d5-a2f2a391ce76',
    '59135348-3916-4bda-8302-2c77e619c95b',
    '5934b200-38d5-4442-affb-386007ba2646',
    '5bcdf9c5-4b6c-4705-9e65-5b90c4115353',
    '61446016-ebd2-4eb9-8922-423a4fd7afae',
    '62bbda50-d18f-4ca2-8876-16a7e0e32f61',
    '69640aaa-5d18-4e05-a352-51b6b87122d7',
    '760c7679-7390-4874-a246-1a57612d69da',
    '780a60bf-58bc-43a4-8aec-3b74e9a16f10',
    '7b3affa8-f473-4bc5-b28a-a0a6aa09fdba',
    '7e5f0e08-af74-4ce5-ad39-0b419833a81b',
    '99e84e16-964e-430a-a6d0-1a38d7489460',
    'a3cf2651-3d0b-4d95-8ca8-52646b30f52b',
    'aebe7c31-929c-4d35-8217-3199ab8cacea',
    'b7d640df-7b58-4653-9574-91653b1ca399',
    'b9b84518-109c-4511-80ab-490b82da30c8',
    'babaf2a9-aeb4-4c25-b427-e0c95039c07b',
    'bef35d30-c059-4b5d-a129-95b4a7e28277',
    'c030e26e-02a9-4846-8d17-654caadf2d4c',
    'cba2ec7a-9509-48ed-ab6c-bb39581ba279',
    'dd1d845d-2457-4a7b-af93-16c7f0006157',
    'e905e9ef-03f7-49a3-8bbc-f12ea890d806',
    'eee260a5-a6cd-44db-9139-8152bbdf2cc8',
    'f0121b65-887c-4033-baef-f6a04943e6ac',
    'f7d06966-0dc5-4305-add5-baff48cc9996',
    'f879bdde-91f2-40b7-8aeb-4ac564c41a31',
    'fafc63bc-efba-4b82-91f2-bbbcc1c77943'
   );

commit;
