update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'text/csv',
  'text/html',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/webp'
]
where id = 'agent-artifacts';
