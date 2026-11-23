import type { Client } from "@libsql/client";

const SCHEMA_STATEMENTS: readonly string[] = [
  "PRAGMA foreign_keys = ON;",
  `CREATE TABLE IF NOT EXISTS rfps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source_type TEXT NOT NULL,
    status TEXT NOT NULL,
    llm_provider TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS flights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    transit_days INTEGER NOT NULL,
    available_services_json TEXT NOT NULL
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS flights_origin_dest_uidx
    ON flights(origin, destination);`,
  `CREATE TABLE IF NOT EXISTS lanes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfp_id INTEGER NOT NULL REFERENCES rfps(id) ON DELETE CASCADE,
    lane_number INTEGER NOT NULL,
    lane_code TEXT NOT NULL,
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    tons REAL NOT NULL,
    max_transit_days INTEGER NOT NULL,
    raw_email TEXT NOT NULL,
    requested_services_json TEXT NOT NULL DEFAULT '[]',
    evidence_json TEXT NOT NULL DEFAULT '[]',
    intake_confidence REAL,
    intake_source TEXT,
    intake_status TEXT NOT NULL DEFAULT 'PENDING'
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lanes_rfp_code_uidx
    ON lanes(rfp_id, lane_code);`,
  `CREATE TABLE IF NOT EXISTS lane_assessments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfp_id INTEGER NOT NULL REFERENCES rfps(id) ON DELETE CASCADE,
    lane_id INTEGER NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    chosen_route_json TEXT,
    best_compliant_route_json TEXT,
    fastest_unconstrained_route_json TEXT,
    alternatives_json TEXT NOT NULL,
    service_coverage_json TEXT NOT NULL,
    days_over_limit INTEGER,
    recommended_action TEXT NOT NULL,
    needs_human_decision INTEGER NOT NULL,
    human_decision_reason TEXT,
    disposition TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    created_at TEXT NOT NULL
  );`,
  `CREATE UNIQUE INDEX IF NOT EXISTS lane_assessments_lane_uidx
    ON lane_assessments(lane_id);`,
  `CREATE TABLE IF NOT EXISTS emails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfp_id INTEGER NOT NULL REFERENCES rfps(id) ON DELETE CASCADE,
    thread_type TEXT NOT NULL,
    direction TEXT NOT NULL,
    counterparty TEXT NOT NULL DEFAULT 'pricing',
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    parsed_payload_json TEXT,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS pricing_responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfp_id INTEGER NOT NULL REFERENCES rfps(id) ON DELETE CASCADE,
    lane_id INTEGER NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
    email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
    recommended_price_per_ton_usd REAL NOT NULL,
    approved_price_per_ton_usd REAL,
    included_services_json TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfp_id INTEGER NOT NULL REFERENCES rfps(id) ON DELETE CASCADE,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    quote_email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
    customer_reply_email_id INTEGER REFERENCES emails(id) ON DELETE SET NULL,
    total_quoted_lanes INTEGER NOT NULL,
    total_declined_lanes INTEGER NOT NULL,
    total_tons REAL NOT NULL,
    total_value_usd REAL NOT NULL,
    accepted_at TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS proposal_lanes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    lane_id INTEGER NOT NULL REFERENCES lanes(id) ON DELETE CASCADE,
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    tons REAL NOT NULL,
    disposition TEXT NOT NULL,
    route_airports_json TEXT,
    transit_days INTEGER,
    fulfilled_services_json TEXT NOT NULL,
    missing_services_json TEXT NOT NULL,
    price_per_ton_usd REAL,
    line_total_usd REAL
  );`,
  `CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfp_id INTEGER NOT NULL REFERENCES rfps(id) ON DELETE CASCADE,
    proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    scheduled_at TEXT NOT NULL,
    duration_minutes INTEGER NOT NULL,
    attendees_json TEXT NOT NULL,
    agenda TEXT NOT NULL,
    ics_uid TEXT NOT NULL,
    ics_content TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE TABLE IF NOT EXISTS agent_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfp_id INTEGER REFERENCES rfps(id) ON DELETE CASCADE,
    lane_id INTEGER REFERENCES lanes(id) ON DELETE SET NULL,
    agent_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    latency_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    retry_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS agent_events_rfp_id_idx
    ON agent_events(rfp_id, id);`,
  `CREATE TABLE IF NOT EXISTS human_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rfp_id INTEGER REFERENCES rfps(id) ON DELETE CASCADE,
    lane_id INTEGER REFERENCES lanes(id) ON DELETE SET NULL,
    lane_code TEXT,
    task_type TEXT NOT NULL,
    title TEXT NOT NULL,
    reason TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'OPEN',
    resolution_json TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS human_tasks_rfp_status_idx
    ON human_tasks(rfp_id, status);`,
];

export async function ensureDatabaseSchema(client: Client): Promise<void> {
  for (const sql of SCHEMA_STATEMENTS) {
    await client.execute(sql);
  }
  const emailCols = await client.execute("PRAGMA table_info(emails);");
  const hasCounterparty = emailCols.rows.some(
    (row) => String(row.name) === "counterparty",
  );
  if (!hasCounterparty) {
    await client.execute(
      "ALTER TABLE emails ADD COLUMN counterparty TEXT NOT NULL DEFAULT 'pricing';",
    );
  }
}
