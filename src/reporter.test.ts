/**
 * Reporter tests — collision-resistant identities and fail-closed writes.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  preflightPersonaIdentities,
  saveReport,
  slugify,
  writeManifest,
} from "./reporter.js";
import type { ProbeResult } from "./schema.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${(error as Error).message}`);
  }
}

function result(persona: string, readiness: number, critical: boolean): ProbeResult {
  return {
    persona,
    timestamp: "2026-08-23T00:00:00.000Z",
    url: "https://app.example.com",
    readiness_pct: readiness,
    critical_bugs: critical,
    criteria: {},
    items: [],
    screenshots: [],
    report_markdown: "## Structured Assessment\n",
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "persona-reporter-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\nReporter Tests\n");

test("colliding lossy slugs preserve the first failing and second passing report", () => {
  withTempDir((dir) => {
    const runId = "collision-run";
    const first = saveReport(result("QA User", 10, true), dir, runId);
    const second = saveReport(result("QA_User", 95, false), dir, runId);

    assert.notEqual(first.jsonPath, second.jsonPath);
    const firstJson = JSON.parse(readFileSync(first.jsonPath, "utf8"));
    const secondJson = JSON.parse(readFileSync(second.jsonPath, "utf8"));
    assert.equal(firstJson.readiness_pct, 10);
    assert.equal(firstJson.critical_bugs, true);
    assert.equal(secondJson.readiness_pct, 95);
    assert.equal(secondJson.critical_bugs, false);

    const manifestPath = writeManifest(
      dir,
      runId,
      "https://app.example.com",
      [first.jsonPath, second.jsonPath],
      2,
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.requested_personas, 2);
    assert.equal(manifest.reports_written, 2);
    assert.equal(new Set(manifest.reports).size, 2);
  });
});

test("distinct non-Latin names receive distinct non-empty identities", () => {
  const first = slugify("测试员");
  const second = slugify("审计员");
  assert.ok(first.length > 0);
  assert.ok(second.length > 0);
  assert.notEqual(first, second);
});

test("a name that previously slugified to empty receives a safe fallback", () => {
  assert.match(slugify("🧪"), /^persona-/);
});

test("preflight rejects duplicate normalized identities and names both inputs", () => {
  assert.throws(
    () =>
      preflightPersonaIdentities([
        { name: "Same Name", source: "personas/first.yml" },
        { name: "Same Name", source: "personas/second.yml" },
      ]),
    (error: unknown) => {
      const message = (error as Error).message;
      return message.includes("personas/first.yml") && message.includes("personas/second.yml");
    },
  );
});

test("report creation refuses to overwrite an existing same-run path", () => {
  withTempDir((dir) => {
    const probe = result("Duplicate", 20, true);
    const first = saveReport(probe, dir, "same-run");
    assert.ok(existsSync(first.jsonPath));
    assert.throws(
      () => saveReport(probe, dir, "same-run"),
      /already exists|exclusive|collision/i,
    );
    const persisted = JSON.parse(readFileSync(first.jsonPath, "utf8"));
    assert.equal(persisted.readiness_pct, 20);
    assert.equal(persisted.critical_bugs, true);
  });
});

test("manifest reconciliation rejects duplicate report paths", () => {
  withTempDir((dir) => {
    const saved = saveReport(result("One", 80, false), dir, "manifest-run");
    assert.throws(
      () =>
        writeManifest(
          dir,
          "manifest-run",
          "https://app.example.com",
          [saved.jsonPath, saved.jsonPath],
          2,
        ),
      /duplicate|unique|count/i,
    );
  });
});

test("manifest reconciliation rejects requested/report count mismatches", () => {
  withTempDir((dir) => {
    const saved = saveReport(result("Only One", 80, false), dir, "count-run");
    assert.throws(
      () =>
        writeManifest(
          dir,
          "count-run",
          "https://app.example.com",
          [saved.jsonPath],
          2,
        ),
      /requested 2.*found 1|count/i,
    );
  });
});

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("All tests passed.\n");
}
