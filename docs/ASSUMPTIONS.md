# Assumptions and Modeling Decisions

This document records each domain, routing, and engineering assumption alongside its rationale and reversibility. Quantitative figures come directly from running [`scripts/analyze-data.py`](../scripts/analyze-data.py) against [`data/Air_Freight_RFP_Mock_Data.xlsx`](../data/Air_Freight_RFP_Mock_Data.xlsx).

---

## 1. End-to-End Service Compliance

- **Assumption:** A route fulfills a lane's requested services if and only if every flight leg along the path supports every requested service:
  $$\bigcap_{e \in \text{legs}} \text{services}(e) \supseteq \text{requested\_services}$$
- **Rationale:** Every non-standard shipper email in `Shipper RFP` specifies end-to-end handling ("on every leg", "throughout", "for the whole trip"). Partial coverage on an intermediate hub breaks cold-chain custody or dangerous-goods certification.
- **Reversibility:** High. Isolated to the edge predicate inside `src/domain/routing.ts`.

## 2. Additive Transit Time with Zero Connection Buffer

- **Assumption:** Total transit days equal the integer sum of leg `transitDays` (`2-14` days per leg), with `0` days added at intermediate transfers.
- **Rationale:** Matches the brief and aligns with exact boundary lanes in the mock workbook (`MEX-CDG` direct = `11d` vs `11d` limit; `HKG-LAX` via `NRT-DFW` = `4 + 2 + 6 = 12d` vs `11d` limit).
- **Reversibility:** High. Adding a `connectionBufferDays` constant affects only edge cost accumulation in `src/domain/routing.ts`.

## 3. Simple Paths and Deterministic Tie-Breaking

- **Assumption:** Routes cannot repeat airports. Because every leg has strictly positive integer days (`>= 2`), Dijkstra finds globally optimal simple paths in $O(E \log V)$ minimizing `(totalTransitDays, legCount, airportTuple)`.
- **Rationale:** Strictly positive weights rule out negative cycles. Lexicographical tuple comparison ensures identical outputs across TypeScript, Python parity tests, and UI reruns.
- **Reversibility:** High. Isolated to `compareRoutes` in `src/domain/routing.ts`.

## 4. Compliance-First Precedence and the 35-Lane Trade-Off Overlap

- **Assumption:** Primary lane classification uses Compliance-First Precedence:
  1. `UNREACHABLE`: no directed path exists (`5` lanes touching `ANC`/`FAI`).
  2. `FULLY_SERVABLE`: compliant route exists with `totalTransitDays <= maxTransitDays` (`45` lanes: `16` 1-hop, `20` 2-hop, `6` 3-hop, `3` 4-hop).
  3. `COMPLIANT_BUT_LATE`: compliant route exists only above `maxTransitDays` (`44` lanes).
  4. `ON_TIME_BUT_MISSING_SERVICES`: no compliant route exists, but an unconstrained route fits `maxTransitDays` (`5` lanes: `GRU-BOG`, `HKG-MIA`, `LHR-FRA`, `GRU-MEX`, `GRU-FRA`).
  5. `NO_ROUTE_IN_TIME`: reachable, yet neither compliant nor on-time (`1` lane: `DXB-HKG`).
- **Overlap Nuance:** Out of the `44` `COMPLIANT_BUT_LATE` lanes, `35` also have a faster non-compliant option within `maxTransitDays` (e.g., `NRT-SIN`), while `9` have no on-time option at all (including `HKG-LAX` and `JFK-LAX`).
- **Decision:** Store and render both `bestCompliantRoute` and `fastestUnconstrainedRoute` (plus ranked `alternatives`) in the Lane Detail Drawer so commercial reps choose explicitly between late-compliant and on-time-partial offers.
- **Reversibility:** High. Recomputing display bucketing leaves persisted candidate routes intact.

## 5. Pareto-Maximal Partial-Service Alternatives

- **Assumption:** When a reachable lane is not `FULLY_SERVABLE`, the router searches non-empty subsets $S \subset \text{requested\_services}$ and keeps Pareto-maximal options fitting `maxTransitDays`, ranked by largest fulfilled service count, minimum transit days, minimum legs, and airport tuple.
- **Rationale:** On `HKG-MIA` (`TEMP_CONTROLLED` + `FRAGILE`, max `15d`), two incomparable 1-service options fit within deadline (`HKG -> DXB -> MIA` at `11d` Fragile only, and `HKG -> NRT -> DFW -> MIA` at `15d` Temp Controlled only). Showing both prevents losing an option arbitrarily.
- **Reversibility:** High. Post-processing over subset shortest paths in `src/domain/routing.ts`.

## 6. Commercial Dispositions Before Pricing

- **Assumption:** Every non-`FULLY_SERVABLE` lane starts in `PENDING_REVIEW` and requires a human decision before Pricing outreach:
  - `QUOTE_COMPLIANT_LATE`: quote the compliant route and disclose the delay.
  - `QUOTE_PARTIAL_ON_TIME`: quote a selected on-time partial route and list unfulfilled services.
  - `DECLINE`: exclude from Pricing and explain non-serviceability in the customer proposal.
- **Rationale:** An automated workflow must not silently drop a customer service constraint or bid an invalid SLA.
- **Reversibility:** High. Stored as an explicit enum + decision note on `lane_assessments`.

## 7. RFP Scoping and Pricing Batches

