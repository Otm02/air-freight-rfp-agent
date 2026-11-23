# Assumptions & Ambiguity Decisions

Per standing project rule #6, every domain or engineering ambiguity encountered during analysis and architecture design is documented explicitly below alongside the rationale and reversibility assessment. All quantitative figures cite direct output from `scripts/analyze-data.py` against `data/Air_Freight_RFP_Mock_Data.xlsx`.

---

## 1. Service-on-Every-Leg Compliance Rule

- **Assumption:** A route satisfies a lane's requested special requirements if and only if **every** flight leg along the route offers **all** requested special services:
  $$\bigcap_{e \in \text{legs}} \text{services}(e) \supseteq \text{requested\_services}$$
- **Rationale:** All 85 non-standard shipper emails in `Shipper RFP` explicitly use continuous/end-to-end phrasing (`"on every leg"`, `"throughout"`, `"including on connecting flights"`, `"for the whole trip"`, `"on all flights"`). Allowing partial coverage on intermediate legs would break cold-chain integrity, dangerous-goods certification, or security custody.
- **Reversibility:** High — isolated to a single edge filter predicate in `src/lib/routing/engine.ts`.

## 2. Additive Transit Time with Zero Connection Buffer

- **Assumption:** Total route transit time equals the exact integer sum of leg `transit_days` values from `Transit Table` (`2–14` days per leg), with `0` added days for intermediate airport connections.
- **Rationale:** Explicitly matches the brief specification and produces exact boundary cases observed in the dataset (e.g., `MEX-CDG` direct at `11` days vs `11`-day limit; `HKG-LAX` via `NRT` and `DFW` at `4 + 2 + 6 = 12` days vs `11`-day limit).
- **Reversibility:** High — a configurable `connectionBufferDays` parameter can be added to edge expansion without changing schema or UI contracts.

## 3. Simple Paths & Deterministic Tie-Breaking

- **Assumption:** Routes must be simple paths (no repeated airports). Since every directed flight has strictly positive integer transit time (`2–14` days), shortest paths are computed with Dijkstra minimizing the lexicographical tuple:
  `(total_days, hop_count, path_tuple)`
  where `path_tuple` compares IATA codes alphabetically (`("BOG", "GRU", "CDG")`).
- **Rationale:** Strict positivity eliminates negative cycles and guarantees Dijkstra finds globally optimal simple paths in $O(E \log V)$. Deterministic tie-breaking ensures identical results across runs, unit tests, Python parity checks, and TypeScript builds.
- **Reversibility:** High — encapsulated in the routing priority comparator.

## 4. Lane Classification Precedence & the 35-Lane Pareto Overlap

- **Assumption:** Primary lane classification uses **Compliance-First Precedence** matching the exact prompt order:
  1. `UNREACHABLE`: no directed path exists in the flight graph (`5` lanes — all touching the isolated `ANC`/`FAI` Alaska subnet).
  2. `FULLY_SERVABLE`: a fully compliant route exists with `total_days <= max_days` (`45` lanes: `16` 1-hop, `20` 2-hop, `6` 3-hop, `3` 4-hop).
  3. `COMPLIANT_BUT_LATE`: at least one fully compliant route exists, and all compliant routes exceed `max_days` (`44` lanes).
  4. `ON_TIME_BUT_MISSING_SERVICES`: no fully compliant route exists at any transit time, but at least one unconstrained route fits `max_days` (`5` lanes: `GRU-BOG`, `HKG-MIA`, `LHR-FRA`, `GRU-MEX`, `GRU-FRA`).
  5. `NO_ROUTE_IN_TIME`: no fully compliant route exists at any transit time **and** no unconstrained route fits `max_days` (`1` lane: `DXB-HKG`).
