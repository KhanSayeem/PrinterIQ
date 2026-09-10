import { describe, expect, it } from "vitest";
import {
  describeReplyIngestHealth,
  REPLY_INGEST_STALE_HOURS,
  REPLY_INGEST_UNKNOWN_MESSAGE,
  type ReplyIngestSignal,
} from "./reply-ingest-health";

const now = new Date("2026-09-10T02:00:00.000Z");

function hoursBefore(hours: number) {
  return new Date(now.getTime() - hours * 60 * 60 * 1000);
}

function signal(overrides: Partial<ReplyIngestSignal> = {}): ReplyIngestSignal {
  return { lastInboundAt: null, firstHandoffAt: null, ...overrides };
}

describe("describeReplyIngestHealth", () => {
  it("stays neutral when nothing has been handed to Instantly yet", () => {
    const health = describeReplyIngestHealth(signal(), now);

    expect(health.status).toBe("nothing_sent");
    expect(health.message).toContain("No replies recorded yet");
    expect(health.message).toContain("handed to Instantly");
  });

  it("says the inbound path is unproven when outreach went out and nothing ever came back", () => {
    const health = describeReplyIngestHealth(signal({ firstHandoffAt: hoursBefore(72) }), now);

    expect(health.status).toBe("never_received");
    expect(health.message).toContain("No inbound reply has ever been recorded");
    expect(health.message).toMatch(/07 Sept 2026/);
    expect(health.message).toContain("Instantly reply webhook");
  });

  it("names the last inbound write when one is recent", () => {
    const health = describeReplyIngestHealth(
      signal({ firstHandoffAt: hoursBefore(72), lastInboundAt: hoursBefore(3) }),
      now,
    );

    expect(health.status).toBe("recent");
    expect(health.message).toContain("No inbound reply has been recorded since");
    expect(health.message).toContain("3 hours ago");
    expect(health.message).not.toContain("Instantly reply webhook");
  });

  it("asks the operator to check the webhook once the last inbound write goes stale", () => {
    const health = describeReplyIngestHealth(
      signal({ firstHandoffAt: hoursBefore(400), lastInboundAt: hoursBefore(REPLY_INGEST_STALE_HOURS + 1) }),
      now,
    );

    expect(health.status).toBe("stale");
    expect(health.message).toContain("No inbound reply has been recorded since");
    expect(health.message).toContain("Instantly reply webhook");
  });

  it("treats the staleness boundary itself as still recent", () => {
    const health = describeReplyIngestHealth(
      signal({ firstHandoffAt: hoursBefore(400), lastInboundAt: hoursBefore(REPLY_INGEST_STALE_HOURS) }),
      now,
    );

    expect(health.status).toBe("recent");
  });

  it("never tells the operator that a zero is the correct number", () => {
    const messages = [
      REPLY_INGEST_UNKNOWN_MESSAGE,
      describeReplyIngestHealth(signal(), now).message,
      describeReplyIngestHealth(signal({ firstHandoffAt: hoursBefore(72) }), now).message,
      describeReplyIngestHealth(signal({ firstHandoffAt: hoursBefore(72), lastInboundAt: hoursBefore(3) }), now)
        .message,
      describeReplyIngestHealth(signal({ firstHandoffAt: hoursBefore(400), lastInboundAt: hoursBefore(400) }), now)
        .message,
    ];

    for (const message of messages) {
      expect(message).not.toMatch(/correct number|not a fault|posts every inbound reply/i);
    }
  });
});
