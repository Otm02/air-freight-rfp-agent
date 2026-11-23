import path from "node:path";
import JSZip from "jszip";
import { SaxesParser, type SaxesTagNS } from "saxes";

export interface ParsedWorksheetRow {
  rowNumber: number;
  cells: unknown[];
}

export interface ParsedWorksheet {
  name: string;
  rows: ParsedWorksheetRow[];
}

function stripBom(xml: string): string {
  return xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
}

function getAttrLocal(tag: SaxesTagNS, localName: string): string | undefined {
  const direct = tag.attributes[localName];
  if (direct) {
    return direct.value;
  }
  for (const attr of Object.values(tag.attributes)) {
    if (attr.local === localName) {
      return attr.value;
    }
  }
  return undefined;
}

function colRefToIndex(ref: string): number | null {
  const match = /^([A-Za-z]+)/.exec(ref.trim());
  if (!match || !match[1]) {
    return null;
  }
  const letters = match[1].toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i += 1) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return col - 1;
}

function normalizeRelTarget(target: string): string {
  const cleaned = target.replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleaned.startsWith("xl/")) {
    return path.posix.normalize(cleaned);
  }
  return path.posix.normalize(`xl/${cleaned}`);
}

function runXmlParser(
  xml: string,
  setup: (parser: SaxesParser<{ xmlns: true }>) => void,
): void {
  const parser = new SaxesParser({ xmlns: true });
  parser.on("error", (err) => {
    throw err;
  });
  setup(parser);
  parser.write(stripBom(xml)).close();
}

function parseRelationships(xml: string): Map<string, string> {
  const rels = new Map<string, string>();
  runXmlParser(xml, (parser) => {
    parser.on("opentag", (tag) => {
      if (tag.local !== "Relationship") {
        return;
      }
      const id = getAttrLocal(tag, "Id");
      const target = getAttrLocal(tag, "Target");
      if (id && target) {
        rels.set(id, normalizeRelTarget(target));
      }
    });
  });
  return rels;
}

function parseWorkbookSheets(
  xml: string,
): Array<{ name: string; relId: string }> {
  const sheets: Array<{ name: string; relId: string }> = [];
  runXmlParser(xml, (parser) => {
    parser.on("opentag", (tag) => {
      if (tag.local !== "sheet") {
        return;
      }
      const name = getAttrLocal(tag, "name");
      const relId = getAttrLocal(tag, "id");
      if (name && relId) {
        sheets.push({ name, relId });
      }
    });
  });
  return sheets;
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  let inSi = false;
  let inText = false;
  let current = "";

  runXmlParser(xml, (parser) => {
    parser.on("opentag", (tag) => {
      if (tag.local === "si") {
        inSi = true;
        current = "";
      } else if (inSi && tag.local === "t") {
        inText = true;
      }
    });

    parser.on("text", (text) => {
      if (inSi && inText) {
        current += text;
      }
    });

    parser.on("cdata", (cdata) => {
      if (inSi && inText) {
        current += cdata;
      }
    });

    parser.on("closetag", (tag) => {
      if (tag.local === "t") {
        inText = false;
      } else if (tag.local === "si") {
        strings.push(current);
        inSi = false;
        inText = false;
        current = "";
      }
    });
  });

  return strings;
}

