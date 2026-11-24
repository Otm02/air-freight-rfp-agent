# Engineering Review (`docs/REVIEW.md`)

**Reviewer Role:** Senior Engineer (Oliver Wyman Data & Analytics Practice)
**Scope:** Full-repo line-by-line audit against the recruiter brief, architecture/code review, and clean-room fresh clone run following `README.md`.
**Baseline Commit Reviewed:** `ef56505` (`master`)

---

## 1. Recruiter Brief Compliance Audit

| Brief Requirement | Where in App | Where in README | Status & Gaps Found |
| :--- | :--- | :--- | :--- |
| Automate proposal development for custom air freight | Full pipeline on `/rfps/[id]` (`INTAKE` to `WON`) | Overview, Architecture, Flow sections | **Met.** Covers ingestion, routing, Pricing desk loop, quote approval, customer reply, and kickoff. |
| Parse shipper RFP table + raw email requirements (O-D, tons, max days, services) | Inbox `/` (**Email + Table**, **Upload .xlsx**, **Presets**), Drawer **Shipper Request & Evidence** | Quick Start + Brief Mapping Table | **Minor gap:** `CreateCustomSchema` in `POST /api/rfps` rejected `rawEmail < 3` chars with HTTP 400 instead of routing blank emails to Intake's `CONFIRM_REQUIREMENTS` gate like `.xlsx` uploads. |
| Evaluate how each O-D pair routes across Transit Table (sequence of flights) | **Lanes** table airport chips + **Lane Detail Drawer** (**Route Options**) | Responsibility Split + Brief Mapping | **Met (with bug in override helper):** Multi-hop constrained Dijkstra (`totalTransitDays`, `legCount`, tuple) finds 100/100 parity with Python. However, `decideLaneDisposition` allowed `QUOTE_COMPLIANT_LATE` to fall back to non-compliant `fastestAirports` if invoked directly on a non-compliant lane. |
| Compute quote (`$` price per ton) via internal Pricing flow | **Request Pricing from Desk**, **Human Tasks** (`CLARIFY_PRICING`), **Emails** Pricing thread | Pricing Agent section + Results | **Minor gap:** Automatic parser enforced `$500-$15,000/t` bounds, but `setManualLanePrice` and `ManualPriceSchema` accepted any `price > 0` (`$1/t` or `$99,999,999/t`). |
| Surface trade-offs and exceptions cleanly for RFP Response Team | Summary cards, filter tabs (`Needs Decision`, `Compliant (Late)`, etc.), `HumanTasksPanel`, header `Needs review` counter | Human-in-the-Loop Checkpoints | **Met (UX friction at 100 lanes):** Works smoothly on 6-10 lanes; on the full 100-lane workbook (`55` decisions needed), operators resolve one lane at a time without bulk triage controls. |
| Produce customer quote email with routing, SLA, fulfilled/missing services, `$/t`, and totals | **Proposal & Kickoff** tab, **Emails** Markdown/Plain-text toggle | Quote Assembly + Mapping Table | **Minor gap:** Code locks numeric tables deterministically, and LLM prompt forbids numbers in `greeting`/`summary`/`closing`, yet there was no deterministic regex/validator stripping leaked `$` or numeric claims if a misbehaving LLM ignored the prompt. |
| Gate sending on human sign-off | `AWAITING_APPROVAL` + `ApprovalGateError` (`409`) | Human-in-the-Loop Checkpoints #4 | **Met.** Hard backend check blocks send until approved and tasks closed/accepted. One consistency gap: `RfpWorkspaceClient` hardcoded `"alice.rfp@carrier.example"` for route/manual/follow-up actions instead of sharing the editable reviewer identity from `HumanTasksPanel`. |
| Mock customer reply -> Deal booking + `.ics` kickoff invite | **Customer Reply Simulator** in **Emails** tab, **Proposal & Kickoff** `.ics` card (`GET /api/rfps/[id]/kickoff.ics`) | Mapping Table + Results | **Met.** Handles Accept All, Partial, Question, Unclear, Reject, and offline French escalation safely; exports RFC 5545 `.ics` for next business day `10:00 ET`. |
| UI shows what agents do behind the scenes | Persistent right-hand **Activity Log** drawer (pipeline graph + SSE timeline + JSON I/O) | Architecture + Mapping Table | **Met.** Real-time SSE replay (`afterId` / `Last-Event-ID`) distinguishes `Code`, `LLM`, and `Human Gate` events cleanly. |
| Visual documentation accuracy | Screenshots in `docs/screenshots/` | Visual Walkthrough in `README.md` | **Stale after visual polish:** `docs/screenshots/*.png` still showed the older `slate` / `#1E3A5F` UI prior to commit `f24d190`. |

