import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const rfps = sqliteTable("rfps", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  sourceType: text("source_type").notNull(),
  status: text("status").notNull(),
  llmProvider: text("llm_provider").notNull(),
  customerName: text("customer_name").notNull(),
  customerEmail: text("customer_email").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const flights = sqliteTable(
  "flights",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    origin: text("origin").notNull(),
    destination: text("destination").notNull(),
    transitDays: integer("transit_days").notNull(),
    availableServicesJson: text("available_services_json").notNull(),
  },
  (table) => [
    uniqueIndex("flights_origin_dest_uidx").on(table.origin, table.destination),
  ],
);

export const lanes = sqliteTable(
  "lanes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    rfpId: integer("rfp_id")
      .notNull()
      .references(() => rfps.id, { onDelete: "cascade" }),
    laneNumber: integer("lane_number").notNull(),
    laneCode: text("lane_code").notNull(),
    origin: text("origin").notNull(),
    destination: text("destination").notNull(),
    tons: real("tons").notNull(),
    maxTransitDays: integer("max_transit_days").notNull(),
    rawEmail: text("raw_email").notNull(),
    requestedServicesJson: text("requested_services_json")
      .notNull()
      .default("[]"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    intakeConfidence: real("intake_confidence"),
    intakeSource: text("intake_source"),
    intakeStatus: text("intake_status").notNull().default("PENDING"),
  },
  (table) => [uniqueIndex("lanes_rfp_code_uidx").on(table.rfpId, table.laneCode)],
);

export const laneAssessments = sqliteTable(
  "lane_assessments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    rfpId: integer("rfp_id")
      .notNull()
      .references(() => rfps.id, { onDelete: "cascade" }),
    laneId: integer("lane_id")
      .notNull()
      .references(() => lanes.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    chosenRouteJson: text("chosen_route_json"),
    bestCompliantRouteJson: text("best_compliant_route_json"),
    fastestUnconstrainedRouteJson: text("fastest_unconstrained_route_json"),
    alternativesJson: text("alternatives_json").notNull(),
    serviceCoverageJson: text("service_coverage_json").notNull(),
    daysOverLimit: integer("days_over_limit"),
    recommendedAction: text("recommended_action").notNull(),
    needsHumanDecision: integer("needs_human_decision").notNull(),
    humanDecisionReason: text("human_decision_reason"),
    disposition: text("disposition").notNull().default("PENDING_REVIEW"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [uniqueIndex("lane_assessments_lane_uidx").on(table.laneId)],
);

export const emails = sqliteTable("emails", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  rfpId: integer("rfp_id")
    .notNull()
    .references(() => rfps.id, { onDelete: "cascade" }),
  threadType: text("thread_type").notNull(),
  direction: text("direction").notNull(),
  counterparty: text("counterparty").notNull().default("pricing"),
  sender: text("sender").notNull(),
  recipient: text("recipient").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  plainTextBody: text("plain_text_body"),
  parsedPayloadJson: text("parsed_payload_json"),
  status: text("status").notNull(),
  approvedBy: text("approved_by"),
  approvedAt: text("approved_at"),
  sentAt: text("sent_at"),
  createdAt: text("created_at").notNull(),
});

export const pricingResponses = sqliteTable("pricing_responses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  rfpId: integer("rfp_id")
    .notNull()
    .references(() => rfps.id, { onDelete: "cascade" }),
  laneId: integer("lane_id")
    .notNull()
    .references(() => lanes.id, { onDelete: "cascade" }),
  emailId: integer("email_id").references(() => emails.id, {
    onDelete: "set null",
  }),
  recommendedPricePerTonUsd: real("recommended_price_per_ton_usd").notNull(),
  approvedPricePerTonUsd: real("approved_price_per_ton_usd"),
  includedServicesJson: text("included_services_json").notNull(),
  notes: text("notes").notNull().default(""),
  confidence: real("confidence").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const proposals = sqliteTable("proposals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  rfpId: integer("rfp_id")
    .notNull()
    .references(() => rfps.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  status: text("status").notNull(),
  quoteEmailId: integer("quote_email_id").references(() => emails.id, {
    onDelete: "set null",
  }),
  customerReplyEmailId: integer("customer_reply_email_id").references(
    () => emails.id,
    { onDelete: "set null" },
  ),
  totalQuotedLanes: integer("total_quoted_lanes").notNull(),
  totalDeclinedLanes: integer("total_declined_lanes").notNull(),
  totalTons: real("total_tons").notNull(),
  totalValueUsd: real("total_value_usd").notNull(),
  approvedBy: text("approved_by"),
  approvedAt: text("approved_at"),
  sentAt: text("sent_at"),
  acceptedAt: text("accepted_at"),
  createdAt: text("created_at").notNull(),
});

export const proposalLanes = sqliteTable("proposal_lanes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  proposalId: integer("proposal_id")
    .notNull()
    .references(() => proposals.id, { onDelete: "cascade" }),
  laneId: integer("lane_id")
    .notNull()
    .references(() => lanes.id, { onDelete: "cascade" }),
  origin: text("origin").notNull(),
  destination: text("destination").notNull(),
  tons: real("tons").notNull(),
  disposition: text("disposition").notNull(),
  routeAirportsJson: text("route_airports_json"),
  transitDays: integer("transit_days"),
  fulfilledServicesJson: text("fulfilled_services_json").notNull(),
  missingServicesJson: text("missing_services_json").notNull(),
  pricePerTonUsd: real("price_per_ton_usd"),
  lineTotalUsd: real("line_total_usd"),
});

export const meetings = sqliteTable("meetings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  rfpId: integer("rfp_id")
    .notNull()
    .references(() => rfps.id, { onDelete: "cascade" }),
  proposalId: integer("proposal_id")
    .notNull()
    .references(() => proposals.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  scheduledAt: text("scheduled_at").notNull(),
  durationMinutes: integer("duration_minutes").notNull(),
  attendeesJson: text("attendees_json").notNull(),
  agenda: text("agenda").notNull(),
  icsUid: text("ics_uid").notNull(),
  icsContent: text("ics_content").notNull(),
  status: text("status").notNull(),
  createdAt: text("created_at").notNull(),
});

export const agentEvents = sqliteTable(
  "agent_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    rfpId: integer("rfp_id").references(() => rfps.id, { onDelete: "cascade" }),
    laneId: integer("lane_id").references(() => lanes.id, {
      onDelete: "set null",
    }),
    agentName: text("agent_name").notNull(),
    eventType: text("event_type").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    retryCount: integer("retry_count").notNull().default(0),
    status: text("status").notNull(),
    summary: text("summary").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("agent_events_rfp_id_idx").on(table.rfpId, table.id)],
);

export const humanTasks = sqliteTable(
  "human_tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    rfpId: integer("rfp_id").references(() => rfps.id, { onDelete: "cascade" }),
    laneId: integer("lane_id").references(() => lanes.id, {
      onDelete: "set null",
    }),
    laneCode: text("lane_code"),
    taskType: text("task_type").notNull(),
    title: text("title").notNull(),
    reason: text("reason").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull().default("OPEN"),
    resolutionJson: text("resolution_json"),
    resolvedAt: text("resolved_at"),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("human_tasks_rfp_status_idx").on(table.rfpId, table.status)],
);

export const schema = {
  rfps,
  flights,
  lanes,
  laneAssessments,
  emails,
  pricingResponses,
  proposals,
  proposalLanes,
  meetings,
  agentEvents,
  humanTasks,
};
