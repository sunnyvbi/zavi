
update decision_classes
set default_autonomy = 'auto'::decision_autonomy
where slug = 'engineer.ship-pr'
  and default_autonomy is distinct from 'auto'::decision_autonomy;
