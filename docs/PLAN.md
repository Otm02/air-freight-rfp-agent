# Implementation Plan (`docs/PLAN.md`)

**Objective:** Build `air-freight-rfp-agent` incrementally in 6 testable phases, committing after each working milestone, keeping all unit/integration/E2E tests green, and strictly maintaining zero invented metrics.

---

## Phase 1: Project Scaffolding, Drizzle SQLite Schema & Seed

**Goal:** Stand up the Next.js + TypeScript + Tailwind + shadcn/ui application skeleton, Drizzle ORM schema over `@libsql/client`, and workbook seeder for the `100` directed flights and demo presets.

### Key Files
- `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `drizzle.config.ts`
- `src/db/schema.ts` — Drizzle definitions for all 9 tables (`flights`, `rfps`, `rfp_lanes`, `email_messages`, `review_items`, `deals`, `deal_lanes`, `kickoff_meetings`, `agent_events`) + indexes
- `src/db/index.ts` — `@libsql/client` singleton (`DATABASE_URL`, default `file:./data/rfp.db`) and SQLite PRAGMA setup (`foreign_keys = ON`, `journal_mode = WAL`)
- `src/lib/domain/types.ts` — canonical services tuple (`CANONICAL_SERVICES`), 5-bucket lane classification enum, disposition enums, Zod schemas
- `src/lib/workbook/loader.ts` — `exceljs` parser for `Shipper RFP` & `Transit Table`
- `src/db/seed.ts` — idempotent seed script loading the `100` directed flights + preset definition constants (`showcase-10` and `full-100`)

### Acceptance Criteria
- [ ] `pnpm typecheck` and `pnpm lint` exit `0` with `strict: true`.
- [ ] `pnpm db:push` (or Drizzle migration/init) + `pnpm db:seed` creates `data/rfp.db` cleanly on Windows/WSL without native build errors and inserts exactly `100` rows in `flights` across `20` airports.
- [ ] Health endpoint `GET /api/health` returns `{ ok: true, flightCount: 100, llmMode }`.
- [ ] Git commit created for Phase 1.

---

## Phase 2: Deterministic Core Engine (Routing, Compliance, Fallbacks & Pricing Math)

**Goal:** Implement the pure deterministic optimization, classification, partial-service Pareto search, and financial arithmetic library, proving exact `100/100` lane parity with `scripts/analyze-data.py`.

### Key Files
- `src/lib/routing/graph.ts` — adjacency list builder + Kosaraju Strongly Connected Components (`computeSCCs`)
- `src/lib/routing/dijkstra.ts` — exact shortest simple-path solver minimizing `(totalDays, hopCount, pathTuple)`
- `src/lib/routing/engine.ts` — `analyzeLane(...)` & `analyzeNetwork(...)` computing `bestCompliantRoute`, `fastestUnconstrainedRoute`, `partialOnTimeOptions`, and both `categoryComplianceFirst` / `categoryTimeFirst`
- `src/lib/pricing/math.ts` — deterministic `computeLineTotal`, `computeProposalTotal`, `estimateHeuristicRateBounds`, and `validatePricingBounds`
- `src/lib/quote/renderer.ts` — deterministic Markdown/HTML quote table builder (verified numeric lock) and RFC 5545 `.ics` generator (`src/lib/deal/ics.ts`)
- `tests/unit/routing-parity.test.ts` — Vitest suite running the TypeScript engine against `data/Air_Freight_RFP_Mock_Data.xlsx` and asserting exact parity with `scripts/analyze-data.py`

### Acceptance Criteria
- [ ] `routing-parity.test.ts` verifies all `100` lanes: `45` `FULLY_SERVABLE` (`16` 1-hop, `20` 2-hop, `6` 3-hop, `3` 4-hop), `44` `COMPLIANT_BUT_LATE` (`35` with on-time non-compliant fallback, `9` without), `5` `ON_TIME_BUT_MISSING_SERVICES`, `1` `NO_ROUTE_IN_TIME` (`DXB-HKG`), and `5` `UNREACHABLE` (`FAI-SIN`, `GRU-FAI`, `ANC-LHR`, `JFK-ANC`, `NRT-ANC`).
- [ ] All `4` spot checks pass in Vitest (`MEX-CDG` direct `11d`, `GRU-BOG` no compliant / `8d` Fragile only, `HKG-LAX` `12d` via `NRT-DFW`, `JFK-LAX` `4d` non-compliant direct / `18d` 4-hop compliant, and `HKG-MIA`'s two maximal partial options).
- [ ] Pricing arithmetic, `.ics` RFC 5545 formatting, and deterministic quote table rendering pass unit tests.
- [ ] Git commit created for Phase 2.

---

## Phase 3: LLM Gateway, Zod Schemas, Specialist Agents & Orchestrator

**Goal:** Build the dual-mode `LlmGateway` (`VercelAiProvider` for Gemini/OpenAI + `OfflineProvider`), all specialist agents, the HITL escalation logic, and the stateful `RfpOrchestrator`.

### Key Files
- `src/lib/llm/gateway.ts` — provider resolution (`GEMINI_API_KEY` -> `gemini-2.5-flash`, `OPENAI_API_KEY` -> `gpt-4o-mini`, else `OfflineProvider`), runtime `forceOffline` override, latency & token telemetry
- `src/lib/llm/offline-provider.ts` — rule-based shipper intake parser, heuristic mock Pricing email generator, regex/structured Pricing reply parser, deterministic quote prose formatter, keyword/intent customer reply classifier
- `src/lib/agents/intake-agent.ts`
- `src/lib/agents/pricing-agent.ts`
- `src/lib/agents/quote-agent.ts`
- `src/lib/agents/deal-agent.ts`
- `src/lib/events/bus.ts` — DB-persisted `agent_events` emitter + in-memory `EventEmitter`
- `src/lib/agents/orchestrator.ts` — RFP state machine enforcing HITL gates and transitions
- `tests/integration/orchestrator-offline.test.ts` — end-to-end server-side lifecycle test in Offline Mode (including low-confidence escalation, pricing anomaly escalation, counter-offer handling, and final SQL deal booking)

### Acceptance Criteria
- [ ] Intake Agent parses all `100` mock shipper emails with `0` unmapped phrases and flags intentional synthetic anomalies (e.g., `"keep upright on dry ice"`, O-D mismatch, low confidence) into `review_items`.
- [ ] Pricing Agent generates realistic unstructured mock replies, parses them back into Zod-validated rates, and raises `review_items` when a lane is omitted or a quoted rate falls outside `[$150, $25,000]/ton`.
- [ ] Quote Agent guarantees zero numeric alteration between SQL `rfp_lanes` and outgoing quote email body.
- [ ] Orchestrator integration test executes `INGESTED -> DEAL_BOOKED` cleanly against an isolated SQLite DB and passes in Vitest.
- [ ] Git commit created for Phase 3.

---

## Phase 4: Next.js API Routes & Live SSE Event Stream

**Goal:** Expose clean, Zod-validated REST Route Handlers and an SSE streaming endpoint with `Last-Event-ID` replay for real-time agent orchestration visibility.

### Key Files
- `src/app/api/health/route.ts`
- `src/app/api/flights/route.ts` — flight network & graph topology explorer endpoint
- `src/app/api/rfps/route.ts` & `src/app/api/rfps/[id]/route.ts` — create/import RFP (`showcase-10`, `full-100`, uploaded `.xlsx`, or custom JSON lanes), list RFPs, fetch full RFP state + lanes + emails + reviews + events
- `src/app/api/rfps/[id]/intake/route.ts` — trigger Intake + Routing
- `src/app/api/rfps/[id]/lanes/[laneId]/disposition/route.ts` & `.../lanes/bulk-disposition/route.ts` — resolve Gate #2 routing triage
- `src/app/api/rfps/[id]/pricing/request/route.ts` — preview/send Pricing Team email
- `src/app/api/rfps/[id]/pricing/reply/route.ts` — generate mock reply or submit user-edited unstructured Pricing reply + parse
- `src/app/api/rfps/[id]/quote/route.ts` — draft, edit prose, approve & send Customer Quote email
- `src/app/api/rfps/[id]/customer-reply/route.ts` — simulate or submit Customer reply + classify
- `src/app/api/rfps/[id]/deal/route.ts` & `src/app/api/rfps/[id]/kickoff.ics/route.ts` — commit Deal + Kickoff to SQL and export `.ics`
- `src/app/api/reviews/[reviewId]/resolve/route.ts` — resolve any Intake / Pricing / Negotiation `review_items` record
- `src/app/api/rfps/[id]/events/route.ts` — SSE stream (`Last-Event-ID` replay + live push + keepalive)
- `src/app/api/deals/route.ts` — query booked SQL `deals`, `deal_lanes`, and `kickoff_meetings`
- `tests/integration/api-routes.test.ts` — Vitest route-handler integration tests

### Acceptance Criteria
- [ ] All endpoints validate inputs with Zod, return structured `{ error, details }` on `4xx`, and enforce state-machine preconditions (`409 Conflict` if jumping past an unresolved HITL gate).
- [ ] SSE endpoint replays historical `agent_events` from `Last-Event-ID` and emits live chunks as orchestrator actions occur.
- [ ] All Vitest unit + API integration tests pass.
- [ ] Git commit created for Phase 4.

---

## Phase 5: Frontend UI Workspace, HITL Flows & Agent Orchestration Panel

**Goal:** Build an intuitive, data-dense logistics operations workbench with transparent HITL controls, email threads, network explorer, Deals Ledger, and live SSE Agent Orchestration drawer.

### Key Files
- `src/app/layout.tsx`, `src/app/page.tsx` — RFP Dashboard + Quick Launchers (`10-Lane Showcase`, `Full 100-Lane Workbook`, `Upload Custom RFP`) + Offline/Live LLM badge & toggle
- `src/app/rfps/[id]/page.tsx` — main 5-step RFP Workbench + persistent collapsible Agent Orchestration Drawer
- `src/app/deals/page.tsx` — SQL Deals & Kickoff Meetings explorer (showing committed `deals`, `deal_lanes`, and `.ics` download buttons)
- `src/app/network/page.tsx` — 20-airport / 100-flight Transit Table explorer & shortest-path tester
- `src/components/rfp/LaneTable.tsx` & `LaneDetailDrawer.tsx` — filterable by all 5 categories, displays leg-by-leg routes, SLA deltas, and service capability matrices
- `src/components/rfp/IntakeReviewPanel.tsx` (Gate #1)
- `src/components/rfp/RoutingTriagePanel.tsx` (Gate #2 — side-by-side compliant vs on-time vs partial options + manual path builder + bulk actions)
- `src/components/rfp/PricingThreadPanel.tsx` (Gate #3 — outbound email preview, mock/custom Pricing reply editor, extracted `$/ton` verification table)
- `src/components/rfp/QuoteAndDealPanel.tsx` (Gate #4 — locked deterministic quote preview, customer reply simulator/editor, kickoff scheduler & `.ics` download)
- `src/components/orchestration/AgentStreamDrawer.tsx` — real-time `EventSource` listener, step timeline, latency/provider badges, expandable JSON payload inspector

### Acceptance Criteria
- [ ] Every HITL checkpoint clearly highlights *why* human input is needed and blocks downstream send/commit actions until resolved.
- [ ] Agent Orchestration Panel updates live via SSE as Intake, Routing, Pricing, Quote, and Deal steps run, with inspectable JSON traces.
- [ ] Both `10-Lane Showcase` and `Full 100-Lane Workbook` render smoothly with instant category filtering.
- [ ] `pnpm build` succeeds cleanly with zero TypeScript or Next.js build errors.
- [ ] Git commit created for Phase 5.

---

## Phase 6: Playwright E2E Verification, Live Gemini Check, Polish & README

**Goal:** Prove end-to-end reliability in a real headless browser across happy paths, HITL escalations, and persistence, verify Live LLM mode (when `GEMINI_API_KEY` is present locally), and publish a metric-verified `README.md`.

### Key Files
- `playwright.config.ts`
- `tests/e2e/rfp-full-flow.spec.ts` — Playwright E2E test launching the Next.js server against an isolated test DB, importing the Showcase 10-Lane RFP, resolving Gate #1/#2/#3/#4, injecting a Pricing anomaly to prove HITL escalation, accepting the Quote, verifying the Agent Orchestration Panel events, confirming the Deal & Kickoff in `/deals`, and downloading `.ics`
- `tests/e2e/rfp-100-lanes-intake.spec.ts` — Playwright smoke test importing the full 100-lane workbook and asserting the `45 / 44 / 5 / 1 / 5` classification badges in the UI
- `README.md` — setup guide, architecture summary, verified metrics exclusively from `scripts/analyze-data.py` and actual test runs, Offline vs Live LLM instructions, screenshots/walkthrough for the Oliver Wyman technical Q&A

### Acceptance Criteria
- [ ] Full Vitest suite (`pnpm test`) passes `100%` green.
- [ ] Full Playwright E2E suite (`pnpm test:e2e`) passes `100%` green.
- [ ] Optional live smoke verification executed if `GEMINI_API_KEY` is configured in `.env.local` (without ever printing or committing the key).
- [ ] `README.md` contains zero unverified or estimated metrics, and `git status` shows a clean repository with small, descriptive commits.
- [ ] Final git commit created for Phase 6.
