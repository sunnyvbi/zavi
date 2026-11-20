
update decision_classes
  set dispatch_handler = 'digest.post'
  where slug in (
    'qa-engineer.file-bug',
    'payouts-recon.notify',
    'listing-quality.action',
    'trust-safety.action',
    'chief-of-staff.daily-digest'
  );
