import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDatasetFromFile } from "../../src/domain/loader";
import {
  CONFIDENCE_THRESHOLD,
  extractRequirementsOffline,
} from "../../src/domain/requirements";
import type { GoldRequirementRecord } from "../../src/domain/types";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const WORKBOOK_PATH = path.resolve(
  REPO_ROOT,
  "data/Air_Freight_RFP_Mock_Data.xlsx",
);
const GOLD_PATH = path.resolve(REPO_ROOT, "data/gold_requirements.json");

describe("extractRequirementsOffline against 100-lane gold dataset", () => {
  it("achieves 100/100 exact accuracy and verbatim evidence quotes across all RFP lanes", async () => {
    const dataset = await loadDatasetFromFile(WORKBOOK_PATH);
    const goldRaw = await fs.readFile(GOLD_PATH, "utf-8");
    const gold = JSON.parse(goldRaw) as GoldRequirementRecord[];

    assert.equal(dataset.lanes.length, 100);
    assert.equal(gold.length, 100);

    let exactMatches = 0;
    let standardCargoCount = 0;
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;

    for (let i = 0; i < dataset.lanes.length; i += 1) {
      const lane = dataset.lanes[i]!;
      const expected = gold[i]!;

      assert.equal(lane.laneNumber, expected.laneNumber);
      assert.equal(lane.laneCode, expected.laneCode);

      const extracted = extractRequirementsOffline(lane.rawEmail, {
        origin: lane.origin,
        destination: lane.destination,
      });

      const predSet = new Set(extracted.requestedServices);
      const goldSet = new Set(expected.requestedServices);

      for (const s of predSet) {
        if (goldSet.has(s)) {
          truePositives += 1;
        } else {
          falsePositives += 1;
        }
      }
      for (const s of goldSet) {
        if (!predSet.has(s)) {
          falseNegatives += 1;
        }
      }

      if (
        extracted.requestedServices.length ===
          expected.requestedServices.length &&
        extracted.requestedServices.every(
          (svc, idx) => svc === expected.requestedServices[idx],
        )
      ) {
        exactMatches += 1;
      }

      assert.deepEqual(extracted.requestedServices, expected.requestedServices);
      assert.ok(extracted.confidence >= CONFIDENCE_THRESHOLD);
      assert.ok(extracted.confidence >= 0.95);
      assert.equal(extracted.needsHumanReview, false);
      assert.deepEqual(extracted.unmappedPhrases, []);

      for (const ev of extracted.evidence) {
        assert.equal(lane.rawEmail.includes(ev.quote), true);
        assert.equal(ev.quote, expected.expectedQuotes[ev.service]);
      }

      if (expected.standardCargo) {
        standardCargoCount += 1;
        assert.deepEqual(extracted.requestedServices, []);
        assert.equal(
          extracted.standardCargoQuote,
          expected.expectedQuotes.standardCargo,
        );
        assert.equal(
          lane.rawEmail.includes(extracted.standardCargoQuote!),
          true,
        );
      } else {
        assert.equal(extracted.standardCargoQuote, null);
      }
    }

    const precision = truePositives / (truePositives + falsePositives);
    const recall = truePositives / (truePositives + falseNegatives);

    assert.equal(standardCargoCount, 15);
    assert.equal(exactMatches, 100);
    assert.equal(precision, 1);
    assert.equal(recall, 1);
  });
});

describe("extractRequirementsOffline edge cases and escalation triggers", () => {
  it("flags empty and vague emails for human review with low confidence", () => {
    const empty = extractRequirementsOffline("   ");
    assert.equal(empty.confidence, 0);
    assert.equal(empty.needsHumanReview, true);
    assert.deepEqual(empty.requestedServices, []);

    const vague = extractRequirementsOffline(
      "Hi, please send a quote for JFK to LAX next Tuesday. Thanks!",
      { origin: "JFK", destination: "LAX" },
    );
    assert.ok(vague.confidence < CONFIDENCE_THRESHOLD);
    assert.equal(vague.needsHumanReview, true);
    assert.deepEqual(vague.requestedServices, []);
  });

  it("flags conflicting standard-cargo and special-service cues", () => {
    const conflict = extractRequirementsOffline(
      "Standard general cargo is fine, though please also arrange dangerous-goods handling.",
    );
    assert.deepEqual(conflict.requestedServices, ["DANGEROUS_GOODS"]);
    assert.notEqual(conflict.standardCargoQuote, null);
    assert.ok(conflict.confidence < CONFIDENCE_THRESHOLD);
    assert.equal(conflict.needsHumanReview, true);
  });

  it("ignores negated services instead of falsely extracting them", () => {
    const negated = extractRequirementsOffline(
      "For ORD to DXB, no cold chain needed; standard general cargo is fine.",
      { origin: "ORD", destination: "DXB" },
    );
    assert.deepEqual(negated.requestedServices, []);
    assert.notEqual(negated.standardCargoQuote, null);
    assert.ok(negated.warnings.length > 0);
    assert.equal(negated.needsHumanReview, true);
  });

  it("flags out-of-catalog requirements like dry ice, -20 C, and live animals", () => {
    const unmapped = extractRequirementsOffline(
      "Please ship with dry ice at -20 C and live animals handling for FRA-YYZ.",
      { origin: "FRA", destination: "YYZ" },
    );
    assert.ok(unmapped.unmappedPhrases.length >= 2);
    assert.ok(unmapped.confidence < CONFIDENCE_THRESHOLD);
    assert.equal(unmapped.needsHumanReview, true);
  });

  it("extracts unseen natural-language synonyms with verbatim quotes", () => {
    const email =
      "Ship hazmat cargo with armored transport, out-of-gauge dimensions, delicate handling, and 2-8°C chilled control.";
    const extracted = extractRequirementsOffline(email);
    assert.deepEqual(extracted.requestedServices, [
      "TEMP_CONTROLLED",
      "DANGEROUS_GOODS",
      "HIGH_VALUE_SECURITY",
      "FRAGILE",
      "OVERSIZED",
    ]);
    assert.equal(extracted.needsHumanReview, false);
    for (const ev of extracted.evidence) {
      assert.equal(email.includes(ev.quote), true);
    }
  });

  it("flags O-D mismatches between email body and tabular lane codes", () => {
    const mismatch = extractRequirementsOffline(
      "Hi, for JFK-LHR we need fragile handling on every leg.",
      { origin: "JFK", destination: "LAX" },
    );
    assert.deepEqual(mismatch.requestedServices, ["FRAGILE"]);
    assert.equal(mismatch.warnings.length, 1);
    assert.ok(mismatch.confidence < CONFIDENCE_THRESHOLD);
    assert.equal(mismatch.needsHumanReview, true);
  });
});
