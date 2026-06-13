import { describe, expect, it } from "vitest";
import { parseLeadListParams } from "./lead-list-params";

describe("parseLeadListParams", () => {
  it("returns defaults for an empty query", () => {
    expect(parseLeadListParams({})).toEqual({
      status: undefined,
      state: undefined,
      tradeType: undefined,
      search: undefined,
      scoreMin: undefined,
      scoreMax: undefined,
      page: 1,
    });
  });

  it("parses status, state, trade_type, score range and page", () => {
    expect(
      parseLeadListParams({
        status: "qualified",
        state: "NSW",
        trade_type: "plumbing",
        q: "aqua",
        score_min: "40",
        score_max: "80",
        page: "3",
      }),
    ).toEqual({
      status: "qualified",
      state: "NSW",
      tradeType: "plumbing",
      search: "aqua",
      scoreMin: 40,
      scoreMax: 80,
      page: 3,
    });
  });

  it("ignores invalid numeric params and clamps page to at least 1", () => {
    const result = parseLeadListParams({ score_min: "not-a-number", page: "0" });

    expect(result.scoreMin).toBeUndefined();
    expect(result.page).toBe(1);
  });

  it("trims blank search params and accepts search as an alias", () => {
    expect(parseLeadListParams({ q: "   " }).search).toBeUndefined();
    expect(parseLeadListParams({ search: "  kurt  " }).search).toBe("kurt");
  });
});
