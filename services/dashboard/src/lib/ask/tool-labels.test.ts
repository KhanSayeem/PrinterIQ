import { describe, expect, it } from "vitest";

import { ASK_THINKING_LABELS, askToolLabel, askToolLabelNames } from "./tool-labels";
import { askToolNames } from "./tools";

describe("askToolLabel", () => {
  it("has a label for every tool in the toolbox", () => {
    expect([...askToolLabelNames()].sort()).toEqual([...askToolNames()].sort());
  });

  it("reads as plain English, not as a function name", () => {
    for (const name of askToolLabelNames()) {
      const label = askToolLabel(name);
      expect(label, name).not.toContain("_");
      expect(label.length, name).toBeGreaterThan(5);
    }
  });

  it("falls back to something readable for a tool it has never seen", () => {
    expect(askToolLabel("brand_new_reader")).toBe("Reading brand new reader");
  });

  it("has something to say before any tool starts", () => {
    expect(ASK_THINKING_LABELS.length).toBeGreaterThan(0);
    expect(ASK_THINKING_LABELS[0]).toBe("Thinking");
  });
});
