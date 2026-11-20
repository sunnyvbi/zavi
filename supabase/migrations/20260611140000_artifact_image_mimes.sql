update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/png',
  'image/jpeg',
  'image/webp'
]
where id = 'agent-artifacts';
