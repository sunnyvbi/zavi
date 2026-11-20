
import { describe, it, expect } from "vitest";
import { heuristicHints } from "../hints";
import type { OperatorDbCatalog } from "../../types";

function catalogWith(columns: Array<[string, string]>): OperatorDbCatalog {
  return {
    tables: [
      {
        name: "trips",
        columns: columns.map(([name, type]) => ({ name, type, nullable: false })),
        rowEstimate: null,
      },
      {
        name: "users",
        columns: [
          { name: "_id", type: "ObjectId", nullable: false },
          { name: "createdAt", type: "Date", nullable: false },
        ],
        rowEstimate: null,
      },
    ],
  };
}

describe("created-at type gate", () => {
  it("picks the Date column over a same-table Array column (the incident)", () => {
    const hints = heuristicHints(
      catalogWith([
        ["additionalPhotoTimestamps", "Array"],
        ["uploadedAdditionalPhotoTimestamps", "Array"],
        ["createdAt", "Date"],
        ["updatedAt", "Date"],
      ]),
    );
    expect(hints.bookings?.created_at_field).toBe("createdAt");
  });

  it("ABSTAINS rather than picking an array of dates", () => {
    const hints = heuristicHints(
      catalogWith([
        ["_id", "ObjectId"],
        ["photoTimestamps", "Array"],
        ["status", "String"],
      ]),
    );
    expect(hints.bookings?.created_at_field).toBeFalsy();
  });

  it("rejects a date-NAMED column that is concretely typed as a string/number", () => {
    const hints = heuristicHints(
      catalogWith([
        ["created_at", "String"],
        ["createdAt", "Date"],
      ]),
    );
    expect(hints.bookings?.created_at_field).toBe("createdAt");
  });

  it("accepts SQL timestamp type names", () => {
    for (const t of ["timestamp with time zone", "timestamptz", "datetime", "date"]) {
      const hints = heuristicHints(catalogWith([["created_at", t]]));
      expect(hints.bookings?.created_at_field).toBe("created_at");
    }
  });

  it("falls back to name-only when the dialect reports no usable type", () => {
    const hints = heuristicHints(catalogWith([["created_at", ""]]));
    expect(hints.bookings?.created_at_field).toBe("created_at");
  });
});
