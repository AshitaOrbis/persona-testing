/**
 * Runtime validation tests for persona and config files.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { validatePersona, validateConfig } from "./validate.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${(e as Error).message}`);
  }
}

console.log("\nValidation Tests\n");

console.log("Persona validation:");
test("accepts a minimal valid persona", () => {
  const p = validatePersona({ name: "Sarah" }, "test.yml");
  assert.equal(p.name, "Sarah");
  assert.deepEqual(p.scenarios, []);
  assert.deepEqual(p.evaluation_criteria, []);
  assert.deepEqual(p.goals, []);
});

test("accepts a full valid persona", () => {
  const p = validatePersona(
    {
      name: "Sarah Martinez",
      title: "Director",
      experience: "15 years",
      technical_comfort: "moderate",
      context: "Needs a rate proposal",
      goals: ["Create scenario"],
      scenarios: [{ name: "Login", description: "Log in", success: "Logged in" }],
      evaluation_criteria: [{ name: "Clarity", weight: "high", question: "Clear?" }],
      voice: "Practical",
      known_routes: { Dashboard: "/dashboard" },
      critical_bug_protocol: { stop_on: ["crash"], continue_on: ["slow"] },
    },
    "test.yml",
  );
  assert.equal(p.scenarios.length, 1);
  assert.equal(p.evaluation_criteria[0].weight, "high");
  assert.equal(p.known_routes!.Dashboard, "/dashboard");
});

test("rejects missing name", () => {
  assert.throws(() => validatePersona({ title: "x" }, "test.yml"), /name/);
});

test("rejects non-mapping top level", () => {
  assert.throws(() => validatePersona("just a string", "test.yml"), /mapping/);
  assert.throws(() => validatePersona(null, "test.yml"), /mapping/);
});

test("rejects scenarios as a string (the F5 crash case)", () => {
  assert.throws(
    () => validatePersona({ name: "Broken", scenarios: "not an array" }, "test.yml"),
    /scenarios/,
  );
});

test("tolerates null evaluation_criteria", () => {
  const p = validatePersona({ name: "X", evaluation_criteria: null }, "test.yml");
  assert.deepEqual(p.evaluation_criteria, []);
});

test("rejects invalid criterion weight", () => {
  assert.throws(
    () =>
      validatePersona(
        {
          name: "X",
          evaluation_criteria: [{ name: "C", weight: "extreme", question: "Q" }],
        },
        "test.yml",
      ),
    /weight/,
  );
});

test("rejects non-string context", () => {
  assert.throws(
    () => validatePersona({ name: "X", context: { nested: true } }, "test.yml"),
    /context/,
  );
});

test("tolerates scalar stop_on in critical_bug_protocol", () => {
  const p = validatePersona(
    { name: "X", critical_bug_protocol: { stop_on: "crash", continue_on: [] } },
    "test.yml",
  );
  assert.deepEqual(p.critical_bug_protocol!.stop_on, ["crash"]);
});

console.log("\nConfig validation:");
test("accepts a valid config", () => {
  const c = validateConfig(
    { provider: "openai", model: "gpt-4o", max_iterations: 20 },
    ".persona-testing.yml",
  );
  assert.equal(c.provider, "openai");
  assert.equal(c.max_iterations, 20);
});

test("rejects unknown provider", () => {
  assert.throws(
    () => validateConfig({ provider: "gemini" }, ".persona-testing.yml"),
    /provider/,
  );
});

test("rejects non-integer max_iterations", () => {
  assert.throws(
    () => validateConfig({ provider: "anthropic", max_iterations: "many" }, "cfg"),
    /max_iterations/,
  );
});

test("defaults provider to anthropic when omitted", () => {
  const c = validateConfig({}, "cfg");
  assert.equal(c.provider, "anthropic");
  assert.equal(c.report_dir, "./reports");
});

test("collects allowed_origins as string array", () => {
  const c = validateConfig({ allowed_origins: ["https://auth.example.com"] }, "cfg");
  assert.deepEqual(c.allowed_origins, ["https://auth.example.com"]);
});

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed.\n");
}
