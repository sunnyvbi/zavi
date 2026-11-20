"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api";
import { useWorkspaceOptional } from "../WorkspaceShell";
import { isMember } from "@/lib/members";
import { ConfirmMappingForm, type CanonicalMap } from "./ConstraintCard";
import { btn } from "./dashboard-ui";

export type LocationSource = "order" | "listing" | "user" | "none";
export type SupplySource = "listings" | "sellers_on_orders" | "none";
export type SupplyDemandChoices = { location_source: LocationSource; supply_source: SupplySource };

export type SupplyDemandSetupState =
  | { state: "no_db" }
  | { state: "unsupported_db"; db_type: string }
  | { state: "discovering" }
  | { state: "discovery_failed" }
  | {
      state: "needs_confirm";
      catalog_hash: string;
      proposed: CanonicalMap;
      choices?: SupplyDemandChoices;
      roles: Record<string, readonly string[]>;
      options?: {
        location_source: LocationSource[];
        supply_source: SupplySource[];
        roles_by_pair: Record<string, Record<string, string[]>>;
      };
      schema: { tables: Array<{ name: string; columns: string[] }> };
    }
  | { state: "needs_admin" }
  | { state: "waiting_first_run" }
  | { state: "no_recent_bookings"; window_weeks: number }
  | {
      state: "calculation_failed";
      code: "bad_date_field" | "too_much_data" | "too_slow" | "connection" | "refused" | "other";
      form?: Extract<SupplyDemandSetupState, { state: "needs_confirm" }>;
    };

const DB_NAMES: Record<string, string> = {
  dynamodb: "DynamoDB",
};

const LOCATION_ROLE = "supply_demand_location";

const ROLE_LABELS: Record<string, string> = {
  bookings: "Orders",
  listings: "Listings",
  [LOCATION_ROLE]: "Customers",
};
const FIELD_LABELS: Record<string, string> = {
  created_at_field: "Order date",
  geo_field: "Location (city, region or area)",
  listing_ref_field: "Listing ID on the order",
  buyer_ref_field: "Customer ID on the order",
  seller_ref_field: "Seller or provider ID on the order",
  id_field: "ID",
  listed_at_field: "When the listing went up",
};

export function isOptionalField(choices: SupplyDemandChoices, key: string): boolean {
  if (key === "listed_at_field") return true;
  return key === "listing_ref_field" && choices.location_source !== "listing";
}

function fieldLabelsFor(choices: SupplyDemandChoices): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    labels[key] = isOptionalField(choices, key) ? `${label} (optional)` : label;
  }
  return labels;
}

const LOCATION_OPTIONS: Array<{ value: LocationSource; label: string }> = [
  { value: "order", label: "On the order" },
  { value: "listing", label: "On the listing (item, property, stall...)" },
  { value: "user", label: "On the customer's account" },
  { value: "none", label: "We don't store a location" },
];
const SUPPLY_OPTIONS: Array<{ value: SupplySource; label: string }> = [
  { value: "listings", label: "Listings (what buyers can order)" },
  { value: "sellers_on_orders", label: "Sellers or providers taking orders" },
  { value: "none", label: "Skip supply, show demand only" },
];

export function rolesForWith(
  choices: SupplyDemandChoices,
  options?: { roles_by_pair?: Record<string, Record<string, string[]>> },
): Record<string, readonly string[]> {
  const fromServer = options?.roles_by_pair?.[`${choices.location_source}|${choices.supply_source}`];
  return fromServer ?? rolesFor(choices);
}

