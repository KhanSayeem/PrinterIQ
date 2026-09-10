import { describe, expect, it } from "vitest";
import {
  SYDNEY_TIME_ZONE,
  getSydneyDayRange,
  getSydneyIsoDate,
  formatSydneyDayLabel,
} from "./sydney-day";

describe("Sydney day range", () => {
  it("names the operator time zone explicitly", () => {
    expect(SYDNEY_TIME_ZONE).toBe("Australia/Sydney");
  });

  it("starts the day at Sydney midnight during standard time", () => {
    const range = getSydneyDayRange(new Date("2026-06-15T03:00:00.000Z"));

    expect(range.start.toISOString()).toBe("2026-06-14T14:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-06-15T14:00:00.000Z");
  });

  it("keeps the last minute before Sydney midnight inside the same day", () => {
    const range = getSydneyDayRange(new Date("2026-06-15T13:59:59.000Z"));

    expect(range.start.toISOString()).toBe("2026-06-14T14:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-06-15T14:00:00.000Z");
  });

  it("rolls to the next day the instant Sydney midnight arrives", () => {
    const range = getSydneyDayRange(new Date("2026-06-15T14:00:00.000Z"));

    expect(range.start.toISOString()).toBe("2026-06-15T14:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-06-16T14:00:00.000Z");
  });

  it("does not fall back to the UTC day when the two dates disagree", () => {
    // 23:00 UTC on 15 June is already 09:00 on 16 June in Sydney. A UTC day
    // would start at 2026-06-15T00:00:00Z and wrongly count most of Sydney's
    // previous working day as today.
    const range = getSydneyDayRange(new Date("2026-06-15T23:00:00.000Z"));

    expect(range.start.toISOString()).toBe("2026-06-15T14:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-06-16T14:00:00.000Z");
  });

  it("handles the 23 hour day when daylight saving starts", () => {
    // 4 October 2026, Sydney clocks jump from 02:00 AEST to 03:00 AEDT.
    const range = getSydneyDayRange(new Date("2026-10-04T00:00:00.000Z"));

    expect(range.start.toISOString()).toBe("2026-10-03T14:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-10-04T13:00:00.000Z");
    expect(range.end.getTime() - range.start.getTime()).toBe(23 * 60 * 60 * 1000);
  });

  it("handles the 25 hour day when daylight saving ends", () => {
    // 5 April 2026, Sydney clocks fall back from 03:00 AEDT to 02:00 AEST.
    const range = getSydneyDayRange(new Date("2026-04-05T00:00:00.000Z"));

    expect(range.start.toISOString()).toBe("2026-04-04T13:00:00.000Z");
    expect(range.end.toISOString()).toBe("2026-04-05T14:00:00.000Z");
    expect(range.end.getTime() - range.start.getTime()).toBe(25 * 60 * 60 * 1000);
  });

  it("still starts the daylight saving day at midnight before the jump", () => {
    const range = getSydneyDayRange(new Date("2026-10-04T12:59:59.000Z"));

    expect(range.start.toISOString()).toBe("2026-10-03T14:00:00.000Z");
  });

  it("labels the day the operator is actually looking at", () => {
    expect(formatSydneyDayLabel(new Date("2026-06-15T23:00:00.000Z"))).toBe("Tue 16 Jun");
  });
});

describe("Sydney ISO date", () => {
  it("gives the Sydney calendar date, not the UTC one", () => {
    // 23:00 UTC on 15 June is already 09:00 on 16 June in Sydney, which is the
    // date Instantly's daily analytics rows are stamped with for these sends.
    expect(getSydneyIsoDate(new Date("2026-06-15T23:00:00.000Z"))).toBe("2026-06-16");
  });

  it("keeps the last second before Sydney midnight on the day that is ending", () => {
    expect(getSydneyIsoDate(new Date("2026-06-15T13:59:59.000Z"))).toBe("2026-06-15");
  });

  it("rolls over the instant Sydney midnight arrives", () => {
    expect(getSydneyIsoDate(new Date("2026-06-15T14:00:00.000Z"))).toBe("2026-06-16");
  });

  it("pads month and day so the string sorts and compares", () => {
    expect(getSydneyIsoDate(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01-05");
  });

  it("agrees with the day range it is paired with during daylight saving", () => {
    const now = new Date("2026-01-05T00:00:00.000Z");
    const range = getSydneyDayRange(now);

    expect(getSydneyIsoDate(range.start)).toBe(getSydneyIsoDate(now));
  });
});
