import fs from "node:fs/promises";
import {
  SERVICE_TYPES,
  type AirportCode,
  type DataIssue,
  type Flight,
  type Lane,
  type LoadedDataset,
  type ServiceType,
} from "./types";
import { readXlsxWorkbook, type ParsedWorksheet } from "./xlsx-reader";

export interface RawRfpRow {
  rowNumber?: number;
  origin: unknown;
  destination: unknown;
  tons: unknown;
  maxTransitDays: unknown;
  rawEmail: unknown;
}

export interface RawTransitRow {
  rowNumber?: number;
  origin: unknown;
  destination: unknown;
  transitDays: unknown;
  availableServices: unknown;
}

const SERVICE_ALIAS_MAP: Readonly<Record<string, ServiceType>> = {
  "temperature controlled (2-8 c)": "TEMP_CONTROLLED",
  "temperature controlled 2-8 c": "TEMP_CONTROLLED",
  "temperature controlled": "TEMP_CONTROLLED",
  "temp controlled": "TEMP_CONTROLLED",
  temp_controlled: "TEMP_CONTROLLED",
  "temp-controlled": "TEMP_CONTROLLED",
  "cold chain": "TEMP_CONTROLLED",
  "2-8 c": "TEMP_CONTROLLED",
  "dangerous goods": "DANGEROUS_GOODS",
  "dangerous-goods": "DANGEROUS_GOODS",
  dangerous_goods: "DANGEROUS_GOODS",
  "high-value security": "HIGH_VALUE_SECURITY",
  "high value security": "HIGH_VALUE_SECURITY",
  high_value_security: "HIGH_VALUE_SECURITY",
  "fragile handling": "FRAGILE",
  fragile: "FRAGILE",
  "oversized cargo": "OVERSIZED",
  "oversized-cargo": "OVERSIZED",
  oversized: "OVERSIZED",
};

const AIRPORT_RE = /^[A-Z]{3}$/;

export function normalizeAirportCode(value: unknown): AirportCode | null {
  const str = cellToString(value).trim().toUpperCase();
  return AIRPORT_RE.test(str) ? str : null;
}

export function isValidAirportCode(value: string): boolean {
  return AIRPORT_RE.test(value.trim().toUpperCase());
}

export function normalizeServiceName(raw: string): ServiceType | null {
  const key = raw.trim().toLowerCase().replace(/\s+/g, " ");
  if (!key) {
    return null;
  }
  return SERVICE_ALIAS_MAP[key] ?? null;
}

function parsePositiveNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  const str = cellToString(value).trim();
  if (!str) {
    return null;
  }
  const num = Number(str);
  return Number.isFinite(num) && num > 0 ? num : null;
}

function parsePositiveInt(value: unknown): number | null {
  const num = parsePositiveNumber(value);
  if (num === null) {
    return null;
  }
  return Number.isInteger(num) ? num : null;
}

function cellToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function sortServicesCanonical(services: Iterable<ServiceType>): ServiceType[] {
  const set = new Set(services);
  return SERVICE_TYPES.filter((svc) => set.has(svc));
}

