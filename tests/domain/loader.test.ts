import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
  isValidAirportCode,
  loadDatasetFromBuffer,
  loadDatasetFromFile,
  normalizeServiceName,
  parseDatasetRows,
} from "../../src/domain/loader";
import { SERVICE_TYPES } from "../../src/domain/types";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const WORKBOOK_PATH = path.resolve(
  REPO_ROOT,
  "data/Air_Freight_RFP_Mock_Data.xlsx",
);

async function buildMinimalXlsx(params: {
  sheets: Array<{ name: string; xml: string }>;
  sharedStringsXml?: string;
}): Promise<Buffer> {
  const zip = new JSZip();
  const sheetEntries = params.sheets
    .map(
      (s, idx) =>
        `<sheet name="${s.name}" sheetId="${idx + 1}" r:id="rId${idx + 1}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" />`,
    )
    .join("");
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="utf-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>${sheetEntries}</sheets></workbook>`,
  );

  const relEntries = params.sheets
    .map(
      (_, idx) =>
        `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml" Id="rId${idx + 1}" />`,
    )
    .join("");
  const ssRel = params.sharedStringsXml
    ? `<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml" Id="rIdSS" />`
    : "";
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntries}${ssRel}</Relationships>`,
  );

  params.sheets.forEach((s, idx) => {
    zip.file(`xl/worksheets/sheet${idx + 1}.xml`, s.xml);
  });

  if (params.sharedStringsXml) {
    zip.file("xl/sharedStrings.xml", params.sharedStringsXml);
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

describe("normalizeServiceName & airport validation", () => {
  it("normalizes all canonical Transit Table labels and enum names", () => {
    assert.equal(
      normalizeServiceName("Temperature controlled (2-8 C)"),
      "TEMP_CONTROLLED",
    );
    assert.equal(normalizeServiceName("  temp_controlled  "), "TEMP_CONTROLLED");
    assert.equal(normalizeServiceName("Dangerous goods"), "DANGEROUS_GOODS");
    assert.equal(
      normalizeServiceName("HIGH-VALUE SECURITY"),
      "HIGH_VALUE_SECURITY",
    );
    assert.equal(normalizeServiceName("Fragile handling"), "FRAGILE");
    assert.equal(normalizeServiceName("Oversized cargo"), "OVERSIZED");
    assert.equal(normalizeServiceName("Dry ice"), null);
    assert.equal(normalizeServiceName(""), null);
  });

  it("validates 3-letter IATA airport codes", () => {
    assert.equal(isValidAirportCode("JFK"), true);
    assert.equal(isValidAirportCode(" lax "), true);
    assert.equal(isValidAirportCode("JF"), false);
    assert.equal(isValidAirportCode("JFK1"), false);
    assert.equal(isValidAirportCode(""), false);
  });
});

describe("loadDatasetFromFile & loadDatasetFromBuffer", () => {
  it("loads the mock workbook with 100 lanes, 100 flights, 20 airports, and zero issues", async () => {
    const dataset = await loadDatasetFromFile(WORKBOOK_PATH);

    assert.deepEqual(dataset.issues, []);
    assert.equal(dataset.lanes.length, 100);
    assert.equal(dataset.flights.length, 100);
    assert.equal(dataset.airports.length, 20);

    for (const flight of dataset.flights) {
      assert.ok(flight.transitDays > 0);
      for (const svc of flight.availableServices) {
        assert.ok(SERVICE_TYPES.includes(svc));
      }
    }

    assert.equal(dataset.lanes[0]?.laneNumber, 1);
    assert.equal(dataset.lanes[0]?.laneCode, "FAI-SIN");
    assert.equal(dataset.lanes[0]?.origin, "FAI");
    assert.equal(dataset.lanes[0]?.destination, "SIN");
    assert.equal(dataset.lanes[0]?.tons, 46.1);
    assert.equal(dataset.lanes[0]?.maxTransitDays, 20);

    assert.equal(dataset.lanes[99]?.laneNumber, 100);
    assert.equal(dataset.lanes[99]?.laneCode, "SIN-JFK");
    assert.equal(dataset.lanes[99]?.origin, "SIN");
    assert.equal(dataset.lanes[99]?.destination, "JFK");
    assert.equal(dataset.lanes[99]?.tons, 6.9);
    assert.equal(dataset.lanes[99]?.maxTransitDays, 25);

    assert.deepEqual(dataset.flights[0], {
      flightNumber: 1,
      origin: "JFK",
      destination: "ORD",
      transitDays: 10,
      availableServices: ["FRAGILE", "OVERSIZED"],
    });
  });

  it("loads cleanly from an in-memory buffer", async () => {
    const bytes = await fs.readFile(WORKBOOK_PATH);
    const dataset = await loadDatasetFromBuffer(bytes);
    assert.deepEqual(dataset.issues, []);
    assert.equal(dataset.lanes.length, 100);
    assert.equal(dataset.flights.length, 100);
  });

  it("supports unprefixed SpreadsheetML workbooks with sharedStrings and sparse cells", async () => {
    const buffer = await buildMinimalXlsx({
      sharedStringsXml: `<?xml version="1.0" encoding="utf-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>JFK</t></si><si><t>LAX</t></si><si><r><t>Standard </t></r><r><t>general cargo is fine.</t></r></si><si><t>Fragile handling</t></si></sst>`,
      sheets: [
        {
          name: "Shipper RFP",
          xml: `<?xml version="1.0" encoding="utf-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Origin</t></is></c></row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="C2"><v>15.5</v></c><c r="D2"><v>4</v></c><c r="E2" t="s"><v>2</v></c></row></sheetData></worksheet>`,
        },
        {
          name: "Transit Table",
          xml: `<?xml version="1.0" encoding="utf-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Origin</t></is></c></row><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="C2"><v>3</v></c><c r="D2" t="s"><v>3</v></c></row></sheetData></worksheet>`,
        },
      ],
    });

    const dataset = await loadDatasetFromBuffer(buffer);
    assert.deepEqual(dataset.issues, []);
    assert.equal(dataset.lanes.length, 1);
    assert.equal(dataset.lanes[0]?.rawEmail, "Standard general cargo is fine.");
    assert.equal(dataset.flights.length, 1);
    assert.deepEqual(dataset.flights[0]?.availableServices, ["FRAGILE"]);
  });

  it("collects an error issue instead of throwing on missing or corrupt files", async () => {
    const missing = await loadDatasetFromFile("data/nonexistent_file.xlsx");
    assert.deepEqual(missing.lanes, []);
    assert.deepEqual(missing.flights, []);
    assert.equal(missing.issues.length, 1);
    assert.equal(missing.issues[0]?.severity, "ERROR");

    const corrupt = await loadDatasetFromBuffer(Buffer.from("not an xlsx"));
    assert.deepEqual(corrupt.lanes, []);
    assert.equal(corrupt.issues.length, 1);
    assert.equal(corrupt.issues[0]?.severity, "ERROR");
  });

  it("collects missing-sheet errors without crashing", async () => {
    const buffer = await buildMinimalXlsx({
      sheets: [
        {
          name: "Other Sheet",
          xml: `<?xml version="1.0" encoding="utf-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`,
        },
      ],
    });
    const dataset = await loadDatasetFromBuffer(buffer);
    assert.deepEqual(dataset.lanes, []);
    assert.equal(dataset.issues.length, 2);
    assert.ok(dataset.issues.every((i) => i.severity === "ERROR"));
  });
});

