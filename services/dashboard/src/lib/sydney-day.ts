/**
 * Day boundaries in the operator's own time zone.
 *
 * The campaign sends into Australian business hours and the operator reads the
 * dashboard from Sydney, so "today" has to mean the Sydney calendar day. The
 * VPS runs in UTC, which is ten or eleven hours behind: a UTC day boundary
 * would silently blend two Sydney days together for most of the working day.
 */

export const SYDNEY_TIME_ZONE = "Australia/Sydney";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export type SydneyDayRange = {
  start: Date;
  end: Date;
};

type SydneyWallClock = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const wallClockFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: SYDNEY_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function readSydneyWallClock(at: Date): SydneyWallClock {
  const parts = wallClockFormatter.formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes) => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };

  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** Minutes Sydney is ahead of UTC at a given instant: 600 in AEST, 660 in AEDT. */
function sydneyOffsetMinutes(at: Date): number {
  const wall = readSydneyWallClock(at);
  const wallAsUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  return Math.round((wallAsUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/**
 * The instant Sydney midnight falls on a given calendar date.
 *
 * Applying the current offset is not enough on the two changeover days each
 * year: on 4 October the day opens in AEST and ends in AEDT, so an offset
 * sampled in the afternoon points at the wrong midnight. Sampling once, then
 * re-deriving from the offset actually in force at the candidate instant,
 * settles both transitions.
 */
function sydneyMidnight(year: number, month: number, day: number): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day);
  const guessOffset = sydneyOffsetMinutes(new Date(wallAsUtc));
  const candidate = new Date(wallAsUtc - guessOffset * 60000);
  const actualOffset = sydneyOffsetMinutes(candidate);

  if (actualOffset === guessOffset) {
    return candidate;
  }

  return new Date(wallAsUtc - actualOffset * 60000);
}

/**
 * Half open range for the Sydney day containing `now`: start inclusive, end
 * exclusive. Callers filter with `>= start` and `< end`.
 */
export function getSydneyDayRange(now: Date = new Date()): SydneyDayRange {
  const wall = readSydneyWallClock(now);
  const start = sydneyMidnight(wall.year, wall.month, wall.day);

  const nextWallDay = new Date(Date.UTC(wall.year, wall.month - 1, wall.day) + 24 * 60 * 60 * 1000);
  const end = sydneyMidnight(
    nextWallDay.getUTCFullYear(),
    nextWallDay.getUTCMonth() + 1,
    nextWallDay.getUTCDate(),
  );

  return { start, end };
}

/** Short label for the Sydney date, for example "Tue 16 Jun". */
export function formatSydneyDayLabel(now: Date = new Date()): string {
  const wall = readSydneyWallClock(now);
  const weekday = WEEKDAY_NAMES[new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).getUTCDay()];

  return `${weekday} ${wall.day} ${MONTH_NAMES[wall.month - 1]}`;
}

/**
 * The Sydney calendar date as YYYY-MM-DD.
 *
 * Instantly stamps each daily analytics row with a plain date, so matching
 * "today" against those rows needs the same day the range helper above uses.
 * Deriving it from UTC would name yesterday for the whole Sydney morning.
 */
export function getSydneyIsoDate(now: Date = new Date()): string {
  const wall = readSydneyWallClock(now);
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`;
}
