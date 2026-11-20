
import { serviceClient } from "@/services/supabase";

export type BookingEngine = "mongodb" | "postgres" | "mysql";
export type RefundBasis = "none" | "booking_created_net" | "refund_event_day";
export type BookingConfigState = "proposed" | "confirmed";
export type AmountUnit = "dollars" | "cents";

export type BookingMetricConfig = {
  tenant_id: string;
  engine: BookingEngine;
  booking_source: string;
  date_field: string;
  status_field: string | null;
  completed_statuses: string[];
  revenue_field: string | null;
  refund_field: string | null;
  refund_basis: RefundBasis;
  currency: string | null;
  reporting_timezone: string;
  amount_unit: AmountUnit;
  state: BookingConfigState;
  confirmed_by: string | null;
  confirmed_at: string | null;
};

export async function getBookingMetricConfig(
  tenant_id: string,
): Promise<BookingMetricConfig | null> {
  const { data, error } = await serviceClient()
    .from("booking_metric_config")
    .select(
      "tenant_id, engine, booking_source, date_field, status_field, completed_statuses, revenue_field, refund_field, refund_basis, currency, reporting_timezone, amount_unit, state, confirmed_by, confirmed_at",
    )
    .eq("tenant_id", tenant_id)
    .maybeSingle();
  if (error || !data) return null;
  return data as BookingMetricConfig;
}

export async function getConfirmedBookingConfig(
  tenant_id: string,
): Promise<BookingMetricConfig | null> {
  const cfg = await getBookingMetricConfig(tenant_id);
  return cfg && cfg.state === "confirmed" ? cfg : null;
}
