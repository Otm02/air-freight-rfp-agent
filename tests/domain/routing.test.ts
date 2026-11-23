import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadDatasetFromFile } from "../../src/domain/loader";
import {
  buildFlightGraph,
  computeServiceGaps,
  findShortestPath,
  routeLane,
} from "../../src/domain/routing";
import type { Flight } from "../../src/domain/types";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const WORKBOOK_PATH = path.resolve(
  REPO_ROOT,
  "data/Air_Freight_RFP_Mock_Data.xlsx",
);

function makeFlight(
  flightNumber: number,
  origin: string,
  destination: string,
  transitDays: number,
  availableServices: Flight["availableServices"],
): Flight {
  return { flightNumber, origin, destination, transitDays, availableServices };
}

describe("routing engine on synthetic graphs", () => {
  it("filters out flights missing required services while also reporting fastest unconstrained route", () => {
    const graph = buildFlightGraph([
      makeFlight(1, "JFK", "LHR", 2, ["FRAGILE"]),
      makeFlight(2, "JFK", "ORD", 2, ["DANGEROUS_GOODS"]),
      makeFlight(3, "ORD", "LHR", 3, ["DANGEROUS_GOODS", "FRAGILE"]),
    ]);

    const res = routeLane(graph, {
      origin: "JFK",
      destination: "LHR",
      requiredServices: ["DANGEROUS_GOODS"],
      maxTransitDays: 6,
    });

    assert.deepEqual(res.bestCompliantRoute?.airports, ["JFK", "ORD", "LHR"]);
    assert.equal(res.bestCompliantRoute?.totalTransitDays, 5);
    assert.deepEqual(res.fastestUnconstrainedRoute?.airports, ["JFK", "LHR"]);
    assert.equal(res.fastestUnconstrainedRoute?.totalTransitDays, 2);
    assert.deepEqual(res.alternatives, []);
  });

  it("tie-breaks equal total transit days on fewer legs, then alphabetically", () => {
    const graph = buildFlightGraph([
      makeFlight(1, "AAA", "BBB", 3, ["OVERSIZED"]),
      makeFlight(2, "BBB", "CCC", 3, ["OVERSIZED"]),
      makeFlight(3, "CCC", "ZZZ", 4, ["OVERSIZED"]),
      makeFlight(4, "AAA", "EEE", 5, ["OVERSIZED"]),
      makeFlight(5, "EEE", "ZZZ", 5, ["OVERSIZED"]),
      makeFlight(6, "AAA", "DDD", 4, ["OVERSIZED"]),
      makeFlight(7, "DDD", "ZZZ", 6, ["OVERSIZED"]),
    ]);

    const best = findShortestPath(graph, "AAA", "ZZZ", ["OVERSIZED"]);
    assert.equal(best?.totalTransitDays, 10);
    assert.equal(best?.legCount, 2);
    assert.deepEqual(best?.airports, ["AAA", "DDD", "ZZZ"]);
  });

  it("handles unreachable destinations cleanly", () => {
    const graph = buildFlightGraph([
      makeFlight(1, "ANC", "FAI", 7, ["DANGEROUS_GOODS"]),
      makeFlight(2, "JFK", "LAX", 4, ["DANGEROUS_GOODS"]),
    ]);

    const res = routeLane(graph, {
      origin: "ANC",
      destination: "LAX",
      requiredServices: ["DANGEROUS_GOODS"],
      maxTransitDays: 20,
    });

    assert.equal(res.bestCompliantRoute, null);
    assert.equal(res.fastestUnconstrainedRoute, null);
    assert.deepEqual(res.alternatives, []);
  });

  it("surfaces partial-service alternatives with per-leg missing services", () => {
    const graph = buildFlightGraph([
      makeFlight(1, "AAA", "BBB", 3, ["FRAGILE"]),
      makeFlight(2, "BBB", "ZZZ", 3, ["FRAGILE"]),
      makeFlight(3, "AAA", "CCC", 4, ["TEMP_CONTROLLED"]),
      makeFlight(4, "CCC", "ZZZ", 4, ["TEMP_CONTROLLED", "FRAGILE"]),
    ]);

    const res = routeLane(graph, {
      origin: "AAA",
      destination: "ZZZ",
      requiredServices: ["TEMP_CONTROLLED", "FRAGILE"],
      maxTransitDays: 8,
    });

    assert.equal(res.bestCompliantRoute, null);
    assert.equal(res.alternatives.length, 2);

    const first = res.alternatives[0]!;
    assert.equal(first.kind, "ON_TIME_MOST_SERVICES");
    assert.deepEqual(first.route.airports, ["AAA", "BBB", "ZZZ"]);
    assert.deepEqual(first.fulfilledServices, ["FRAGILE"]);
    assert.deepEqual(first.missingServices, ["TEMP_CONTROLLED"]);

    const second = res.alternatives[1]!;
    assert.equal(second.kind, "ON_TIME_PARTIAL_SUBSET");
    assert.deepEqual(second.route.airports, ["AAA", "CCC", "ZZZ"]);
    assert.deepEqual(second.fulfilledServices, ["TEMP_CONTROLLED"]);
    assert.deepEqual(second.missingServices, ["FRAGILE"]);
    assert.deepEqual(
      second.serviceGaps.find((g) => g.service === "FRAGILE")?.missingOnLegs,
      ["AAA->CCC"],
    );
  });

  it("computes exact leg service gaps for an arbitrary route", () => {
    const route = {
      airports: ["A", "B", "C"],
      legs: [
        makeFlight(1, "A", "B", 2, ["FRAGILE"]),
        makeFlight(2, "B", "C", 3, ["TEMP_CONTROLLED"]),
      ],
      totalTransitDays: 5,
      legCount: 2,
      commonServices: [],
    };
    const gaps = computeServiceGaps(route, ["TEMP_CONTROLLED", "FRAGILE"]);
    assert.deepEqual(gaps, [
      {
        service: "TEMP_CONTROLLED",
        fulfilled: false,
        missingOnLegs: ["A->B"],
      },
      {
        service: "FRAGILE",
        fulfilled: false,
        missingOnLegs: ["B->C"],
      },
    ]);
  });
});

