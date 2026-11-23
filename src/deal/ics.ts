import { randomUUID } from "node:crypto";

export interface MeetingAttendee {
  role: "RFP_TEAM" | "CUSTOMER" | "PRICING" | "OTHER";
  name: string;
  email: string;
}

export interface KickoffSlot {
  scheduledAtUtcIso: string;
  scheduledAtEtDisplay: string;
  startUtc: Date;
  endUtc: Date;
  durationMinutes: number;
  easternDate: {
    year: number;
    month: number;
    day: number;
  };
  easternOffsetLabel: "EST" | "EDT";
}

export interface GenerateKickoffIcsOptions {
  uid?: string;
  title: string;
  description: string;
  location?: string;
  slot: KickoffSlot;
  organizer: {
    name: string;
    email: string;
  };
  attendees: readonly MeetingAttendee[];
  now?: Date;
}

interface EasternDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  timeZoneName: string;
}

const ET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

function getEasternParts(date: Date): EasternDateTimeParts {
  const parts = ET_FORMATTER.formatToParts(date);
  const byType = new Map<string, string>();
  for (const part of parts) {
    byType.set(part.type, part.value);
  }
  const hourRaw = Number.parseInt(byType.get("hour") ?? "0", 10);
  return {
    year: Number.parseInt(byType.get("year") ?? "1970", 10),
    month: Number.parseInt(byType.get("month") ?? "1", 10),
    day: Number.parseInt(byType.get("day") ?? "1", 10),
    hour: hourRaw === 24 ? 0 : hourRaw,
    minute: Number.parseInt(byType.get("minute") ?? "0", 10),
    second: Number.parseInt(byType.get("second") ?? "0", 10),
    timeZoneName: byType.get("timeZoneName") ?? "ET",
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function resolve10amEasternToUtc(year: number, month: number, day: number): {
  utcDate: Date;
  offsetLabel: "EST" | "EDT";
} {
  const targetAsUtcMs = Date.UTC(year, month - 1, day, 10, 0, 0);
  // Start with EST assumption (UTC-5 => 15:00Z), then correct offset iteratively
  let candidate = new Date(Date.UTC(year, month - 1, day, 15, 0, 0));
  for (let i = 0; i < 2; i += 1) {
    const parts = getEasternParts(candidate);
    const actualAsUtcMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const diffMs = targetAsUtcMs - actualAsUtcMs;
    if (diffMs === 0) {
      break;
    }
    candidate = new Date(candidate.getTime() + diffMs);
  }

  const verified = getEasternParts(candidate);
  const offsetLabel: "EST" | "EDT" = verified.timeZoneName.includes("EDT")
    ? "EDT"
    : "EST";
  return { utcDate: candidate, offsetLabel };
}

export function computeNextBusinessDay10amET(
  fromDate: Date = new Date(),
  durationMinutes: number = 45,
): KickoffSlot {
  const safeDuration = Math.max(15, Math.round(durationMinutes));
  const currentEt = getEasternParts(fromDate);

  const cursor = new Date(
    Date.UTC(currentEt.year, currentEt.month - 1, currentEt.day, 12, 0, 0),
  );
  // Always move to the next calendar day in ET, then skip Saturday (6) / Sunday (0)
  cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  const targetYear = cursor.getUTCFullYear();
  const targetMonth = cursor.getUTCMonth() + 1;
  const targetDay = cursor.getUTCDate();

  const { utcDate: startUtc, offsetLabel } = resolve10amEasternToUtc(
    targetYear,
    targetMonth,
    targetDay,
  );
  const endUtc = new Date(startUtc.getTime() + safeDuration * 60_000);

  return {
    scheduledAtUtcIso: startUtc.toISOString(),
    scheduledAtEtDisplay: `${targetYear}-${pad2(targetMonth)}-${pad2(targetDay)} 10:00 ${offsetLabel} (America/New_York)`,
    startUtc,
    endUtc,
    durationMinutes: safeDuration,
    easternDate: {
      year: targetYear,
      month: targetMonth,
      day: targetDay,
    },
    easternOffsetLabel: offsetLabel,
  };
}

export function formatIcsUtcTimestamp(date: Date): string {
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate()),
    "T",
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds()),
    "Z",
  ].join("");
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function escapeIcsParam(value: string): string {
  return value.replace(/["\r\n;:]/g, " ").trim();
}

function foldIcsLine(line: string): string {
  const maxBytes = 75;
  const chunks: string[] = [];
  let current = "";
  for (const ch of line) {
    const next = current + ch;
    const byteLength = Buffer.byteLength(next, "utf8");
    if (byteLength > maxBytes && current.length > 0) {
      chunks.push(current);
      current = ` ${ch}`;
    } else {
      current = next;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks.join("\r\n");
}

export function generateKickoffIcs(options: GenerateKickoffIcsOptions): {
  uid: string;
  icsContent: string;
} {
  const uid = options.uid ?? `kickoff-${randomUUID()}@air-freight-rfp-agent`;
  const dtStamp = formatIcsUtcTimestamp(options.now ?? new Date());
  const dtStart = formatIcsUtcTimestamp(options.slot.startUtc);
  const dtEnd = formatIcsUtcTimestamp(options.slot.endUtc);

  const attendeeLines = options.attendees.map(
    (att) =>
      `ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN="${escapeIcsParam(att.name)}":mailto:${att.email.trim()}`,
  );

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Air Freight RFP Agent//RFP Automation v1//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeIcsText(options.title)}`,
    `DESCRIPTION:${escapeIcsText(options.description)}`,
    `LOCATION:${escapeIcsText(options.location ?? "Virtual Kickoff (Video Conference)")}`,
    `ORGANIZER;CN="${escapeIcsParam(options.organizer.name)}":mailto:${options.organizer.email.trim()}`,
    ...attendeeLines,
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  const folded = lines.map(foldIcsLine).join("\r\n") + "\r\n";
  return {
    uid,
    icsContent: folded,
  };
}
