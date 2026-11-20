import { describe, it, expect } from "vitest";
import { isSensitiveField, sensitiveKind } from "@zavi/shared/db-guard";

const SENSITIVE = [
  "users.email", "users.phone", "users.mobileNumber", "users.first_name", "users.fullName", "users.name",
  "customers.name", "users_for_zavi.name", "users.driverLicense", "users.licence_no", "payments.cardLast4",
  "users.ssn", "users.dob", "users.date_of_birth", "sessions.token", "users.password_hash",
  "invoices.billing_address", "users.street", "users.postal_code", "users.iban", "users.profile.email",
  "cars.owner_name", "bookings.guestName", "payments.cardholder_name", "users.emergency_contact_name",
  "bookings.renterName", "orders.shipping_name", "users.tel", "users.telephone", "users.cell", "users.msisdn",
  "users.passport_no", "users.national_id", "users.nationalId", "users.nid", "users.govt_id", "users.gov_id",
  "users.drivers_license", "users.dl_number", "users.dlNumber", "users.zip", "users.zipcode", "users.postcode",
  "sessions.ip", "sessions.ip_address", "sessions.geo_ip", "devices.device_id", "devices.fingerprint",
  "payouts.bank_account",
];
const NOT_SENSITIVE = [
  "listings.name", "plans.name", "bookings.city", "listings.latitude", "listings.lng", "bookings.createdAt",
  "cars.carDailyMileage", "cars.licensePlateState", "gift.giftCardBalance", "bookings.status", "users.role",
  "events.platform", "products.productName", "listings.state", "listings.country", "listings.lat",
  "users.cardType", "users.cardBrand", "branches.bankCount", "cells.cellCount", "servers.hostname",
  "events.handle_number", "trips.tripCount",
];
const split = (r: string) => {
  const i = r.indexOf(".");
  return [r.slice(0, i), r.slice(i + 1)] as const;
};

describe("isSensitiveField", () => {
  it.each(SENSITIVE)("%s is sensitive", (r) => expect(isSensitiveField(...split(r))).toBe(true));
  it.each(NOT_SENSITIVE)("%s is not sensitive", (r) => expect(isSensitiveField(...split(r))).toBe(false));
});

describe("sensitiveKind", () => {
  it.each([
    ["email", "Email address"], ["mobileNumber", "Phone number"], ["cardLast4", "Card digits"],
    ["first_name", "Person's name"], ["street", "Street address"], ["driverLicense", "Licence"],
    ["date_of_birth", "Date of birth"], ["ssn", "ID number"], ["password_hash", "Secret"], ["telephone", "Phone number"],
    ["passport_no", "ID number"], ["zipcode", "Street address"], ["ip_address", "Street address"], ["device_id", "Device or network ID"],
    ["cardholder_name", "Person's name"],
  ])("%s -> %s", (f, k) => expect(sensitiveKind(f)).toBe(k));
});