export function parseDatasetRows(
  rfpRows: readonly RawRfpRow[],
  transitRows: readonly RawTransitRow[],
): LoadedDataset {
  const issues: DataIssue[] = [];
  const flights: Flight[] = [];
  const lanes: Lane[] = [];
  const seenFlights = new Set<string>();
  const seenLanes = new Set<string>();
  const transitAirports = new Set<AirportCode>();
  const allAirports = new Set<AirportCode>();

  transitRows.forEach((row, index) => {
    const rowNumber = row.rowNumber ?? index + 2;
    const origin = normalizeAirportCode(row.origin);
    const destination = normalizeAirportCode(row.destination);
    const transitDays = parsePositiveInt(row.transitDays);

    let hasRowError = false;

    if (origin === null) {
      hasRowError = true;
      issues.push({
        sheet: "Transit Table",
        rowNumber,
        field: "origin",
        severity: "ERROR",
        message: "Origin airport must be a 3-letter IATA code.",
        rawValue: cellToString(row.origin),
      });
    }

    if (destination === null) {
      hasRowError = true;
      issues.push({
        sheet: "Transit Table",
        rowNumber,
        field: "destination",
        severity: "ERROR",
        message: "Destination airport must be a 3-letter IATA code.",
        rawValue: cellToString(row.destination),
      });
    }

    if (origin !== null && destination !== null && origin === destination) {
      hasRowError = true;
      issues.push({
        sheet: "Transit Table",
        rowNumber,
        field: "destination",
        severity: "ERROR",
        message: `Flight ${origin}->${destination} is a self-loop.`,
        rawValue: `${origin}->${destination}`,
      });
    }

    if (transitDays === null) {
      hasRowError = true;
      issues.push({
        sheet: "Transit Table",
        rowNumber,
        field: "transitDays",
        severity: "ERROR",
        message: "Transit time must be a positive integer (days).",
        rawValue: cellToString(row.transitDays),
      });
    }

    if (hasRowError || origin === null || destination === null || transitDays === null) {
      return;
    }

    const edgeKey = `${origin}->${destination}`;
    if (seenFlights.has(edgeKey)) {
      issues.push({
        sheet: "Transit Table",
        rowNumber,
        field: "origin/destination",
        severity: "WARNING",
        message: `Duplicate directed flight ${edgeKey}; keeping first occurrence.`,
        rawValue: edgeKey,
      });
      return;
    }

    const rawServices = cellToString(row.availableServices);
    const parsedServices: ServiceType[] = [];
    if (rawServices.trim().length > 0) {
      const tokens = rawServices
        .split(/[;,]/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0);
      for (const token of tokens) {
        const normalized = normalizeServiceName(token);
        if (normalized === null) {
          issues.push({
            sheet: "Transit Table",
            rowNumber,
            field: "availableServices",
            severity: "WARNING",
            message: `Unknown flight service "${token}" on ${edgeKey}; ignored.`,
            rawValue: token,
          });
        } else {
          parsedServices.push(normalized);
        }
      }
    }

    seenFlights.add(edgeKey);
    transitAirports.add(origin);
    transitAirports.add(destination);
    allAirports.add(origin);
    allAirports.add(destination);

    flights.push({
      flightNumber: flights.length + 1,
      origin,
      destination,
      transitDays,
      availableServices: sortServicesCanonical(parsedServices),
    });
  });

  rfpRows.forEach((row, index) => {
    const rowNumber = row.rowNumber ?? index + 2;
    const origin = normalizeAirportCode(row.origin);
    const destination = normalizeAirportCode(row.destination);
    const tons = parsePositiveNumber(row.tons);
    const maxTransitDays = parsePositiveInt(row.maxTransitDays);
    const rawEmail = cellToString(row.rawEmail).trim();

    let hasRowError = false;

    if (origin === null) {
      hasRowError = true;
      issues.push({
        sheet: "Shipper RFP",
        rowNumber,
        field: "origin",
        severity: "ERROR",
        message: "Origin airport must be a 3-letter IATA code.",
        rawValue: cellToString(row.origin),
      });
    }

    if (destination === null) {
      hasRowError = true;
      issues.push({
        sheet: "Shipper RFP",
        rowNumber,
        field: "destination",
        severity: "ERROR",
        message: "Destination airport must be a 3-letter IATA code.",
        rawValue: cellToString(row.destination),
      });
    }

    if (origin !== null && destination !== null && origin === destination) {
      hasRowError = true;
      issues.push({
        sheet: "Shipper RFP",
        rowNumber,
        field: "destination",
        severity: "ERROR",
        message: `Lane ${origin}-${destination} has identical origin and destination.`,
        rawValue: `${origin}-${destination}`,
      });
    }

    if (tons === null) {
      hasRowError = true;
      issues.push({
        sheet: "Shipper RFP",
        rowNumber,
        field: "tons",
        severity: "ERROR",
        message: "Tons of freight must be a finite positive number.",
        rawValue: cellToString(row.tons),
      });
    }

    if (maxTransitDays === null) {
      hasRowError = true;
      issues.push({
        sheet: "Shipper RFP",
        rowNumber,
        field: "maxTransitDays",
        severity: "ERROR",
        message: "Maximum transit time must be a positive integer (days).",
        rawValue: cellToString(row.maxTransitDays),
      });
    }

    if (
      hasRowError ||
      origin === null ||
      destination === null ||
      tons === null ||
      maxTransitDays === null
    ) {
      return;
    }

    const laneCode = `${origin}-${destination}`;
    if (seenLanes.has(laneCode)) {
      issues.push({
        sheet: "Shipper RFP",
        rowNumber,
        field: "origin/destination",
        severity: "WARNING",
        message: `Duplicate RFP lane ${laneCode}; keeping first occurrence.`,
        rawValue: laneCode,
      });
      return;
    }

    if (!rawEmail) {
      issues.push({
        sheet: "Shipper RFP",
        rowNumber,
        field: "rawEmail",
        severity: "WARNING",
        message: `Lane ${laneCode} has empty shipper email text; intake review will be required.`,
      });
    }

    if (!transitAirports.has(origin)) {
      issues.push({
        sheet: "Shipper RFP",
        rowNumber,
        field: "origin",
        severity: "WARNING",
        message: `Origin airport ${origin} on lane ${laneCode} has no flights in Transit Table.`,
        rawValue: origin,
      });
    }

    if (!transitAirports.has(destination)) {
      issues.push({
        sheet: "Shipper RFP",
        rowNumber,
        field: "destination",
        severity: "WARNING",
        message: `Destination airport ${destination} on lane ${laneCode} has no flights in Transit Table.`,
        rawValue: destination,
      });
    }

    seenLanes.add(laneCode);
    allAirports.add(origin);
    allAirports.add(destination);

    lanes.push({
      laneNumber: lanes.length + 1,
      laneCode,
      origin,
      destination,
      tons,
      maxTransitDays,
      rawEmail,
    });
  });

  return {
    lanes,
    flights,
    airports: [...allAirports].sort(),
    issues,
  };
}