describe("routing engine on Air_Freight_RFP_Mock_Data.xlsx", () => {
  it("resolves real equal-day tie-breaks in favor of fewer legs", async () => {
    const dataset = await loadDatasetFromFile(WORKBOOK_PATH);
    const graph = buildFlightGraph(dataset.flights);

    const lhrAtl = findShortestPath(graph, "LHR", "ATL", ["TEMP_CONTROLLED"]);
    assert.equal(lhrAtl?.totalTransitDays, 21);
    assert.equal(lhrAtl?.legCount, 2);
    assert.deepEqual(lhrAtl?.airports, ["LHR", "ORD", "ATL"]);

    const lhrYyz = findShortestPath(graph, "LHR", "YYZ", ["FRAGILE"]);
    assert.equal(lhrYyz?.totalTransitDays, 25);
    assert.equal(lhrYyz?.legCount, 4);
    assert.deepEqual(lhrYyz?.airports, ["LHR", "ORD", "JFK", "LAX", "YYZ"]);

    const miaFra = findShortestPath(graph, "MIA", "FRA", ["FRAGILE"]);
    assert.equal(miaFra?.totalTransitDays, 27);
    assert.equal(miaFra?.legCount, 3);
    assert.deepEqual(miaFra?.airports, ["MIA", "NRT", "JFK", "FRA"]);

    const atlHkg = findShortestPath(graph, "ATL", "HKG", ["TEMP_CONTROLLED"]);
    assert.equal(atlHkg?.totalTransitDays, 32);
    assert.equal(atlHkg?.legCount, 4);
    assert.deepEqual(atlHkg?.airports, ["ATL", "BOG", "AMS", "FRA", "HKG"]);
  });

  it("verifies all 5 unreachable ANC/FAI lanes and all Prompt 0 spot checks", async () => {
    const dataset = await loadDatasetFromFile(WORKBOOK_PATH);
    const graph = buildFlightGraph(dataset.flights);

    for (const laneCode of [
      "FAI-SIN",
      "GRU-FAI",
      "ANC-LHR",
      "JFK-ANC",
      "NRT-ANC",
    ]) {
      const [origin, destination] = laneCode.split("-") as [string, string];
      const res = routeLane(graph, {
        origin,
        destination,
        requiredServices: [],
        maxTransitDays: 20,
      });
      assert.equal(res.bestCompliantRoute, null);
      assert.equal(res.fastestUnconstrainedRoute, null);
      assert.deepEqual(res.alternatives, []);
    }

    const mexCdg = routeLane(graph, {
      origin: "MEX",
      destination: "CDG",
      requiredServices: ["DANGEROUS_GOODS"],
      maxTransitDays: 11,
    });
    assert.deepEqual(mexCdg.bestCompliantRoute?.airports, ["MEX", "CDG"]);
    assert.equal(mexCdg.bestCompliantRoute?.totalTransitDays, 11);
    assert.deepEqual(mexCdg.fastestUnconstrainedRoute?.airports, [
      "MEX",
      "LHR",
      "CDG",
    ]);
    assert.equal(mexCdg.fastestUnconstrainedRoute?.totalTransitDays, 10);
    assert.deepEqual(mexCdg.alternatives, []);

    const gruBog = routeLane(graph, {
      origin: "GRU",
      destination: "BOG",
      requiredServices: ["TEMP_CONTROLLED", "FRAGILE"],
      maxTransitDays: 12,
    });
    assert.equal(gruBog.bestCompliantRoute, null);
    assert.deepEqual(gruBog.fastestUnconstrainedRoute?.airports, [
      "GRU",
      "BOG",
    ]);
    assert.equal(gruBog.fastestUnconstrainedRoute?.totalTransitDays, 8);
    assert.deepEqual(gruBog.alternatives[0]?.missingServices, [
      "TEMP_CONTROLLED",
    ]);
    assert.deepEqual(
      gruBog.alternatives[0]?.serviceGaps.find(
        (g) => g.service === "TEMP_CONTROLLED",
      )?.missingOnLegs,
      ["GRU->BOG"],
    );

    const hkgLax = routeLane(graph, {
      origin: "HKG",
      destination: "LAX",
      requiredServices: ["TEMP_CONTROLLED"],
      maxTransitDays: 11,
    });
    assert.deepEqual(hkgLax.bestCompliantRoute?.airports, [
      "HKG",
      "NRT",
      "DFW",
      "LAX",
    ]);
    assert.equal(hkgLax.bestCompliantRoute?.totalTransitDays, 12);
    assert.equal(hkgLax.alternatives[0]?.daysOverLimit, 1);

    const jfkLax = routeLane(graph, {
      origin: "JFK",
      destination: "LAX",
      requiredServices: ["DANGEROUS_GOODS"],
      maxTransitDays: 3,
    });
    assert.deepEqual(jfkLax.bestCompliantRoute?.airports, [
      "JFK",
      "NRT",
      "BOG",
      "GRU",
      "LAX",
    ]);
    assert.equal(jfkLax.bestCompliantRoute?.totalTransitDays, 18);
    assert.deepEqual(jfkLax.fastestUnconstrainedRoute?.airports, [
      "JFK",
      "LAX",
    ]);
    assert.equal(jfkLax.fastestUnconstrainedRoute?.totalTransitDays, 4);
    assert.equal(jfkLax.alternatives.length, 2);

    const hkgMia = routeLane(graph, {
      origin: "HKG",
      destination: "MIA",
      requiredServices: ["TEMP_CONTROLLED", "FRAGILE"],
      maxTransitDays: 15,
    });
    assert.equal(hkgMia.bestCompliantRoute, null);
    assert.equal(hkgMia.alternatives.length, 2);
    assert.deepEqual(
      hkgMia.alternatives.map((a) => a.route.airports),
      [
        ["HKG", "DXB", "MIA"],
        ["HKG", "NRT", "DFW", "MIA"],
      ],
    );

    const dxbHkg = routeLane(graph, {
      origin: "DXB",
      destination: "HKG",
      requiredServices: ["TEMP_CONTROLLED", "HIGH_VALUE_SECURITY"],
      maxTransitDays: 14,
    });
    assert.equal(dxbHkg.bestCompliantRoute, null);
    assert.deepEqual(dxbHkg.fastestUnconstrainedRoute?.airports, [
      "DXB",
      "MIA",
      "NRT",
      "HKG",
    ]);
    assert.equal(dxbHkg.fastestUnconstrainedRoute?.totalTransitDays, 15);
    assert.deepEqual(
      dxbHkg.alternatives.map((a) => a.kind),
      ["LATE_MOST_SERVICES", "FASTEST_UNCONSTRAINED"],
    );
    assert.deepEqual(dxbHkg.alternatives[0]?.route.airports, [
      "DXB",
      "AMS",
      "FRA",
      "HKG",
    ]);
    assert.equal(dxbHkg.alternatives[0]?.route.totalTransitDays, 19);
  });
});