export function rolesFor(choices: SupplyDemandChoices): Record<string, string[]> {
  const { location_source: location, supply_source: supply } = choices;
  const bookings = ["created_at_field"];
  if (location === "order") bookings.push("geo_field");
  if (location === "listing" || supply === "listings") bookings.push("listing_ref_field");
  if (location === "user") bookings.push("buyer_ref_field");
  if (supply === "sellers_on_orders") bookings.push("seller_ref_field");
  const roles: Record<string, string[]> = { bookings };
  if (location === "listing" || supply === "listings") {
    const listings = ["id_field"];
    if (location !== "none") listings.push("geo_field");
    if (supply === "listings") listings.push("listed_at_field");
    roles.listings = listings;
  }
  if (location === "user") roles[LOCATION_ROLE] = ["id_field", "geo_field"];
  return roles;
}

const FAILURE_COPY: Record<string, { title: string; body: string }> = {
  bad_date_field: {
    title: "We couldn't read your booking dates",
    body: "The field picked as the booking date doesn't hold dates we can read.",
  },
  too_much_data: {
    title: "Too much data to calculate",
    body: "Your database returned more rows than Supply & Demand reads in one go. Pick a broader location field (a city or region rather than a street address).",
  },
  too_slow: {
    title: "Your database took too long to answer",
    body: "Supply & Demand will try again tonight. If this keeps happening, pick a location on the order itself so no lookup is needed.",
  },
  refused: {
    title: "A data-access rule stopped the calculation",
    body: "Supply & Demand tried a read your data-access settings or Zavi's read limits don't allow. Check which tables and fields Zavi may read in Connectors. Supply & Demand will try again tonight.",
  },
  connection: {
    title: "We couldn't reach your database",
    body: "Reconnect your database in Connectors, then Supply & Demand will try again.",
  },
  other: {
    title: "We couldn't calculate your numbers",
    body: "Something went wrong reading your data. Supply & Demand will try again tonight.",
  },
};

const SAVE_ERRORS: Record<string, string> = {
  admin_required: "Only a workspace admin can confirm this setup.",
  database_changed: "Your database structure changed. Reload this page to see the new fields.",
  database_not_ready: "Your database isn't ready yet. Reload this page in a few minutes.",
  mapping_rejected: "Some of these fields aren't in your database. Check them and try again.",
  invalid_answers: "Fill in every field, then try again.",
};

function describeRejectedField(field: string | undefined, reason: string | undefined): string | null {
  if (!field) return null;
  if (field === "location_source" || field === "supply_source") {
    return "That answer isn't one of the options. Pick one of the choices above, then try again.";
  }
  const [role, key] = field.split(".");
  const roleName = ROLE_LABELS[role] ?? role;
  const what = key === "table" || !key ? `${roleName} table` : `${roleName} "${FIELD_LABELS[key] ?? key}"`;
  if (reason === "unknown_table") return `Your database has no ${what} any more. Pick one that exists, then try again.`;
  if (reason === "unknown_column") return `That ${what} isn't in your database any more. Pick another, then try again.`;
  if (reason === "unsafe_name") return `That ${what} has characters we can't read as a name. Pick another, then try again.`;
  return `Pick the ${what}, then try again.`;
}

function firstMissingField(
  clean: CanonicalMap,
  roles: Record<string, readonly string[]>,
  choices: SupplyDemandChoices,
): string | null {
  for (const [role, keys] of Object.entries(roles)) {
    const entry = clean[role] ?? {};
    const roleName = (ROLE_LABELS as Record<string, string>)[role] ?? role;
    if (!entry.table) return `${roleName} table`;
    for (const key of keys) {
      if (isOptionalField(choices, key)) continue;
      if (!entry[key]) {
        const fieldName = (FIELD_LABELS as Record<string, string>)[key] ?? key;
        return `${roleName} "${fieldName}"`;
      }
    }
  }
  return null;
}

