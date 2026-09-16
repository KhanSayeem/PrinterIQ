#!/usr/bin/env node
/**
 * Fails the deploy when two env files disagree about the same name.
 *
 * On 2026-09-16 `services/dashboard/.env.production` held a second Instantly
 * API key, belonging to a workspace with no paid plan, and an empty
 * INSTANTLY_CAMPAIGN_ID. Nothing broke, because pm2 starts every app with the
 * root `.env` and that key was fine, so the wrong file sat there silently. Any
 * run outside pm2, and any script that sourced the dashboard file, got a dead
 * workspace and a 402, which reads exactly like a lapsed subscription.
 *
 * Two files that both define a name is the bug. This makes it loud.
 *
 * No dependencies: it runs on the server during deploy, before pm2 restarts.
 */

import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Files that must agree with the root .env, when they exist. */
export const CHECKED_FILES = [
  ".env",
  "services/dashboard/.env.production",
  "services/dashboard/.env.local",
  "services/reply-agent/.env",
];

/**
 * Names allowed to differ, with the reason.
 *
 * Empty on purpose. A name belongs here only when two values are genuinely
 * meant to be different, and then the reason has to say why.
 */
export const ALLOWED_DIFFERENCES = new Map([]);

export function parseEnv(text) {
  const values = new Map();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }

    const index = line.indexOf("=");
    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();

    if (name) {
      values.set(name, value);
    }
  }

  return values;
}

/**
 * Every name two files both define with different values.
 *
 * A name only one file defines is fine: that is a file having its own setting,
 * not two files disagreeing.
 */
export function findDrift(left, right) {
  const drift = [];

  for (const [name, leftValue] of left.values) {
    if (!right.values.has(name)) {
      continue;
    }

    const rightValue = right.values.get(name);
    if (leftValue === rightValue || ALLOWED_DIFFERENCES.has(name)) {
      continue;
    }

    drift.push({
      name,
      left: { file: left.file, empty: leftValue.length === 0 },
      right: { file: right.file, empty: rightValue.length === 0 },
    });
  }

  return drift.sort((a, b) => a.name.localeCompare(b.name));
}

/** Names and file paths only. A value never reaches the log. */
export function describeDrift(drift) {
  return drift
    .map(
      (entry) =>
        `  ${entry.name}: ${entry.left.file}${entry.left.empty ? " (empty)" : ""}` +
        ` disagrees with ${entry.right.file}${entry.right.empty ? " (empty)" : ""}`,
    )
    .join("\n");
}

function main() {
  const files = CHECKED_FILES.filter((file) => existsSync(file)).map((file) => ({
    file,
    values: parseEnv(readFileSync(file, "utf8")),
  }));

  if (files.length < 2) {
    console.log(`Env drift check: ${files.length} env file(s) present, nothing to compare.`);
    return;
  }

  const allDrift = [];
  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      allDrift.push(...findDrift(files[i], files[j]));
    }
  }

  if (allDrift.length === 0) {
    console.log(`Env drift check: ${files.length} env files agree on every shared name.`);
    return;
  }

  console.error(
    `Env drift check failed: ${allDrift.length} name(s) defined twice with different values.\n` +
      `${describeDrift(allDrift)}\n\n` +
      "Two files disagreeing about one setting means whichever the process happens to read wins.\n" +
      "Make them match, or remove the duplicate line so there is a single source of truth.",
  );
  process.exitCode = 1;
}

/**
 * pathToFileURL, not a template string: on Windows argv[1] is a backslash path
 * and `file://D:\...` never matches import.meta.url, so the check would quietly
 * do nothing when run locally.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
