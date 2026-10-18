/**
 * Runtime validation tests for persona and config files.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  CONFIG_FIELD_SCHEMA,
  type ConfigFieldDefinition,
} from "./schema.js";
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
test("accepts a name-only persona only in explicit exploratory mode", () => {
  const p = validatePersona({ name: "Sarah" }, "test.yml", "exploratory");
  assert.equal(p.name, "Sarah");
  assert.deepEqual(p.scenarios, []);
  assert.deepEqual(p.evaluation_criteria, []);
  assert.deepEqual(p.goals, []);
});

test("rejects a name-only persona in gate mode", () => {
  assert.throws(
    () => validatePersona({ name: "Sarah" }, "test.yml"),
    /gate-capable.*20.*scenario.*evaluation criterion/is,
  );
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
  const p = validatePersona(
    { name: "X", evaluation_criteria: null },
    "test.yml",
    "exploratory",
  );
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
    "exploratory",
  );
  assert.deepEqual(p.critical_bug_protocol!.stop_on, ["crash"]);
});

test("rejects unknown persona keys with the nearest legal key", () => {
  assert.throws(
    () =>
      validatePersona(
        { name: "X", scenario: [], goals: ["A sufficiently detailed testing goal"] },
        "test.yml",
      ),
    /"scenario".*"scenarios"/s,
  );
});

test("rejects empty required scenario and criterion strings", () => {
  assert.throws(
    () =>
      validatePersona(
        {
          name: "X",
          goals: ["A sufficiently detailed testing goal"],
          scenarios: [{ name: "", description: "", success: "" }],
          evaluation_criteria: [{ name: "", weight: "high", question: "" }],
        },
        "test.yml",
      ),
    /scenarios\[0\]\.name.*evaluation_criteria\[0\]\.question/s,
  );
});

console.log("\nConfig validation:");
test("rejects explicit null for model and api_key with field-specific type errors", () => {
  const accepted: string[] = [];

  for (const key of ["model", "api_key"] as const) {
    try {
      validateConfig({ [key]: null }, "cfg");
      accepted.push(key);
    } catch (error) {
      assert.match((error as Error).message, new RegExp(`"${key}".*string`, "s"));
    }
  }

  assert.deepEqual(accepted, [], `explicit null was accepted for: ${accepted.join(", ")}`);
});

function invalidValuesForConfigField(
  definition: ConfigFieldDefinition,
): Array<{ label: string; value: unknown }> {
  const wrongPrimitive =
    definition.kind === "positive_integer"
      ? "1"
      : definition.kind === "non_empty_string_array"
        ? false
        : 1;
  const wrongArray =
    definition.kind === "non_empty_string_array" ? [1] : [];

  return [
    { label: "null", value: null },
    { label: "explicit undefined", value: undefined },
    { label: "wrong primitive", value: wrongPrimitive },
    { label: "wrong array shape or element", value: wrongArray },
    { label: "object where a scalar or array is expected", value: {} },
    { label: "empty string", value: "" },
    ...(definition.kind === "non_empty_string_array"
      ? [{ label: "array containing an empty string", value: [""] }]
      : []),
  ];
}

test("rejects the schema-derived known-key by wrong-type matrix", () => {
  const failures: string[] = [];

  for (const [key, definition] of Object.entries(CONFIG_FIELD_SCHEMA)) {
    for (const { label, value } of invalidValuesForConfigField(definition)) {
      try {
        validateConfig({ [key]: value }, "cfg");
        failures.push(`${key} accepted ${label}`);
      } catch (error) {
        const message = (error as Error).message;
        if (!message.includes(`"${key}"`)) {
          failures.push(`${key} ${label} error omitted the key: ${message}`);
        }
        if (!message.includes(definition.expected)) {
          failures.push(
            `${key} ${label} error omitted expected type "${definition.expected}": ${message}`,
          );
        }
      }
    }
  }

  assert.deepEqual(failures, []);
});

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

test("rejects allowedOrigin typo and names allowed_origins", () => {
  assert.throws(
    () => validateConfig({ allowedOrigin: ["https://auth.example.com"] }, "cfg"),
    /"allowedOrigin".*"allowed_origins"/s,
  );
});

test("rejects a correctly named config key with the wrong type", () => {
  assert.throws(
    () => validateConfig({ max_output_tokens: "64000" }, "cfg"),
    /"max_output_tokens".*positive integer.*string/s,
  );
});

test("rejects scalar allowed_origins instead of a list", () => {
  assert.throws(
    () => validateConfig({ allowed_origins: "https://auth.example.com" }, "cfg"),
    /"allowed_origins" must be a list of non-empty strings.*string/s,
  );
});

test("rejects documented but unsupported browser selection", () => {
  assert.throws(
    () => validateConfig({ browser: "firefox" }, "cfg"),
    /"browser".*unsupported.*Chromium/s,
  );
});

test("accepts every supported documented config key", () => {
  const c = validateConfig(
    {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      api_key: "test-only",
      report_dir: "./reports",
      screenshot_dir: "./screenshots",
      max_iterations: 25,
      timeout_ms: 60_000,
      request_timeout_ms: 30_000,
      max_input_tokens: 50_000,
      max_output_tokens: 10_000,
      allowed_origins: ["https://auth.example.com"],
    },
    "cfg",
  );
  assert.equal(c.max_output_tokens, 10_000);
  assert.deepEqual(c.allowed_origins, ["https://auth.example.com"]);
});

test("gitignore protects every supported credential config filename", () => {
  const filenames = [
    ".persona-testing.yml",
    ".persona-testing.yaml",
    "persona-testing.yml",
    "persona-testing.yaml",
    ".persona-testing.local.yml",
    ".persona-testing.local.yaml",
    "persona-testing.local.yml",
    "persona-testing.local.yaml",
  ];

  for (const filename of filenames) {
    try {
      const proof = execFileSync("git", ["check-ignore", "-v", filename], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      assert.match(proof, new RegExp(`${filename.replaceAll(".", "\\.")}$`, "m"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;

      // The managed workspace sandbox blocks child_process. Keep the real Git
      // assertion above for CI, and use exact-rule verification only for that
      // environment; the commission report also records direct shell proof.
      const rules = new Set(
        readFileSync(".gitignore", "utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      );
      assert.ok(rules.has(filename), `.gitignore is missing exact rule ${filename}`);
    }
  }
});

test("OIDC publish job uses pinned preinstalled npm without registry installation", () => {
  const workflow = readFileSync(".github/workflows/publish.yml", "utf8");
  const publishJob = workflow.slice(workflow.indexOf("  publish:"));

  assert.doesNotMatch(publishJob, /npm\s+(?:install|ci|update|exec|i)\b/);
  assert.match(publishJob, /node-version:\s*'24\.14\.0'/);
  assert.match(publishJob, /test "\$\(npm --version\)" = "11\.9\.0"/);
  assert.match(publishJob, /npm publish \.\/persona-testing-\*\.tgz --provenance --access public/);
});

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed.\n");
}
