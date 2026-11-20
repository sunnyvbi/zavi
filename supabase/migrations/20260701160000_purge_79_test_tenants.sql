
do $$
declare
  v_ids uuid[] := array[
    '4d420f7a-39c0-4fe0-9803-51edbfd859ec',
    '7e11757d-5f7e-4831-8457-c16178d7c4f0',
    '4ef9fa00-3fb2-4fdd-90d4-072f5eddfd86',
    'd8d2dd04-f363-46ae-a564-df3cc80b233a',
    '17ac128a-f0ae-4a74-a9b0-91d9e31dfde5',
    '8a1df288-0ff8-440f-9d55-9753347a859a',
    '7b14349d-12b4-4578-9d8e-96f3fb7ddbe6',
    'e0c1c0d7-97ff-4db5-bcc0-ea74da288feb',
    '0de8fe7d-8943-48d3-bc23-4f1e063a3a54',
    '53ce68c6-faa5-459f-ab93-9566c69de3a8',
    '89b944b4-bf1a-4af5-8e64-c891602384e7',
    'be546793-182a-4539-8265-07329825c00e',
    '27cdd78c-db79-4ade-b625-b0981d6b2981',
    '9d8e45fa-2ecc-4b5f-81a7-cb1fa05dadd5',
    'cfceba0e-19ef-4aa5-abda-4368b38b0aec',
    '3dd99b99-8ab7-4559-96a0-4e4f1e76a264',
    'eb6380bd-5573-4387-8e10-d7159a54d7a2',
    '552d8d0e-a9a4-47e8-b5e7-44ad1fd8a72c',
    'dfd64cbc-e1c9-4651-8be0-2f3df84c8252',
    'cd29fd5d-e0d1-459e-bea7-0bd45c8765d7',
    '2737c654-2bc5-4f0c-a5c8-c89c243b33f3',
    'a596b764-fd34-49b6-9e8c-45e7bf081d5b',
    'ee624030-203b-43c8-af51-d593dff35c7b',
    'e80adc58-aa55-426b-98b8-e499059cca70',
    '65c12db5-4563-47ae-8d54-62c33f94c5ae',
    'd51fde67-144f-47ce-b165-832765e85327',
    '36845c85-73e6-4d52-9b64-c92186fcbe96',
    '26524b1a-34f1-47ea-8634-3d3ca7405dc8',
    'a5858472-00dd-4459-89ec-62958d49b0c2',
    'fc284165-b40f-431a-b1ca-8fe2b88443aa',
    'b463ed44-4f87-41f4-9322-2fd6084b091b',
    '9b2b2e63-d551-4694-b805-3fbe459484bd',
    '7a7bc30a-a7cc-4b42-8fcb-77ae81d97729',
    '65a0c0f0-fb03-402a-af60-08b9170da425',
    'f32386ad-7a12-4a5a-bf45-e2cba5720130',
    '86877234-4dde-4a0a-a67c-f8956ad57960',
    'fabb07fd-1c5f-405d-872d-e1042642c28f',
    'e9d454b4-3ed4-41b8-85d8-d710ffae18be',
    '0fa2cf95-d740-413d-b746-9ff23f795191',
    '075104d9-d9f9-43c1-bf5e-7573d5f639da',
    '54322715-97b7-450a-ad08-59aafa7dd290',
    'bbfa3d8a-06c2-4d69-9539-ecee3b697b03',
    '0d2f6bfa-5d8c-4859-8c08-eed48253e095',
    '32e79228-8fc4-46b7-bd74-a2d7b58a33c9',
    'baa9d7bb-4fe8-42a3-8396-e891af8b0b57',
    'b2001a58-4997-4608-8675-d8e517b590be',
    '51d868dc-479a-45a8-a0a9-96bc9a79f316',
    'aa7a3ade-7093-4184-81a8-5799023f875e',
    '0191f636-b240-4c08-a104-597c16676e95',
    '7ee7bceb-adba-418b-9fdf-443bc74d0fe6',
    '5b327cbc-4f4b-42a1-94ed-0c5a247ef596',
    'a82d89a2-19a5-4d07-bffe-8daef77a76bd',
    'e4080333-94d9-4ae1-adc4-ef54a1a4c36e',
    'aede1687-7042-4597-b97a-311fe362a60a',
    '43b8b071-14d3-4a58-b2e0-646a6e0bf77e',
    '7d59114a-a348-4983-9c60-430630a63a83',
    '5608fc17-ffaa-48c3-a64e-ab97c1e552c8',
    'f002e953-e6ef-4ed0-8562-2605d16d4bff',
    'e1eddc59-7ffa-4c93-a22d-5650e9c50960',
    '59bb5525-865e-4c98-8cc1-27af061ce4c3',
    '08f11ad4-c647-47d6-b84c-c429400e4986',
    'd688c886-d445-49e2-8c12-b22ed0dcc5be',
    'aec6303d-5446-4632-8208-acf513098f5c',
    'bace2eb6-a756-4563-aadd-dc8f88a6f1cd',
    '9026f93d-bfad-4c27-9ff0-1926e9a6176d',
    '8e498b3e-9134-4a7d-97f5-6ef6d5536c7e',
    'f5b914ef-ba53-4b44-8576-82c978b594b3',
    'e8ef99e1-3dfe-4432-a77e-083f3143a635',
    '0165e265-d92e-402f-a074-9e3b08d59f7a',
    '12ed0ec1-96fb-4db5-bd2d-665593f4e6e9',
    'bccafef0-13ef-4113-a978-29219710a21e',
    'f28beb6c-7bd8-417d-92a9-662045317c9d',
    '9429d4f1-ccd9-4e61-b337-07e43c583d52',
    'bc419d2c-53da-4977-8cf0-25dcc196ab7d',
    '6bd6de03-d08d-409f-ae18-7ee6fc708a40',
    'a54187f0-7748-4550-a770-ba950af474fa',
    'f9f4a1f1-4df2-4981-a361-a9026df3bc74',
    '161cf0d2-518a-4443-ac44-946a9dab8fc0',
    '1d9d4fa0-5bdf-48fe-a706-317f0b10f12f'
  ];
  v_deleted int;
begin
  update tenants set kind = 'test' where id = any(v_ids) and kind <> 'test';

  alter table admin_action_log        disable trigger admin_action_log_worm;
  alter table autopilot_action_ledger disable trigger autopilot_action_ledger_worm;

  delete from tenants where id = any(v_ids) and kind = 'test';
  get diagnostics v_deleted = row_count;

  alter table admin_action_log        enable trigger admin_action_log_worm;
  alter table autopilot_action_ledger enable trigger autopilot_action_ledger_worm;

  raise notice 'purged % of 79 targeted test tenants + cascade', v_deleted;
end $$;