- **Key Nuance (35-Lane Trade-Off Overlap):** Among the `44` `COMPLIANT_BUT_LATE` lanes, `35` **also** have a faster non-compliant route within `max_days` (e.g., `GRU-SIN`, `NRT-SIN`, `ORD-AMS`), while `9` have no on-time route of any kind (including `HKG-LAX` and `JFK-LAX`). Under an alternative Time-First precedence, those `35` lanes would shift into `ON_TIME_BUT_MISSING_SERVICES` (`45 / 9 / 40 / 1 / 5`).
- **Design Decision:** Store and surface **both** `best_compliant_route` and `fastest_unconstrained_route` (plus `partial_on_time_options`) side-by-side in the Routing Review UI so the human RFP analyst can choose either trade-off regardless of primary bucket.
- **Reversibility:** High — both candidate routes are persisted per lane; changing display grouping does not invalidate routing data.

## 5. Partial-Service Fallback Ranking & Maximal Subsets

- **Assumption:** When a lane is not `FULLY_SERVABLE` and is reachable, the deterministic routing engine evaluates non-empty proper subsets $S \subset \text{requested\_services}$ (for multi-service lanes) and retains all **Pareto-maximal subsets** that fit within `max_days`, ordered by:
  1. Largest number of fulfilled services (`-len(fulfilled_services)`),
  2. Minimum `total_days`,
  3. Minimum `hop_count`,
  4. Lexicographical `path_tuple`.
- **Rationale:** On `HKG-MIA` (`Fragile handling` + `Temperature controlled (2-8 C)`, max `15` days), no route supports both services, but two incomparable maximal 1-service options fit within `15` days: `HKG -> DXB -> MIA` (`11` days, Fragile only) and `HKG -> NRT -> DFW -> MIA` (`15` days, Cold Chain only). Surfacing both lets the RFP Response Team pick which service to preserve.
- **Reversibility:** High — deterministic post-processing over existing subset shortest paths.

## 6. Commercial Lane Dispositions at HITL Routing Review

- **Assumption:** Every non-`FULLY_SERVABLE` lane requires an explicit human disposition before entering Pricing outreach:
  - `FULLY_SERVABLE` lanes default to `QUOTE_COMPLIANT` (editable to override or decline).
  - Non-servable lanes default to `PENDING_REVIEW` and can be resolved by the RFP analyst as:
    - `QUOTE_COMPLIANT_LATE` (quote the compliant route and clearly disclose the transit overrun in the proposal),
    - `QUOTE_PARTIAL_ON_TIME` (quote an on-time partial/non-compliant route and clearly disclose unfulfilled requirements),
    - `MANUAL_OVERRIDE` (analyst selects or enters a custom simple path verified against `flights`), or
    - `DECLINE` (exclude from Pricing RFP email and explain non-serviceability in the customer proposal, mandatory default for `UNREACHABLE` lanes unless network changes).
- **Rationale:** Pricing quotes and customer proposals are commercial commitments; an AI agent must never silently drop a cold-chain requirement or commit to a late delivery SLA.
- **Reversibility:** High — stored as an explicit enum + audit reason on `rfp_lanes`.

## 7. RFP Scoping & Pricing Email Batching

- **Assumption:** While the mock workbook contains `100` lanes (`4,008.4` total tons across `20` airports), evaluating all `100` lanes simultaneously in one interactive browser demo can overwhelm reviewers, whereas restricting only to a small sample would hide full-workbook correctness. Therefore, the app supports **three import modes**:
  1. **Curated 10-Lane Showcase RFP** (deterministic subset drawn verbatim from `Air_Freight_RFP_Mock_Data.xlsx` covering all `5` classification categories, the 35-lane trade-off sub-bucket, multi-service partial options, and all `4` prompt spot checks: `MEX-CDG`, `GRU-BOG`, `HKG-LAX`, `JFK-LAX`, plus `FAI-SIN`, `DXB-HKG`, `HKG-MIA`, `NRT-SIN`, `DFW-MEX`, `JFK-DXB`).
  2. **Full 100-Lane Mock Workbook** (imports every row from `data/Air_Freight_RFP_Mock_Data.xlsx`).
  3. **Custom / Uploaded `.xlsx` or Raw Lane Entry** (allows an Oliver Wyman reviewer to test arbitrary spreadsheets or unstructured shipper emails live).