function parseWorksheetRows(
  xml: string,
  sharedStrings: readonly string[],
): ParsedWorksheetRow[] {
  const rows: ParsedWorksheetRow[] = [];
  let autoRowNumber = 0;
  let currentRowNumber = 0;
  let currentCells: unknown[] = [];
  let inRow = false;

  let inCell = false;
  let cellColIdx = 0;
  let nextColCursor = 0;
  let cellType = "";
  let inValue = false;
  let inInlineStr = false;
  let inInlineText = false;
  let hasCellValue = false;
  let buf = "";

  runXmlParser(xml, (parser) => {
    parser.on("opentag", (tag) => {
      switch (tag.local) {
        case "row": {
          inRow = true;
          autoRowNumber += 1;
          const rAttr = getAttrLocal(tag, "r");
          const parsedRowNum = rAttr ? Number.parseInt(rAttr, 10) : NaN;
          currentRowNumber =
            Number.isInteger(parsedRowNum) && parsedRowNum > 0
              ? parsedRowNum
              : autoRowNumber;
          autoRowNumber = currentRowNumber;
          currentCells = [];
          nextColCursor = 0;
          break;
        }
        case "c": {
          if (!inRow) {
            return;
          }
          inCell = true;
          const refAttr = getAttrLocal(tag, "r");
          const parsedCol = refAttr ? colRefToIndex(refAttr) : null;
          cellColIdx = parsedCol !== null ? parsedCol : nextColCursor;
          nextColCursor = cellColIdx + 1;
          cellType = getAttrLocal(tag, "t") ?? "";
          inValue = false;
          inInlineStr = false;
          inInlineText = false;
          hasCellValue = false;
          buf = "";
          break;
        }
        case "v": {
          if (inCell && cellType !== "inlineStr") {
            inValue = true;
            hasCellValue = true;
            buf = "";
          }
          break;
        }
        case "is": {
          if (inCell) {
            inInlineStr = true;
            hasCellValue = true;
            buf = "";
          }
          break;
        }
        case "t": {
          if (inCell && inInlineStr) {
            inInlineText = true;
          }
          break;
        }
      }
    });

    const appendText = (chunk: string): void => {
      if (inValue || (inInlineStr && inInlineText)) {
        buf += chunk;
      }
    };

    parser.on("text", appendText);
    parser.on("cdata", appendText);

    parser.on("closetag", (tag) => {
      switch (tag.local) {
        case "v":
          inValue = false;
          break;
        case "t":
          inInlineText = false;
          break;
        case "is":
          inInlineStr = false;
          break;
        case "c": {
          if (!inCell) {
            return;
          }
          if (hasCellValue) {
            let value: unknown = buf;
            if (cellType === "" || cellType === "n") {
              const trimmed = buf.trim();
              if (trimmed === "") {
                value = undefined;
              } else {
                const num = Number(trimmed);
                value = Number.isFinite(num) ? num : buf;
              }
            } else if (cellType === "s") {
              const idx = Number.parseInt(buf.trim(), 10);
              value =
                Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length
                  ? sharedStrings[idx]
                  : "";
            } else if (cellType === "b") {
              const lower = buf.trim().toLowerCase();
              value = lower === "1" || lower === "true";
            }
            if (value !== undefined) {
              currentCells[cellColIdx] = value;
            }
          }
          inCell = false;
          inValue = false;
          inInlineStr = false;
          inInlineText = false;
          buf = "";
          break;
        }
        case "row": {
          if (!inRow) {
            return;
          }
          const hasNonEmpty = currentCells.some(
            (cell) =>
              cell !== undefined && cell !== null && String(cell).trim() !== "",
          );
          if (hasNonEmpty) {
            rows.push({
              rowNumber: currentRowNumber,
              cells: currentCells,
            });
          }
          inRow = false;
          currentCells = [];
          break;
        }
      }
    });
  });

  return rows;
}

function getZipEntryText(
  zip: JSZip,
  targetPath: string,
): Promise<string> | null {
  const exact = zip.file(targetPath);
  if (exact) {
    return exact.async("string");
  }
  const normalized = targetPath.toLowerCase();
  for (const [name, entry] of Object.entries(zip.files)) {
    if (!entry.dir && name.replace(/^\/+/, "").toLowerCase() === normalized) {
      return entry.async("string");
    }
  }
  return null;
}

export async function readXlsxWorkbook(
  buffer: Buffer | ArrayBuffer | Uint8Array,
): Promise<Map<string, ParsedWorksheet>> {
  const zip = await JSZip.loadAsync(buffer);

  const workbookXmlPromise = getZipEntryText(zip, "xl/workbook.xml");
  const relsXmlPromise = getZipEntryText(zip, "xl/_rels/workbook.xml.rels");
  if (!workbookXmlPromise || !relsXmlPromise) {
    throw new Error(
      "Invalid .xlsx archive: missing xl/workbook.xml or xl/_rels/workbook.xml.rels.",
    );
  }

  const [workbookXml, relsXml, sharedStringsXml] = await Promise.all([
    workbookXmlPromise,
    relsXmlPromise,
    getZipEntryText(zip, "xl/sharedStrings.xml") ?? Promise.resolve(""),
  ]);

  const sheetDefs = parseWorkbookSheets(workbookXml);
  const rels = parseRelationships(relsXml);
  const sharedStrings = sharedStringsXml
    ? parseSharedStrings(sharedStringsXml)
    : [];

  const worksheets = new Map<string, ParsedWorksheet>();
  for (const def of sheetDefs) {
    const targetPath = rels.get(def.relId);
    if (!targetPath) {
      continue;
    }
    const sheetXmlPromise = getZipEntryText(zip, targetPath);
    if (!sheetXmlPromise) {
      continue;
    }
    const sheetXml = await sheetXmlPromise;
    worksheets.set(def.name, {
      name: def.name,
      rows: parseWorksheetRows(sheetXml, sharedStrings),
    });
  }

  return worksheets;
}