function findSheet(
  sheets: ReadonlyMap<string, ParsedWorksheet>,
  expectedName: string,
): ParsedWorksheet | undefined {
  const exact = sheets.get(expectedName);
  if (exact) {
    return exact;
  }
  const targetLower = expectedName.trim().toLowerCase();
  for (const [name, sheet] of sheets.entries()) {
    if (name.trim().toLowerCase() === targetLower) {
      return sheet;
    }
  }
  return undefined;
}

export async function loadDatasetFromBuffer(
  buffer: Buffer | ArrayBuffer | Uint8Array,
): Promise<LoadedDataset> {
  let sheets: Map<string, ParsedWorksheet>;
  try {
    sheets = await readXlsxWorkbook(buffer);
  } catch (error) {
    return {
      lanes: [],
      flights: [],
      airports: [],
      issues: [
        {
          sheet: "Workbook",
          rowNumber: null,
          field: "file",
          severity: "ERROR",
          message: `Failed to parse Excel workbook: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }

  const rfpSheet = findSheet(sheets, "Shipper RFP");
  const transitSheet = findSheet(sheets, "Transit Table");
  const missingIssues: DataIssue[] = [];

  if (!rfpSheet) {
    missingIssues.push({
      sheet: "Workbook",
      rowNumber: null,
      field: "sheet",
      severity: "ERROR",
      message: 'Required worksheet "Shipper RFP" not found.',
    });
  }
  if (!transitSheet) {
    missingIssues.push({
      sheet: "Workbook",
      rowNumber: null,
      field: "sheet",
      severity: "ERROR",
      message: 'Required worksheet "Transit Table" not found.',
    });
  }

  if (missingIssues.length > 0 || !rfpSheet || !transitSheet) {
    return {
      lanes: [],
      flights: [],
      airports: [],
      issues: missingIssues,
    };
  }

  const rfpRows: RawRfpRow[] = rfpSheet.rows
    .filter((row) => row.rowNumber > 1)
    .map((row) => ({
      rowNumber: row.rowNumber,
      origin: row.cells[0],
      destination: row.cells[1],
      tons: row.cells[2],
      maxTransitDays: row.cells[3],
      rawEmail: row.cells[4],
    }));

  const transitRows: RawTransitRow[] = transitSheet.rows
    .filter((row) => row.rowNumber > 1)
    .map((row) => ({
      rowNumber: row.rowNumber,
      origin: row.cells[0],
      destination: row.cells[1],
      transitDays: row.cells[2],
      availableServices: row.cells[3],
    }));

  return parseDatasetRows(rfpRows, transitRows);
}

export async function loadDatasetFromFile(
  filePath: string,
): Promise<LoadedDataset> {
  try {
    const bytes = await fs.readFile(filePath);
    return loadDatasetFromBuffer(bytes);
  } catch (error) {
    return {
      lanes: [],
      flights: [],
      airports: [],
      issues: [
        {
          sheet: "Workbook",
          rowNumber: null,
          field: "file",
          severity: "ERROR",
          message: `Unable to read workbook "${filePath}": ${error instanceof Error ? error.message : String(error)}`,
          rawValue: filePath,
        },
      ],
    };
  }
}
