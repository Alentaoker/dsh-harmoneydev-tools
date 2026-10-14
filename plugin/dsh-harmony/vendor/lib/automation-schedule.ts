import { rrulestr } from "rrule";

const MAX_RULE_LENGTH = 2_048;

export function normalizeRRule(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_RULE_LENGTH) throw new Error("A bounded RRULE is required.");
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const ruleLine = lines.find((line) => line.toUpperCase().startsWith("RRULE:"))
    ?? (lines.length === 1 && lines[0].toUpperCase().startsWith("FREQ=") ? `RRULE:${lines[0]}` : undefined);
  if (!ruleLine) throw new Error("Schedule must contain an RRULE.");
  return ruleLine.toUpperCase();
}

export function validateTimezone(value: string): string {
  const timezone = value.trim();
  if (!timezone || timezone.length > 100) throw new Error("A valid timezone is required.");
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date()); }
  catch { throw new Error(`Unknown timezone: ${timezone}`); }
  return timezone;
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

interface DateParts { year: number; month: number; day: number; hour: number; minute: number; second: number; }

function zonedParts(value: Date, timezone: string): DateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: number("year"), month: number("month"), day: number("day"), hour: number("hour"), minute: number("minute"), second: number("second") };
}

function instantToWall(value: number, timezone: string): Date {
  const part = zonedParts(new Date(value), timezone);
  return new Date(Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second));
}

function wallToInstant(value: Date, timezone: string): number {
  const desired = Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate(), value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds());
  let candidate = desired;
  // Intl exposes offsets through wall-clock components. Iteration also follows
  // daylight-saving changes without hard-coding an offset table.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timezone);
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const correction = desired - represented;
    candidate += correction;
    if (correction === 0) break;
  }
  return candidate + value.getUTCMilliseconds();
}

export function nextAutomationOccurrence(
  rrule: string,
  after: number,
  anchor: number,
  timezone: string,
): number | null {
  const normalized = normalizeRRule(rrule);
  const tzid = validateTimezone(timezone);
  let schedule;
  try {
    // rrule returns floating/pseudo-UTC Date values. Keep recurrence math in
    // wall time, then convert the selected wall occurrence to a real instant.
    schedule = rrulestr(normalized, { dtstart: instantToWall(anchor, tzid) });
  } catch (error) {
    throw new Error(`Invalid RRULE: ${error instanceof Error ? error.message : String(error)}`);
  }
  const next = schedule.after(instantToWall(after, tzid), false);
  return next ? wallToInstant(next, tzid) : null;
}

export function assertValidAutomationSchedule(rrule: string, anchor: number, timezone: string): void {
  const next = nextAutomationOccurrence(rrule, anchor - 1, anchor, timezone);
  if (next === null) throw new Error("Schedule has no future occurrence.");
}

export function describeRRule(rrule: string): { frequency: string; interval: number } {
  const values = new Map(normalizeRRule(rrule).slice(6).split(";").map((part) => {
    const [key, ...rest] = part.split("=");
    return [key, rest.join("=")];
  }));
  return {
    frequency: values.get("FREQ")?.toLowerCase() ?? "custom",
    interval: Math.max(1, Number.parseInt(values.get("INTERVAL") ?? "1", 10) || 1),
  };
}
