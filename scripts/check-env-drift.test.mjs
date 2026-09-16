import { test } from "node:test";
import assert from "node:assert/strict";

import { describeDrift, findDrift, parseEnv } from "./check-env-drift.mjs";

function file(name, text) {
  return { file: name, values: parseEnv(text) };
}

test("parses names and values, ignoring comments and blank lines", () => {
  const values = parseEnv("# a comment\n\nA=1\nB = two \n");

  assert.equal(values.get("A"), "1");
  assert.equal(values.get("B"), "two");
  assert.equal(values.size, 2);
});

test("keeps a value that contains an equals sign", () => {
  const values = parseEnv("DATABASE_URL=postgres://u:p@h/db?a=b\n");

  assert.equal(values.get("DATABASE_URL"), "postgres://u:p@h/db?a=b");
});

test("finds a name two files define differently", () => {
  const drift = findDrift(
    file(".env", "INSTANTLY_API_KEY=good\n"),
    file("services/dashboard/.env.production", "INSTANTLY_API_KEY=dead\n"),
  );

  assert.equal(drift.length, 1);
  assert.equal(drift[0].name, "INSTANTLY_API_KEY");
});

/** The exact shape of the 2026-09-16 drift: set in one file, blank in the other. */
test("treats an empty value as a disagreement, and says which side is empty", () => {
  const drift = findDrift(
    file(".env", "INSTANTLY_CAMPAIGN_ID=0c66c771\n"),
    file("services/dashboard/.env.production", "INSTANTLY_CAMPAIGN_ID=\n"),
  );

  assert.equal(drift.length, 1);
  assert.equal(drift[0].right.empty, true);
  assert.equal(drift[0].left.empty, false);
});

test("stays quiet when both files agree", () => {
  const drift = findDrift(file(".env", "A=1\nB=2\n"), file("other", "A=1\nB=2\n"));

  assert.deepEqual(drift, []);
});

test("ignores a name only one file defines", () => {
  const drift = findDrift(file(".env", "A=1\nONLY_HERE=x\n"), file("other", "A=1\n"));

  assert.deepEqual(drift, []);
});

test("never puts a value in the message, only names and files", () => {
  const drift = findDrift(
    file(".env", "INSTANTLY_API_KEY=super-secret-good-key\n"),
    file("services/dashboard/.env.production", "INSTANTLY_API_KEY=super-secret-dead-key\n"),
  );

  const message = describeDrift(drift);

  assert.ok(message.includes("INSTANTLY_API_KEY"));
  assert.ok(message.includes("services/dashboard/.env.production"));
  assert.ok(!message.includes("super-secret-good-key"));
  assert.ok(!message.includes("super-secret-dead-key"));
});