- **Assumption:** The UI supports three creation paths: a curated 10-lane Showcase RFP (covering all 5 categories, partial overlaps, and all 4 prompt spot checks), the full 100-lane mock workbook (`4,008.4` tons), and arbitrary `.xlsx` upload or custom email/table entry. Pricing outreach includes every approved non-declined lane.
- **Rationale:** Reviewers can test an end-to-end flow in seconds with 10 lanes or stress-test full 100-lane parsing and routing.
- **Reversibility:** High. All tables and orchestrator loops accept arbitrary lane counts.

## 8. In-App Email Ledger and Optional SMTP

- **Assumption:** Outbound and inbound Pricing and Customer correspondence live in the SQLite `emails` table (`direction`, `counterparty`, `body`, `plainTextBody`, `approvedBy`, `approvedAt`, `sentAt`), with optional real SMTP delivery only when `SMTP_*` env variables are set.
- **Rationale:** Avoids blocking local testing on SMTP/IMAP credentials while keeping structured extraction, approval gating, and outbox auditing identical to production mail handling.
- **Reversibility:** Medium. Plugging in an inbound email webhook calls the existing `parsePricingReply` and `handleCustomerReply` functions directly.

## 9. Kickoff Meeting Generation via RFC 5545 `.ics`

- **Assumption:** Accepted proposals schedule a kickoff meeting in `meetings` for the next business day at `10:00 America/New_York` (converting accurately across EST/EDT and skipping weekends) and serve an RFC 5545 `.ics` file from `GET /api/rfps/[id]/kickoff.ics`.
- **Rationale:** Produces a standards-compliant calendar invite usable across Outlook, Google Calendar, and Apple Calendar with zero OAuth setup.
- **Reversibility:** High. External calendar API sync can subscribe directly to `meetings` inserts.

## 10. Provider Resolution, Rate Limits, and Cost Guardrails

- **Assumption:** `LlmClient` resolves `LLM_PROVIDER` (`auto | gemini | openai | offline`) and API keys cleanly. Unset explicit overrides preserve `process.env.LLM_PROVIDER`. Live calls enforce a sliding 60-second `LLM_MAX_RPM` limit (default `30`) and cumulative `LLM_MAX_COST_USD_PER_RUN` cap (default `$0.50`), logging every call or limit event to `agent_events`.
- **Rationale:** Supports zero-key local evaluation while bounding API spend in unattended runs.
- **Reversibility:** High. Encapsulated in `src/llm/provider.ts`.

## 11. Fail-Closed Escalation Thresholds

- **Assumption:** Blocking `human_tasks` records are created whenever:
  - Intake confidence falls below `0.85`, rules and LLM disagree, an evidence quote is ungrounded, or uncatalogued handling (`dry ice`, `-20 C`, `live animals`) appears.
  - Pricing extraction omits any requested lane, detects multiple ambiguous numbers, produces an ungrounded quote, or yields rates outside `[$500, $15,000]` USD/ton.
  - Deal triage receives `QUESTION`, `UNCLEAR`, empty text, invalid JSON, or a French reply under Offline Mode.
- **Rationale:** Never convert missing data or model uncertainty into a silent numeric commitment.
- **Reversibility:** High. Bounds and thresholds live as exported constants in `src/domain/requirements.ts`, `src/agents/pricing.ts`, and `src/agents/deal.ts`.

## 12. Test Runner and Package Manager Compatibility on WSL UNC Mounts

- **Assumption:** Unit tests run directly via `node:test` + `tsx --test` (`npm test`), avoiding `vitest` and Windows `pnpm` symlink issues when opened over `\\wsl.localhost\...`. On Linux/macOS/WSL shells, both `npm` and `pnpm` scripts work identically.
- **Rationale:** Prevents platform-specific `ERR_PNPM_EISDIR` and `vite-node` UNC regex failures while keeping standard Node 22 tooling portable across CI (`ubuntu-latest`) and Windows sandboxes.
- **Reversibility:** High. Zero proprietary test lock-in.

## 13. Namespace-Aware `.xlsx` Parsing with `jszip` + `saxes`

- **Assumption:** Workbook reading (`src/domain/xlsx-reader.ts`) pairs `jszip` and `saxes` (`xmlns: true`) matching local XML names rather than using `exceljs`.
- **Rationale:** `Air_Freight_RFP_Mock_Data.xlsx` uses `x:`-prefixed SpreadsheetML elements and UTF-8 BOMs in `.rels`, where `exceljs@4.4.0` returns `undefined` on sheet parsing. Streaming local-name XML handles both prefixed and unprefixed workbooks with minimal dependencies.
- **Reversibility:** High. Isolated behind `readXlsxWorkbook`.

## 14. Singleton SQLite Connection and UNC Fallback

- **Assumption:** `src/db/index.ts` caches the database handle on `globalThis.__airFreightRfpDb` across Next.js hot reloads, defaulting to `DATABASE_URL` (`file:./data/rfp.db`) in Node/Linux and falling back to `:memory:` on Windows UNC shares (`\\...`) unless `FORCE_FILE_DB=1` is set.
- **Rationale:** Windows `@libsql/client` POSIX byte-range locks raise `SQLITE_BUSY` over WSL2 9p network mounts.
- **Reversibility:** High. Running inside native WSL Linux or Docker uses file-backed `rfp.db` automatically.