- **Pricing Email Batching:** Outgoing Pricing Team requests batch all approved quotable lanes for an RFP into a single structured request (or split cleanly by batch if `> 25` lanes so LLM/parser prompts remain bounded and reliable), keyed by canonical `ORIGIN-DEST` lane code.
- **Reversibility:** High — `rfp_lanes` supports arbitrary lane counts per `rfp_id`.

## 8. Simulated Email Transport & Editable Inboxes

- **Assumption:** Outgoing and incoming emails (Pricing Team requests/replies and Customer Quote/replies) are stored and rendered inside a first-class SQL `email_messages` table rather than requiring SMTP/IMAP credentials. To allow testing arbitrary unstructured prose alongside realistic demos, incoming replies from Pricing and the Customer can be **either** auto-generated by the active LLM (or offline templates) **or** edited/pasted directly as raw text by the user before running the extraction/classification agent.
- **Rationale:** Avoids external mail server setup and credential friction during local evaluation while genuinely exercising unstructured email generation, parsing, schema validation, and failure-to-HITL escalation.
- **Reversibility:** Medium — an SMTP/Resend adapter can be plugged behind the `EmailTransport` interface later without changing database or UI flows.

## 9. Kickoff Meeting Scheduling via SQL + `.ics` Export

- **Assumption:** When a customer accepts a proposal, the Deal Agent proposes kickoff meeting details (date/time, UTC window, attendees, agenda summarizing accepted lanes) and—once confirmed by the human operator—persists a `kickoff_meetings` record in SQLite and generates a downloadable RFC 5545 `.ics` calendar invite (`GET /api/rfps/[id]/kickoff.ics`). No Google Calendar or Microsoft Graph OAuth login is required.
- **Rationale:** Keeps the application self-contained, testable end-to-end in Playwright, and zero-setup for reviewers while still producing a real, openable calendar artifact.
- **Reversibility:** High — an external calendar API adapter can subscribe to the confirmed `kickoff_meetings` record.

## 10. LLM Provider Resolution & Deterministic Offline Mode

- **Assumption:** Provider selection is resolved server-side at request time via `LLM_PROVIDER` (default `auto`) and environment keys:
  - If `LLM_PROVIDER=offline` **or** no API key is configured -> `OfflineProvider` (deterministic rule-based email parser, deterministic heuristic mock Pricing reply generator, templated prose renderer, deterministic reply sentiment classifier).
  - Else if `GEMINI_API_KEY` is non-empty (and `LLM_PROVIDER` is `auto` or `gemini`) -> Gemini (`gemini-2.5-flash`) via `@ai-sdk/google`.
  - Else if `OPENAI_API_KEY` is non-empty (and `LLM_PROVIDER` is `auto` or `openai`) -> OpenAI (`gpt-4o-mini`) via `@ai-sdk/openai`.
  - UI exposes an explicit **"Offline Mode / Live LLM"** session toggle (when a key is present) so a reviewer can verify both paths side-by-side without restarting the server.
- **Rationale:** Satisfies Standing Rule #3 ("must run fully without any API key") and Vercel AI SDK with Gemini default while supporting OpenAI fallback.
- **Reversibility:** High — encapsulated behind the `LlmGateway` interface.

## 11. Schema Validation, Confidence Thresholds & HITL Escalation

- **Assumption:** Every LLM call uses `generateObject` against a strict Zod schema (`zod`). Validation fails and creates a blocking `review_items` checkpoint whenever **any** of the following holds:
  1. Zod schema validation fails or JSON parsing fails after 1 retry;
  2. Reported extraction `confidence < 0.85`;
  3. Intake Agent extracts an airport pair that contradicts the tabular `Origin`/`Destination` columns, or detects an unrecognized special-service phrase (`unmapped_phrases.length > 0`);
  4. Pricing Parser omits a requested quotable lane, returns non-positive/NaN rates, or returns a rate outside deterministic sanity bounds (`< $150/ton` or `> $25,000/ton`);
  5. Deal Agent classifies customer sentiment as `COUNTER_OFFER` or `AMBIGUOUS` (or `ACCEPT` with `confidence < 0.85`).
