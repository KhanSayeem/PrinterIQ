import { describe, expect, it } from "vitest";

import {
  HEALTH_CHECKS,
  HEALTH_COMMAND_TIMEOUT_MS,
  HEALTH_OUTPUT_MAX_CHARS,
  healthCheckNames,
  resolveHealthCheck,
  truncateOutput,
} from "./health-commands";

describe("HEALTH_CHECKS", () => {
  it("has a unique name for every check", () => {
    const names = healthCheckNames();
    expect(new Set(names).size).toBe(names.length);
  });

  it("gives every check a described, non-empty argv", () => {
    for (const check of HEALTH_CHECKS) {
      expect(check.argv.length, check.name).toBeGreaterThan(0);
      expect(check.description.length, check.name).toBeGreaterThan(10);
    }
  });

  it("holds no shell metacharacters, because there is no shell to interpret them", () => {
    for (const check of HEALTH_CHECKS) {
      for (const argument of check.argv) {
        expect(argument, `${check.name}: ${argument}`).not.toMatch(/[;&|><$`\n]/);
      }
    }
  });

  it("reads only, so no check can change the estate", () => {
    const writeVerbs = /\b(restart|stop|start|delete|kill|reload|rm|write|set)\b/;
    for (const check of HEALTH_CHECKS) {
      expect(check.argv.join(" "), check.name).not.toMatch(writeVerbs);
    }
  });
});

describe("resolveHealthCheck", () => {
  it("returns the check by name", () => {
    expect(resolveHealthCheck("processes").argv).toEqual(["pm2", "jlist"]);
  });

  it("rejects an unknown name and lists the ones that exist", () => {
    expect(() => resolveHealthCheck("rm -rf /")).toThrow(/Available checks: processes/);
  });
});

describe("truncateOutput", () => {
  it("leaves short output alone", () => {
    expect(truncateOutput("all good")).toBe("all good");
  });

  it("cuts long output and says so", () => {
    const result = truncateOutput("x".repeat(HEALTH_OUTPUT_MAX_CHARS + 50));
    expect(result.length).toBeLessThan(HEALTH_OUTPUT_MAX_CHARS + 60);
    expect(result).toMatch(/output cut at/);
  });
});

describe("HEALTH_COMMAND_TIMEOUT_MS", () => {
  it("is short enough that a hung command cannot hold the panel open", () => {
    expect(HEALTH_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
  });
});
