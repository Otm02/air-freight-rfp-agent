import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assessAllLanes, assessLane } from "../../src/domain/assessment";
import { loadDatasetFromFile } from "../../src/domain/loader";
import { buildFlightGraph } from "../../src/domain/routing";
import type { LaneStatus } from "../../src/domain/types";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const WORKBOOK_PATH = path.resolve(
  REPO_ROOT,
  "data/Air_Freight_RFP_Mock_Data.xlsx",
);
const ANALYZE_SCRIPT_PATH = path.resolve(REPO_ROOT, "scripts/analyze-data.py");

interface PythonRouteJson {
  days: number;
  hops: number;
  path: string[];
}

interface PythonLaneJson {
  lane_id: number;
  origin: string;
  dest: string;
  category_compliance_first: LaneStatus;
  best_compliant_route: PythonRouteJson | null;
  fastest_unconstrained_route: PythonRouteJson | null;
}

interface PythonReportJson {
  classifications: {
    compliance_first_counts: Record<LaneStatus, number>;
    tradeoff_matrix_reachable_95: {
      compliant_late_with_ontime_noncompliant_fallback: number;
      compliant_late_no_ontime_route: number;
    };
  };
  lanes: PythonLaneJson[];
}

describe("lane assessment 100/100 parity with scripts/analyze-data.py", () => {
  it("matches Python analysis counts and every single lane classification and route", async () => {
    const dataset = await loadDatasetFromFile(WORKBOOK_PATH);
    assert.deepEqual(dataset.issues, []);

    const { assessments, summary } = assessAllLanes(
      dataset.lanes,
      dataset.flights,
    );
    assert.equal(assessments.length, 100);
    assert.equal(summary.totalLanes, 100);

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rfp-parity-"));
    const jsonPath = path.join(tmpDir, "report.json");
    try {
      execFileSync(
        "python",
        [ANALYZE_SCRIPT_PATH, WORKBOOK_PATH, "--json", jsonPath],
        { stdio: "pipe" },
      );
      const raw = await fs.readFile(jsonPath, "utf-8");
      const pyReport = JSON.parse(raw) as PythonReportJson;

      assert.deepEqual(
        summary.statusCounts,
        pyReport.classifications.compliance_first_counts,
      );
      assert.deepEqual(summary.statusCounts, {
        FULLY_SERVABLE: 45,
        COMPLIANT_BUT_LATE: 44,
        ON_TIME_BUT_MISSING_SERVICES: 5,
        NO_ROUTE_IN_TIME: 1,
        UNREACHABLE: 5,
      });

      assert.equal(
        summary.compliantButLateWithOnTimeFallbackCount,
        pyReport.classifications.tradeoff_matrix_reachable_95
          .compliant_late_with_ontime_noncompliant_fallback,
      );
      assert.equal(summary.compliantButLateWithOnTimeFallbackCount, 35);
      assert.equal(
        summary.compliantButLateNoOnTimeCount,
        pyReport.classifications.tradeoff_matrix_reachable_95
          .compliant_late_no_ontime_route,
      );
      assert.equal(summary.compliantButLateNoOnTimeCount, 9);
      assert.equal(summary.autoProceedCount, 45);
      assert.equal(summary.needsHumanDecisionCount, 55);

      for (let i = 0; i < assessments.length; i += 1) {
        const tsLane = assessments[i]!;
        const pyLane = pyReport.lanes[i]!;

        assert.equal(tsLane.lane.laneNumber, pyLane.lane_id);
        assert.equal(tsLane.lane.origin, pyLane.origin);
        assert.equal(tsLane.lane.destination, pyLane.dest);
        assert.equal(tsLane.status, pyLane.category_compliance_first);

        assert.deepEqual(
          tsLane.routing.bestCompliantRoute?.airports ?? null,
          pyLane.best_compliant_route?.path ?? null,
        );
        assert.equal(
          tsLane.routing.bestCompliantRoute?.totalTransitDays ?? null,
          pyLane.best_compliant_route?.days ?? null,
        );

        assert.deepEqual(
          tsLane.routing.fastestUnconstrainedRoute?.airports ?? null,
          pyLane.fastest_unconstrained_route?.path ?? null,
        );
        assert.equal(
          tsLane.routing.fastestUnconstrainedRoute?.totalTransitDays ?? null,
          pyLane.fastest_unconstrained_route?.days ?? null,
        );

        if (tsLane.status === "FULLY_SERVABLE") {
          assert.equal(tsLane.needsHumanDecision, false);
          assert.equal(tsLane.daysOverLimit, 0);
          assert.equal(tsLane.recommendedAction, "AUTO_PROCEED_TO_PRICING");
        } else {
          assert.equal(tsLane.needsHumanDecision, true);
          assert.ok(Boolean(tsLane.humanDecisionReason));
        }
      }
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("forces human decision on a FULLY_SERVABLE lane when intake confidence is low", async () => {
    const dataset = await loadDatasetFromFile(WORKBOOK_PATH);
    const graph = buildFlightGraph(dataset.flights);
    const mexCdg = dataset.lanes.find((l) => l.laneCode === "MEX-CDG")!;

    const assessment = assessLane(mexCdg, graph, {
      requestedServices: ["DANGEROUS_GOODS"],
      evidence: [
        {
          service: "DANGEROUS_GOODS",
          quote: "dangerous-goods handling on every leg",
          matchedPattern: "manual_override",
        },
      ],
      standardCargoQuote: null,
      unmappedPhrases: ["dry ice"],
      warnings: [],
      confidence: 0.45,
      needsHumanReview: true,
      reviewReason: 'Unmapped special requirement phrase: "dry ice".',
    });

    assert.equal(assessment.status, "FULLY_SERVABLE");
    assert.equal(assessment.needsHumanDecision, true);
    assert.equal(assessment.recommendedAction, "RESOLVE_INTAKE_AMBIGUITY_FIRST");
    assert.ok(assessment.humanDecisionReason?.includes("dry ice"));
  });
});