- **Rationale:** Enforces Standing Rule #2 ("never a silent guess") and ensures every ambiguous or malformed model response becomes an explicit, auditable human decision card.
- **Reversibility:** High — thresholds (`CONFIDENCE_THRESHOLD = 0.85`, pricing bounds) live in `src/lib/config/thresholds.ts`.


## 12. Package Manager & Unit Test Runner on WSL UNC Paths

- **Assumption:** The project uses `npm` (`package-lock.json`) with `--script-shell=powershell.exe` on Windows hosts and Node 22's built-in `node:test` + `node:assert/strict` executed via `tsx --test` for unit and integration tests (while reserving Playwright for browser E2E testing in Phase 6).
- **Rationale:** On Windows workspaces stored inside WSL (`\\wsl.localhost\Ubuntu-24.04\...`), Windows `pnpm` fails with UNC symlink (`ERR_PNPM_EISDIR`) and `copy_on_write` volume-info panics, default `npm` lifecycle scripts fail because `cmd.exe` rejects UNC working directories, and `vitest` (`vite-node/dist/utils.mjs` + `pathe`) throws a startup regex/path crash when `process.cwd()[0]` is `"\\"`. Node 22 `node:test` + `tsx --test` and `npm --script-shell=powershell.exe` operate natively across WSL UNC, Windows NTFS, Linux, and macOS without native path-rewriting workarounds.
- **Reversibility:** High — standard `node:test` assertions have zero proprietary lock-in and remain portable across any Node 20+ runtime.


## 13. Namespace-Aware `.xlsx` Parsing with `jszip` + `saxes`

- **Assumption:** Excel workbook reading in `src/domain/xlsx-reader.ts` uses `jszip` + `saxes` (`SaxesParser({ xmlns: true })`) matching elements/attributes by local XML name rather than `exceljs`.
- **Rationale:** `data/Air_Freight_RFP_Mock_Data.xlsx` uses namespace-prefixed SpreadsheetML tags (`<x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`, `<x:worksheet>`, `<x:c t="str"><x:v>...</x:v></x:c>`) and UTF-8 BOMs in `.rels`, which cause `exceljs@4.4.0` to return `undefined` from `parseWorkbook` (`Cannot read properties of undefined (reading 'sheets')`). A lightweight `jszip` + `saxes` parser handles both `x:`-prefixed (ClosedXML/OpenXML SDK) and unprefixed `.xlsx` workbooks, supports shared strings, inline strings, formula strings (`t="str"`), and sparse column refs, eliminates `exceljs`'s deprecated/vulnerable transitive dependencies, and parses workbooks in milliseconds.
- **Reversibility:** High — `src/domain/loader.ts` isolates workbook extraction behind `readXlsxWorkbook`, leaving all validation and `LoadedDataset` contracts unchanged.

## 14. Next.js Singleton SQLite Connection & WSL UNC Fallback

- **Assumption:** `src/db/index.ts` pins `getDefaultDatabase()` on `globalThis.__airFreightRfpDb` across Next.js App Router hot reloads and resolves to `:memory:` when `process.cwd()` starts with `\\` (Windows UNC 9p share into WSL2) unless `FORCE_FILE_DB=1` is set; on native Linux/macOS or Windows local drives, it uses `DATABASE_URL` (`file:./data/rfp.db` by default).
- **Rationale:** Windows `@libsql/client` SQLite POSIX byte-range locking raises `SQLITE_BUSY` on Plan9 (`\\wsl.localhost\...`) UNC shares. Pinning the singleton on `globalThis` guarantees consistent shared SQLite state across Route Handlers, Server Components, and SSE connections in both UNC `:memory:` mode and local `file:./data/rfp.db` mode.
- **Reversibility:** High — `FORCE_FILE_DB=1` or running Node inside WSL Linux natively restores file-backed `data/rfp.db` with zero code changes.
