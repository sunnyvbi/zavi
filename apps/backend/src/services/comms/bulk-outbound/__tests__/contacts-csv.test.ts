import { describe, expect, it } from "vitest";
import { addressIn, cleanAddresses, csvColumnValues, previewCsv } from "../contacts-csv";
import { BulkEmailError } from "../errors";

const csv = (text: string) => Buffer.from(text, "utf8");
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as BulkEmailError).code;
  }
  return "no_error";
};

describe("previewCsv", () => {
  it("picks the column by itself only for a single header named exactly `email`", () => {
    const p = previewCsv(csv("Name,Email\nAda,ada@example.com\nBo,bo@example.com\n"));
    expect(p.auto_column).toBe("Email");
    expect(p.row_count).toBe(2);
    expect(p.columns.map((c) => c.header)).toEqual(["Name", "Email"]);
    expect(p.columns[1].samples).toEqual(["ada@example.com", "bo@example.com"]);
  });

  it("does not pick a look-alike header: the founder chooses from the samples", () => {
    expect(previewCsv(csv("name,email_address\nAda,ada@example.com\n")).auto_column).toBeNull();
    expect(previewCsv(csv("name,work email\nAda,ada@example.com\n")).auto_column).toBeNull();
  });

  it("two columns that hold addresses: must choose, even when one is named email", () => {
    const p = previewCsv(csv("email,billing\nada@example.com,pay@example.com\n"));
    expect(p.auto_column).toBeNull();
    expect(p.columns.filter((c) => c.has_addresses)).toHaveLength(2);
  });

  it("two headers named email: must choose", () => {
    expect(previewCsv(csv("email,Email\nada@example.com,\n")).auto_column).toBeNull();
  });

  it("strips a byte-order mark before reading the header", () => {
    expect(previewCsv(csv("﻿email\nada@example.com\n")).auto_column).toBe("email");
  });

  it("shows at most 5 samples per column", () => {
    const rows = Array.from({ length: 9 }, (_, i) => `p${i}@example.com`).join("\n");
    expect(previewCsv(csv(`email\n${rows}\n`)).columns[0].samples).toHaveLength(5);
  });

  it("refuses a file with no address column, an unreadable file and a file over 2 MB", () => {
    expect(code(() => previewCsv(csv("name,city\nAda,Paris\n")))).toBe("csv_no_address_column");
    expect(code(() => previewCsv(csv('email\n"unbalanced\n')))).toBe("csv_unreadable");
    expect(code(() => previewCsv(Buffer.alloc(2 * 1024 * 1024 + 1, "a")))).toBe("csv_too_large");
  });
});

describe("csvColumnValues", () => {
  it("returns the chosen column, matched without regard to case", () => {
    expect(csvColumnValues(csv("Name,Work Email\nAda,ada@example.com\n"), "work email")).toEqual(["ada@example.com"]);
  });

  it("refuses a column that is not in the file, or is there twice", () => {
    expect(code(() => csvColumnValues(csv("name\nAda\n"), "email"))).toBe("csv_column_not_found");
    expect(code(() => csvColumnValues(csv("email,email\na@b.co,c@d.co\n"), "email"))).toBe("csv_column_not_found");
  });
});

describe("cleanAddresses", () => {
  it.each(["ada\u001a@example.com", "ada@exa\u007fmple.com", "ada\u0001@example.com", "ada@ex ample.com"])(
    "counts %j as invalid and keeps the rest of the import",
    (bad) => {
      const out = cleanAddresses(["bo@example.com", bad, "cy@example.com"], 10);
      expect(out.emails).toEqual(["bo@example.com", "cy@example.com"]);
      expect(out.invalid).toBe(1);
      expect(addressIn(bad)).toBeNull();
    },
  );

  it("lowercases, trims, drops what is not an address and counts mixed-case repeats once", () => {
    const out = cleanAddresses([" Ada@Example.com ", "ada@example.com", "ADA@EXAMPLE.COM", "not an email", "", "bo@example.com"], 10);
    expect(out.emails).toEqual(["ada@example.com", "bo@example.com"]);
    expect(out.duplicates).toBe(2);
    expect(out.invalid).toBe(1);
    expect(out.over_limit).toBe(0);
  });

  it("stops at the cap and says how many were left out", () => {
    const values = Array.from({ length: 10_050 }, (_, i) => `p${i}@example.com`);
    const out = cleanAddresses(values, 10_000);
    expect(out.emails).toHaveLength(10_000);
    expect(out.over_limit).toBe(50);
  });

  it("ignores values that are not text", () => {
    expect(cleanAddresses([null, 7, { a: 1 }, "ada@example.com"], 10).emails).toEqual(["ada@example.com"]);
  });
});

