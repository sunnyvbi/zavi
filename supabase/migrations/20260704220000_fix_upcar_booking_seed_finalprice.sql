
begin;

update booking_metric_config
set revenue_field = 'price.finalPrice',
    refund_field  = 'price.refundAmount'
where tenant_id = '73db45ff-457e-4541-bc8f-bdb625390204'::uuid
  and revenue_field = 'totalAmount'
  and refund_field  = 'refundAmount';

commit;