export function SetupNotice({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-inkMuted/30 bg-cream px-6 py-8 text-center">
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      {children ? (
        <p className="mx-auto mt-1 max-w-md text-[16px] leading-5 text-inkMuted">{children}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

function ConnectDatabaseButton({ label }: { label: string }) {
  const ws = useWorkspaceOptional();
  if (!ws) return null;
  return (
    <button
      type="button"
      onClick={() =>
        ws.openTab({
          kind: "brain",
          title: "Connectors",
          payload: { kind: "brain" },
          dirty: false,
          pinned: false,
        })
      }
      className={btn.primary}
    >
      {label}
    </button>
  );
}

export function SupplyDemandSetup({
  setup,
  onChanged,
  onPoll,
}: {
  setup: SupplyDemandSetupState;
  onChanged: () => void;
  onPoll?: () => void;
}) {
  const role = useWorkspaceOptional()?.role ?? null;

  const waiting = setup.state === "discovering" || setup.state === "waiting_first_run";
  useEffect(() => {
    if (!waiting || !onPoll) return;
    const id = window.setInterval(onPoll, 20_000);
    return () => window.clearInterval(id);
  }, [waiting, onPoll]);

  const formSetup =
    setup.state === "needs_confirm"
      ? setup
      : setup.state === "calculation_failed"
        ? setup.form
        : undefined;

  const [choices, setChoices] = useState<SupplyDemandChoices>(
    () => formSetup?.choices ?? { location_source: "order", supply_source: "listings" },
  );
  const serverLocation = formSetup?.choices?.location_source;
  const serverSupply = formSetup?.choices?.supply_source;
  useEffect(() => {
    if (serverLocation && serverSupply) {
      setChoices({ location_source: serverLocation, supply_source: serverSupply });
    }
  }, [serverLocation, serverSupply, formSetup?.catalog_hash]);
  const roles = rolesForWith(choices, formSetup?.options);

  const save = useCallback(
    async (clean: CanonicalMap): Promise<string | null> => {
      if (!formSetup) return SAVE_ERRORS.database_not_ready;
      const asked = rolesForWith(choices, formSetup?.options);
      const missing = firstMissingField(clean, asked, choices);
      if (missing) return `Pick the ${missing} field, then try again.`;
      const answers: Record<string, unknown> = { ...choices };
      for (const role of Object.keys(asked)) answers[role] = clean[role] ?? {};
      try {
        const res = await apiFetch("/api/agents/marketplace-intelligence/confirm-setup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ catalog_hash: formSetup.catalog_hash, answers }),
        });
        if (res.ok) return null;
        const body = (await res.json().catch(() => null)) as
          | { error?: string; field?: string; reason?: string }
          | null;
        const named = describeRejectedField(body?.field, body?.reason);
        if (named) return named;
        return SAVE_ERRORS[body?.error ?? ""] ?? "Couldn't save. Try again.";
      } catch {
        return "Couldn't save. Try again.";
      }
    },
    [formSetup, choices],
  );

  const shapeForm = (form: Extract<SupplyDemandSetupState, { state: "needs_confirm" }>, intro: string) => (
    <div className="flex flex-col gap-3">
      <ShapeQuestions choices={choices} onChange={setChoices} accepted={form.options} />
      <ConfirmMappingForm
        key={form.catalog_hash}
        data={{
          status: "requires_mapping_confirmation",
          catalog_hash: form.catalog_hash,
          proposed_map: form.proposed,
          probes: [],
          schema: form.schema,
          tenant_id: "",
        }}
        roles={roles}
        onSave={save}
        onConfirmed={onChanged}
        roleLabels={ROLE_LABELS}
        fieldLabels={fieldLabelsFor(choices)}
        intro={intro}
        submitLabel="Confirm and calculate"
      />
    </div>
  );

  switch (setup.state) {
    case "no_db":
      return (
        <SetupNotice
          title="Connect your database to see supply and demand by location"
          action={<ConnectDatabaseButton label="Connect database" />}
        >
          Zavi reads your bookings and listings to show where demand is outpacing
          supply, week by week.
        </SetupNotice>
      );
    case "unsupported_db":
      return (
        <SetupNotice title="Supply & Demand works with Postgres, MySQL and MongoDB databases today">
          Your connected database is {DB_NAMES[setup.db_type] ?? setup.db_type}, which
          isn&apos;t supported yet.
        </SetupNotice>
      );
    case "discovering":
      return (
        <SetupNotice title="Reading your database structure…">
          This takes a few minutes after you connect. This page updates on its own.
        </SetupNotice>
      );
    case "discovery_failed":
      return (
        <SetupNotice
          title="We couldn't read your database structure"
          action={<ConnectDatabaseButton label="Reconnect database" />}
        >
          Reconnect your database in Connectors and we&apos;ll try again.
        </SetupNotice>
      );
    case "calculation_failed": {
      const copy = FAILURE_COPY[setup.code] ?? FAILURE_COPY.other;
      return (
        <div className="flex flex-col gap-3">
          <SetupNotice
            title={copy.title}
            action={setup.code === "connection" ? <ConnectDatabaseButton label="Reconnect database" /> : undefined}
          >
            {copy.body}
          </SetupNotice>
          {setup.form
            ? shapeForm(setup.form, "Check your answers and fields, then confirm again.")
            : null}
        </div>
      );
    }
    case "no_recent_bookings":
      return (
        <SetupNotice title={`No bookings in the last ${setup.window_weeks} weeks`}>
          Supply & Demand updates every night. If you do have recent bookings, the
          booking date field may be in a format we can&apos;t read yet.
        </SetupNotice>
      );
    case "waiting_first_run":
      return (
        <SetupNotice title="Calculating your first numbers">
          This usually takes a few minutes. This page updates on its own.
        </SetupNotice>
      );
    case "needs_admin":
      return (
        <SetupNotice title="Ask a workspace admin to finish setup">
          An admin needs to confirm where your bookings and listings live before
          Supply & Demand can show numbers.
        </SetupNotice>
      );
    case "needs_confirm": {
      if (role === null || isMember(role)) {
        return (
          <SetupNotice title="Ask a workspace admin to finish setup">
            An admin needs to confirm where your bookings and listings live before
            Supply & Demand can show numbers.
          </SetupNotice>
        );
      }
      return shapeForm(
        setup,
        "Tell us where each order's location lives and what counts as supply, then check the fields. We guessed from your database structure, so fix anything that's wrong.",
      );
    }
  }
}

function ShapeQuestions({
  choices,
  onChange,
  accepted,
}: {
  choices: SupplyDemandChoices;
  onChange: (next: SupplyDemandChoices) => void;
  accepted?: { location_source: LocationSource[]; supply_source: SupplySource[] };
}) {
  return (
    <div className="grid grid-cols-1 gap-4 rounded-2xl border border-rule bg-cream px-4 py-4 sm:grid-cols-2">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-[14px] font-semibold text-ink">Where does an order's location live?</legend>
        {LOCATION_OPTIONS.filter((o) => !accepted?.location_source || accepted.location_source.includes(o.value)).map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2.5 text-[16px] leading-5 text-inkMuted hover:text-ink">
            <input
              type="radio"
              className="h-4 w-4 shrink-0 cursor-pointer accent-ink"
              name="sd-location"
              value={o.value}
              checked={choices.location_source === o.value}
              onChange={() => onChange({ ...choices, location_source: o.value })}
            />
            {o.label}
          </label>
        ))}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-[14px] font-semibold text-ink">What counts as supply?</legend>
        {SUPPLY_OPTIONS.filter((o) => !accepted?.supply_source || accepted.supply_source.includes(o.value)).map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2.5 text-[16px] leading-5 text-inkMuted hover:text-ink">
            <input
              type="radio"
              className="h-4 w-4 shrink-0 cursor-pointer accent-ink"
              name="sd-supply"
              value={o.value}
              checked={choices.supply_source === o.value}
              onChange={() => onChange({ ...choices, supply_source: o.value })}
            />
            {o.label}
          </label>
        ))}
      </fieldset>
    </div>
  );
}