describe("parseDatasetRows defensive validation", () => {
  it("collects errors and warnings for bad rows without crashing", () => {
    const dataset = parseDatasetRows(
      [
        {
          rowNumber: 2,
          origin: " jfk ",
          destination: "lax",
          tons: 12.5,
          maxTransitDays: 5,
          rawEmail: "JFK to LAX standard general cargo.",
        },
        {
          rowNumber: 3,
          origin: "JFK",
          destination: "LAX",
          tons: 9,
          maxTransitDays: 4,
          rawEmail: "Duplicate lane",
        },
        {
          rowNumber: 4,
          origin: "BAD1",
          destination: "LAX",
          tons: -5,
          maxTransitDays: 3.5,
          rawEmail: "Bad row",
        },
        {
          rowNumber: 5,
          origin: "ORD",
          destination: "ORD",
          tons: 10,
          maxTransitDays: 3,
          rawEmail: "Self loop",
        },
        {
          rowNumber: 6,
          origin: "ZZZ",
          destination: "LAX",
          tons: 4,
          maxTransitDays: 6,
          rawEmail: "   ",
        },
      ],
      [
        {
          rowNumber: 2,
          origin: "JFK",
          destination: "LAX",
          transitDays: 4,
          availableServices: "Fragile handling; Dry ice; Oversized cargo",
        },
        {
          rowNumber: 3,
          origin: "JFK",
          destination: "LAX",
          transitDays: 2,
          availableServices: "",
        },
        {
          rowNumber: 4,
          origin: "JFK",
          destination: "JFK",
          transitDays: 1,
          availableServices: "",
        },
        {
          rowNumber: 5,
          origin: "LAX",
          destination: "ORD",
          transitDays: 0,
          availableServices: "",
        },
      ],
    );

    assert.equal(dataset.flights.length, 1);
    assert.deepEqual(dataset.flights[0]?.availableServices, [
      "FRAGILE",
      "OVERSIZED",
    ]);

    assert.equal(dataset.lanes.length, 2);
    assert.deepEqual(
      dataset.lanes.map((l) => l.laneCode),
      ["JFK-LAX", "ZZZ-LAX"],
    );

    const errors = dataset.issues.filter((i) => i.severity === "ERROR");
    const warnings = dataset.issues.filter((i) => i.severity === "WARNING");
    const warningFields = new Set(warnings.map((w) => w.field));

    assert.ok(errors.length >= 5);
    for (const expectedField of [
      "availableServices",
      "origin/destination",
      "rawEmail",
      "origin",
    ]) {
      assert.ok(warningFields.has(expectedField));
    }
  });
});
