
import { describe, it, expect } from "vitest";
import { redactValue, columnTokens } from "../redact";

const isRedacted = (col: string) => redactValue(col, "some-value") === "‹redacted›";

describe("column-name denylist — token boundaries", () => {
  it("still redacts real PII columns", () => {
    for (const col of [
      "email",
      "user_email",
      "phone",
      "mobile",
      "firstName",
      "lastName",
      "fullName",
      "address",
      "billing_address",
      "street",
      "ssn",
      "dob",
      "dlDob",
      "password",
      "passwd",
      "apiKey",
      "privateKey",
      "stripeToken",
      "secret",
      "cardNumber",
      "creditCard",
      "cvv",
      "iban",
      "bankAccount",
      "routingNumber",
      "taxId",
      "latitude",
      "longitude",
      "zipCode",
      "postalCode",
    ]) {
      expect(isRedacted(col), `${col} must be redacted`).toBe(true);
    }
  });

  it("redacts the short tokens when they stand alone", () => {
    for (const col of ["lat", "lng", "geo", "card", "bank", "fax", "zip", "cvc"]) {
      expect(isRedacted(col), `${col} must be redacted as a whole token`).toBe(true);
    }
    for (const col of ["geo_point", "lat_deg", "cardExpiry", "bank_name", "faxNumber"]) {
      expect(isRedacted(col), `${col} must be redacted`).toBe(true);
    }
  });

  it("does NOT redact ordinary business columns that merely contain those letters", () => {
    for (const col of [
      "calculatedPrice",
      "platform",
      "licensePlate",
      "licensePlateState",
      "escalationReason",
      "escalationStatus",
      "templateData",
      "payLater",
      "lateExtension",
      "lateExtensionFeeAmount",
      "latestAuctionEventId",
      "cancelAtPeriodEnd",
      "renewalAttemptCount",
      "freeCancellationBefore",
      "readyForSellAt",
      "carDailyMileage",
      "carDetails",
      "translation",
      "relatedId",
    ]) {
      expect(isRedacted(col), `${col} must NOT be redacted`).toBe(false);
    }
  });

  it("tokenizes camelCase, snake_case, kebab and digits", () => {
    expect(columnTokens("giftCardBalance")).toEqual(["gift", "card", "balance"]);
    expect(columnTokens("carDailyMileage")).toEqual(["car", "daily", "mileage"]);
    expect(columnTokens("user_email_2")).toEqual(["user", "email"]);
    expect(columnTokens("geo-point")).toEqual(["geo", "point"]);
  });

  it("redacts by value pattern even when the column name is innocuous", () => {
    expect(redactValue("notes", "reach me at a@b.com")).toBe("reach me at ‹redacted:email›");
    expect(redactValue("freeform", "123-45-6789")).toBe("‹redacted:ssn›");
  });
});
