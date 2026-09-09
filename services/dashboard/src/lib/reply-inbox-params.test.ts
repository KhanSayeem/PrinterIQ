import { describe, expect, it } from "vitest";
import { parseReplyInboxParams } from "./reply-inbox-params";

describe("parseReplyInboxParams", () => {
  it("defaults to the needs-attention view on the first page", () => {
    expect(parseReplyInboxParams({})).toEqual({ filter: "needs_attention", page: 1 });
  });

  it("keeps a recognised filter", () => {
    expect(parseReplyInboxParams({ filter: "interested" }).filter).toBe("interested");
    expect(parseReplyInboxParams({ filter: "all" }).filter).toBe("all");
    expect(parseReplyInboxParams({ filter: "unsubscribe" }).filter).toBe("unsubscribe");
  });

  it("falls back to needs attention for an unknown filter", () => {
    expect(parseReplyInboxParams({ filter: "wat" }).filter).toBe("needs_attention");
    expect(parseReplyInboxParams({ filter: "" }).filter).toBe("needs_attention");
  });

  it("clamps the page to a positive integer", () => {
    expect(parseReplyInboxParams({ page: "4" }).page).toBe(4);
    expect(parseReplyInboxParams({ page: "0" }).page).toBe(1);
    expect(parseReplyInboxParams({ page: "-3" }).page).toBe(1);
    expect(parseReplyInboxParams({ page: "abc" }).page).toBe(1);
  });
});
