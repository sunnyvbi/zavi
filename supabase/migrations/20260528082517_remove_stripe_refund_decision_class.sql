
delete from decision_classes
where dispatch_handler = 'stripe.refund'
   or slug = 'stripe.refund';