describe("files founders actually export", () => {
  const BOM = "\uFEFF";

  it("reads a semicolon file from Excel in a European locale and keeps names out of the addresses", () => {
    const file = csv(`${BOM}Name;Email\r\nAda Lovelace;ada@example.com\r\nBo;bo@example.com\r\n`);
    const p = previewCsv(file);
    expect(p.columns.map((c) => c.header)).toEqual(["Name", "Email"]);
    expect(p.auto_column).toBe("Email");
    expect(cleanAddresses(csvColumnValues(file, "Email"), 10).emails).toEqual(["ada@example.com", "bo@example.com"]);
  });

  it("never stores a whole semicolon row as one address", () => {
    const file = csv("Ada;ada@example.com\nBo;bo@example.com\n");
    const p = previewCsv(file);
    expect(p.columns).toHaveLength(2);
    expect(cleanAddresses(csvColumnValues(file, "ada@example.com"), 10).emails).toEqual(["bo@example.com"]);
    expect(addressIn("ada;ada@example.com")).toBeNull();
  });

  it("reads a tab-separated file", () => {
    expect(previewCsv(csv("name\temail\nAda\tada@example.com\n")).auto_column).toBe("email");
  });

  it("honours Excel's sep= first line and uses the header under it", () => {
    const file = csv('sep=;\r\nName;Email\r\n"Lovelace, Ada";ada@example.com\r\n');
    const p = previewCsv(file);
    expect(p.columns.map((c) => c.header)).toEqual(["Name", "Email"]);
    expect(p.auto_column).toBe("Email");
    expect(p.row_count).toBe(1);
  });

  it("skips blank lines before the header", () => {
    expect(previewCsv(csv("\r\n\r\nName,Email\r\nAda,ada@example.com\r\n")).auto_column).toBe("Email");
  });

  it("names a column with an empty header so it can be chosen and imported", () => {
    const file = csv("Name,\nAda,ada@example.com\n");
    const p = previewCsv(file);
    expect(p.columns.map((c) => c.header)).toEqual(["Name", "Column 2"]);
    expect(p.columns[1].has_addresses).toBe(true);
    expect(csvColumnValues(file, p.columns[1].header)).toEqual(["ada@example.com"]);
  });

  it("drops the space before a quoted field instead of keeping the quotes", () => {
    const file = csv('Name, "Email"\nAda, "ada@example.com"\n');
    const p = previewCsv(file);
    expect(p.columns.map((c) => c.header)).toEqual(["Name", "Email"]);
    expect(cleanAddresses(csvColumnValues(file, "Email"), 10).emails).toEqual(["ada@example.com"]);
  });

  it("takes the address out of an Outlook or Gmail contact and a mailto link", () => {
    const file = csv('Contact\n"Ada Lovelace <Ada@Example.com>"\nmailto:bo@example.com\n<cy@example.com>\n');
    expect(previewCsv(file).columns[0].has_addresses).toBe(true);
    expect(cleanAddresses(csvColumnValues(file, "Contact"), 10).emails).toEqual(["ada@example.com", "bo@example.com", "cy@example.com"]);
  });

  it("keeps an apostrophe, which is legal in an address", () => {
    expect(addressIn("o'brien@example.com")).toBe("o'brien@example.com");
  });
});