---

## 2. Fresh-Clone Walkthrough Findings (`/tmp/rfp-fresh-review`)

Executed verbatim against a fresh clone of commit `ef56505` inside WSL Ubuntu (`node v22.23.1`, Python 3.12 without `openpyxl` preinstalled):

1. `npm install`: **Passed** in `16s` (`398` packages, 0 peer failures).
2. `npm run lint`: **Passed** (`0` errors, `0` warnings).
3. `npm run typecheck`: **Passed** (`0` TS errors).
4. `npm run eval`: **Passed** (`100/100` intake exact match in `56ms`, `29/29` pricing exact match + `11/11` anomalies flagged).
5. `npm test`: **FAILED (1/61 failed, friction point).** `tests/domain/assessment.test.ts` shelled out to `python3 scripts/analyze-data.py` unconditionally and crashed with `ModuleNotFoundError: No module named 'openpyxl'` on a fresh machine that only ran `npm install`. TypeScript 100-lane classification counts were also tied inside the same subprocess block rather than asserted independently.
6. `npm run dev` on `:3199` (zero API keys, default `.env` absent): **Passed.** Booted in `1.4s`, auto-seeded 10-lane Showcase RFP #1 into SQLite, returned HTTP `200` on `/` (`AeroBid · Air Freight RFP Desk`, `Offline Mode`) and `/rfps/1` (`MEX-CDG`, `Activity Log` SSE panel).

---

## 3. Code Review: Top 10 Fixes (Ranked by Impact)

1. **Decouple TypeScript 100-lane assertions from optional Python `openpyxl` in `tests/domain/assessment.test.ts` (High / Correctness + DX):**
   Fresh clones running `npm install && npm test` failed without system `openpyxl`. Always assert exact 100-lane TypeScript counts (`45 / 44 / 5 / 1 / 5`), `35 / 9` trade-off breakdown, and spot-check routes natively in Node; skip only the external Python parity subprocess if `openpyxl` is absent while running full 100/100 cross-verification whenever `openpyxl` is present (Windows & CI).
2. **Enforce deterministic post-check blocking LLM numeric leaks in Quote prose (`src/agents/quote.ts`) (High / Core Invariant):**
   Standing invariant #1 prohibits LLM-generated numbers in customer quotes. Add `proseContainsProhibitedNumbers(prose)` checking `greeting`, `summary`, and `closing` for currency symbols (`$`, `USD`), per-unit markers (`/t`, `/kg`, `per ton`, `per kg`), or numeric figures; fall back to deterministic `fallbackProse` and log `QUOTE_PROSE_SANITIZED` to `agent_events` on violation.
3. **Harden API error mapping & `.xlsx` upload validation (`src/lib/api-helpers.ts`, `src/app/api/rfps/route.ts`, POST routes) (High / Security + HTTP Semantics):**
   Invalid JSON bodies previously fell into a catch-all returning raw messages, DB/system errors returned HTTP `400` instead of `500`, and multipart `.xlsx` uploads lacked file-size and ZIP magic-byte (`PK\x03\x04`) checks before ZIP inflation. Add `parseJsonBody()`, map system/SQLite/runtime errors to `500` (`"Internal server error."`), and cap uploads at `10 MB` with magic-byte validation.
4. **Apply `[$500, $15,000]/t` sanity bounds to manual pricing overrides (`src/orchestrator/engine.ts`, `src/app/api/rfps/[id]/pricing/manual/route.ts`) (Medium / Financial Safety):**
   `setManualLanePrice` allowed arbitrary positive numbers (`$1/t` or `$1,000,000/t`). Reuse `MIN_SANE_PRICE_PER_TON_USD` and `MAX_SANE_PRICE_PER_TON_USD` consistently on manual rate entry.
5. **Prevent silent non-compliant fallback in `decideLaneDisposition` (`src/orchestrator/engine.ts`) (Medium / Correctness Bug):**
   Passing `QUOTE_COMPLIANT` or `QUOTE_COMPLIANT_LATE` on a lane without `bestCompliantRoute` previously fell back to `fastestAirports` (non-compliant!), potentially labeling a non-compliant route as compliant. Reject explicitly when `bestCompliantAirports` is null.
6. **Allow empty `rawEmail` in `POST /api/rfps` custom mode (`src/app/api/rfps/route.ts`) (Low-Medium / API Consistency):**
   `.xlsx` ingestion cleanly converts empty emails into `CONFIRM_REQUIREMENTS` human tasks, whereas custom JSON API creation rejected `< 3` chars via Zod. Relaxing `rawEmail: z.string()` aligns both ingestion paths cleanly.
