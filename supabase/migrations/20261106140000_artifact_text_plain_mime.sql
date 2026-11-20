update storage.buckets
set allowed_mime_types = array[
  'application/pdf',
  'text/csv',
  'text/html',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.zavi.ui+json'
]
where id = 'agent-artifacts';
