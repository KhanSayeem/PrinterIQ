import { describe, expect, it } from "vitest";
import {
  distributeDailyLimit,
  exceedsGoogleRampGuidance,
  MAX_REQUESTABLE_DAILY_TOTAL,
  nextRampStep,
  SENDING_VOLUME_RAMP,
} from "./sending-ramp";

describe("sending volume ramp", () => {
  it("carries the exact ramp recorded in ADR 005", () => {
    expect(SENDING_VOLUME_RAMP).toEqual([30, 45, 68, 101, 152, 155]);
  });

  it("suggests the first ramp step when the estate is below day one volume", () => {
    expect(nextRampStep(0)).toBe(30);
    expect(nextRampStep(29)).toBe(30);
  });

  it("suggests the next step strictly above the current total", () => {
    expect(nextRampStep(30)).toBe(45);
    expect(nextRampStep(31)).toBe(45);
    expect(nextRampStep(45)).toBe(68);
    expect(nextRampStep(68)).toBe(101);
    expect(nextRampStep(101)).toBe(152);
    expect(nextRampStep(152)).toBe(155);
  });

  it("reports no next step once the estate is at or above the ramp destination", () => {
    expect(nextRampStep(155)).toBeNull();
    expect(nextRampStep(200)).toBeNull();
  });

  it("does not flag an increase at exactly double the current volume", () => {
    expect(exceedsGoogleRampGuidance(30, 60)).toBe(false);
  });

  it("flags an increase one above double the current volume", () => {
    expect(exceedsGoogleRampGuidance(30, 61)).toBe(true);
  });

  it("does not flag an increase one below double the current volume", () => {
    expect(exceedsGoogleRampGuidance(30, 59)).toBe(false);
  });

  it("does not flag a decrease", () => {
    expect(exceedsGoogleRampGuidance(155, 30)).toBe(false);
  });

  it("flags any positive volume when there is no current volume to grow from", () => {
    expect(exceedsGoogleRampGuidance(0, 1)).toBe(true);
    expect(exceedsGoogleRampGuidance(0, 0)).toBe(false);
  });

  it("splits a campaign total across mailboxes so the parts sum to the total", () => {
    const split = distributeDailyLimit(30, 8);

    expect(split).toEqual([4, 4, 4, 4, 4, 4, 3, 3]);
    expect(split.reduce((sum, value) => sum + value, 0)).toBe(30);
  });

  it("splits an exactly divisible total evenly", () => {
    expect(distributeDailyLimit(152, 8)).toEqual([19, 19, 19, 19, 19, 19, 19, 19]);
  });

  it("returns no shares when there are no mailboxes to split across", () => {
    expect(distributeDailyLimit(30, 0)).toEqual([]);
  });

  it("caps the requestable total so a typo cannot be applied", () => {
    expect(MAX_REQUESTABLE_DAILY_TOTAL).toBe(1000);
  });
});