7. **Unify operator identity across client mutations (`src/components/RfpWorkspaceClient.tsx`, `src/components/HumanTasksPanel.tsx`) (Low-Medium / Audit Trail):**
   `RfpWorkspaceClient` hardcoded `"alice.rfp@carrier.example"` in route, manual pricing, and follow-up calls instead of sharing state with the editable operator input in `HumanTasksPanel`.
8. **Refresh `docs/screenshots/*.png` to match the zinc design overhaul (Low-Medium / Docs Accuracy):**
   Regenerate `02_workspace.png`, `04_human_tasks.png`, and `06_won_kickoff.png` from the built app so README screenshots match what reviewers see locally.
9. **Modularize `src/orchestrator/engine.ts` (2,508 lines) and push Inbox metrics into SQL aggregation (Future Refactor):**
   `engine.ts` combines seeding, intake, routing, pricing, quote, deal orchestration, and read-model projections (`listRfps` runs 6 whole-table queries in memory). Splitting into domain modules (`queries.ts`, `triage.ts`, `lifecycle.ts`) + SQL `GROUP BY` projections was deferred to avoid destabilizing tests late in the review window.
10. **Add bulk exception triage for the 100-lane workbook + run live Gemini/OpenAI eval with a funded key (Future Feature / Verification):**
    100-lane full-workbook runs generate `55` individual route tasks; adding batch "Decline all Unreachable" / "Quote all Late" controls plus live-key `eval:intake` benchmarking remains next-step work.

---

## 4. Fix Status Tracking

| # | Fix | Status | Notes |
| :-: | :--- | :--- | :--- |
| 1 | Decouple `assessment.test.ts` TS assertions from optional Python `openpyxl` | **Fixed** | Native TS 100-lane assertions always run; Python parity uses `t.skip` if `openpyxl` is absent |
| 2 | Guard quote prose against leaked LLM numbers/prices + log telemetry | **Fixed** | Added `proseContainsProhibitedNumbers` fallback + `QUOTE_PROSE_SANITIZED` event + unit test |
| 3 | Add `parseJsonBody`, `500` error sanitization, and 10 MB / ZIP header check | **Fixed** | Updated `src/lib/api-helpers.ts` and JSON route handlers + HTTP 400/500 edge-case tests |
| 4 | Enforce `[$500, $15,000]/t` sanity bounds on manual pricing overrides | **Fixed** | Enforced bounds in `setManualLanePrice` & `ManualPriceSchema` + orchestrator unit test |
| 5 | Disallow `QUOTE_COMPLIANT*` fallback to non-compliant routes | **Fixed** | Guarded `decideLaneDisposition` in `src/orchestrator/engine.ts` + unit test on `GRU-BOG` |
| 6 | Allow empty `rawEmail` on `POST /api/rfps` custom mode to reach HITL | **Fixed** | Relaxed `CreateCustomSchema.rawEmail` so empty text produces a human review task |
| 7 | Lift editable operator/reviewer identity across `RfpWorkspaceClient` & tasks | **Fixed** | Unified `reviewerEmail` state wired across decision, manual pricing, task approval, and quote send |
| 8 | Capture updated zinc UI screenshots in `docs/screenshots/` | **Fixed** | Re-captured `02_workspace.png`, `04_human_tasks.png`, and `06_won_kickoff.png` from built UI |
| 9 | Split `src/orchestrator/engine.ts` (2,508 lines) & SQL-aggregate `listRfps` | **Remaining** | Structural refactor deferred to keep the review diff surgical |
| 10 | Bulk 100-lane disposition controls + live-key eval benchmark | **Remaining** | Deferred (no active live Gemini/OpenAI quota available locally) |

## 5. Post-Fix Verification Results

Verified on the updated working tree before committing:
- `npm run check:secrets`: passed (`99` tracked files and full git history scanned, `0` findings)
- `npm run lint`: passed (`0` ESLint errors/warnings)
- `npm run typecheck`: passed (`tsc --noEmit`, `0` errors)
- `npm test` (Windows with `openpyxl`): `64/64` passed across `17` suites (`0` skipped)
- `npm run eval`: intake offline exact match `100/100` (`100.00%`, microP/microR `100.00%`, `0` human tasks, `66 ms`); pricing `29/29` clean exact matches, `11/11` anomalies flagged, `0` silent guesses, `0` false positives
- `LLM_PROVIDER=offline npm run build`: Next.js production build succeeded in `9.3 s` (`15` routes)
- `npm run e2e`: Playwright Chromium (`e2e/demo-rfp.spec.ts`) passed (`1` passed)
