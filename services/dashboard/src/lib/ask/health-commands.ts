/**
 * Health reads for the ask panel.
 *
 * The model never writes a command. It picks a name from this list, and the
 * name maps to a fixed argv array that runs with no shell, so there is nothing
 * to inject into: no interpolation, no user text, no pipes.
 */

export type HealthCheck = {
  readonly name: string;
  readonly description: string;
  /** argv, run directly. First element is the binary. */
  readonly argv: readonly string[];
};

/** Output past this is cut, so one noisy log cannot fill the answer. */
export const HEALTH_OUTPUT_MAX_CHARS = 4_000;

/** A hung command fails instead of holding the panel open. */
export const HEALTH_COMMAND_TIMEOUT_MS = 10_000;

export const HEALTH_CHECKS: readonly HealthCheck[] = [
  {
    name: "processes",
    description:
      "Every pm2 process with its status, restart count and uptime. Use this to answer whether a worker is running, stopped or crash looping.",
    argv: ["pm2", "jlist"],
  },
  {
    name: "worker_logs",
    description:
      "The last 40 log lines across all pm2 processes. Use this to see the actual error behind a stopped or restarting worker.",
    argv: ["pm2", "logs", "--nostream", "--lines", "40"],
  },
  {
    name: "disk_space",
    description: "Free disk space on the root volume. A full disk stops the workers and the database.",
    argv: ["df", "-h", "/"],
  },
  {
    name: "memory",
    description: "Free and used memory in megabytes.",
    argv: ["free", "-m"],
  },
  {
    name: "load",
    description: "Server uptime and load average.",
    argv: ["uptime"],
  },
] as const;

export function healthCheckNames(): string[] {
  return HEALTH_CHECKS.map((check) => check.name);
}

export function resolveHealthCheck(name: string): HealthCheck {
  const check = HEALTH_CHECKS.find((candidate) => candidate.name === name);

  if (!check) {
    throw new Error(
      `Unknown health check "${name}". Available checks: ${healthCheckNames().join(", ")}.`,
    );
  }

  return check;
}

export function truncateOutput(output: string, max = HEALTH_OUTPUT_MAX_CHARS): string {
  if (output.length <= max) {
    return output;
  }

  return `${output.slice(0, max)}\n... output cut at ${max} characters.`;
}
