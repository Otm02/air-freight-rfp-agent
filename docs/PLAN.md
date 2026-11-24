# Implementation Plan (`docs/PLAN.md`)

> Historical milestone plan used while building `air-freight-rfp-agent`. For the final implemented structure, 11-table SQLite schema, and test commands (`tsx --test` + Playwright), see [`README.md`](../README.md) and [`docs/DESIGN.md`](DESIGN.md).

**Objective:** Build `air-freight-rfp-agent` incrementally across six phases with passing unit, integration, parity, and E2E verification at each checkpoint.

---

## Phase 1: Project Scaffolding, Drizzle SQLite Schema, and Workbook Loading

**Goal:** Initialize the Next.js + TypeScript + Tailwind application, Drizzle schema over `@libsql/client`, and `.xlsx` reader for the 100-flight transit network and shipper tenders.

- `package.json`, `tsconfig.json`, `next.config.ts`, `drizzle.config.ts`
- `src/db/schema.ts`: Drizzle schema definitions and relational indexes
- `src/db/index.ts` and `src/db/migrate.ts`: `@libsql/client` singleton, idempotent DDL bootstrap, and WAL/FK pragmas
- `src/domain/types.ts`: canonical service enum (`SERVICE_TYPES`), 5-bucket classification enum, and loader types
- `src/domain/xlsx-reader.ts` and `src/domain/loader.ts`: OOXML workbook reader and input validator

## Phase 2: Deterministic Domain Core

**Goal:** Build the constraint-aware graph routing engine, rule-based requirement parser, and 5-bucket assessment logic with `100/100` parity against `scripts/analyze-data.py`.

- `src/domain/requirements.ts`: rule-based requirement extraction with verbatim quote grounding, negation guards, and confidence scoring (`data/gold_requirements.json`)
- `src/domain/routing.ts`: constrained Dijkstra shortest simple-path solver (`totalTransitDays`, `legCount`, `airportTuple`) plus Pareto-maximal partial-service fallback search
- `src/domain/assessment.ts`: lane classification across `FULLY_SERVABLE`, `COMPLIANT_BUT_LATE`, `ON_TIME_BUT_MISSING_SERVICES`, `NO_ROUTE_IN_TIME`, and `UNREACHABLE`
- `tests/domain/`: unit tests and Python parity check verifying exact counts (`45 / 44 / 5 / 1 / 5`) and prompt spot checks

## Phase 3: LLM Layer, Intake Agent, and Pricing Loop

**Goal:** Implement the `LlmClient` abstraction (Gemini default, OpenAI fallback, Offline deterministic parity, RPM and USD caps), dual-reading Intake agent, isolated Mock Pricing Team, and Pricing parser.

- `src/llm/`: provider resolution, Zod structured output, 1-retry JSON/schema recovery, request timeouts, rate/cost guardrails, and `agent_events` persistence
- `src/agents/intake.ts`: LLM + rule merge escalating disagreements, ungrounded quotes, or low confidence into `CONFIRM_REQUIREMENTS` human tasks
- `src/pricing/mock-pricing-team.ts`: transparent pricing model with mixed `$/t`, `USD/t`, and `/kg` formats plus intentional missing and ambiguous cases
- `src/agents/pricing.ts`: outbound Pricing request formatting, `/kg` -> `/ton` normalization, range checks, and `CLARIFY_PRICING` clarification loop
- `scripts/eval-intake.ts` and `scripts/eval-pricing.ts`: reproducible evaluation reports (`out/eval_intake.md`, `out/eval_pricing.md`)

## Phase 4: Quote Assembly, Approval Gate, Deal Agent, and Kickoff `.ics`

**Goal:** Generate customer quotes with deterministic lane tables, enforce human approval before send, classify replies, book accepted deals, and generate RFC 5545 kickoff invites.

- `src/agents/quote.ts` and `src/lib/email/smtp.ts`: code-rendered Markdown + plain-text quotes, `ApprovalGateError` enforcement, outbox persistence, and optional SMTP dispatch
- `src/agents/deal.ts`, `src/deal/mock-customer.ts`, and `src/deal/ics.ts`: customer reply triage (including English/French handling), SQL deal booking, and next-business-day `10:00 America/New_York` `.ics` export

## Phase 5: Orchestrator, API Routes, SSE Stream, and Workbench UI

**Goal:** Wire the per-RFP state machine, HTTP endpoints, SSE trace stream, and React UI across Inbox, Lanes, Lane Detail Drawer, Human Tasks Queue, Emails, Proposal & Kickoff, and Activity Log.

- `src/orchestrator/`: state machine transitions, event bus (`afterId` replay), and 10-lane Showcase auto-seeder
- `src/app/api/rfps/**`: validated Next.js route handlers for ingestion, triage decisions, pricing resolution, quote approval, customer replies, SSE streaming, and `.ics` download
- `src/components/`: UI workbench with explicit human review gates at every commercial boundary

## Phase 6: Edge Cases, Playwright E2E, CI, Docker, and Polish

**Goal:** Harden security and edge cases, add automated browser E2E and GitHub Actions CI, package with Docker, and refine UI design and documentation for reviewer clarity.

- `scripts/check-secrets.ts`, `tests/edge-cases/edge-cases.test.ts`, and `e2e/demo-rfp.spec.ts`
- `.github/workflows/ci.yml`, `Dockerfile`, `.dockerignore`, and `README.md`
