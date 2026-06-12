/**
 * Report writer — saves ProbeResult as JSON and markdown files.
 *
 * Filenames embed a unique run ID (timestamp + random suffix) so repeated
 * runs never overwrite earlier reports. Each `run` invocation also writes a
 * run manifest that `check` consumes, so stale reports from previous runs
 * cannot leak into a CI gate.
 */

import { writeFileSync, mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { join, basename } from "path";
import type { ProbeResult, RunManifest } from "./schema.js";

export const MANIFEST_FILENAME = "run-manifest.json";

/**
 * Slugify a persona name for use in filenames.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Generate a unique run ID: full UTC timestamp + random suffix.
 * Example: 2026-06-11T18-42-31-123Z-a8f3
 */
export function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = randomBytes(2).toString("hex");
  return `${ts}-${rand}`;
}

/**
 * Save a ProbeResult to disk as JSON and markdown.
 *
 * Returns { jsonPath, mdPath } of the written files.
 */
export function saveReport(
  result: ProbeResult,
  reportDir: string,
  runId: string,
): { jsonPath: string; mdPath: string } {
  mkdirSync(reportDir, { recursive: true });

  const slug = slugify(result.persona);
  const baseName = `${slug}-${runId}`;

  const jsonPath = join(reportDir, `${baseName}.json`);
  const mdPath = join(reportDir, `${baseName}.md`);

  // JSON report (structured data for CI/CD)
  const jsonData = { ...result, run_id: runId };
  delete (jsonData as any).report_markdown; // Don't duplicate markdown in JSON
  writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2) + "\n");

  // Markdown report (human-readable)
  const md = buildMarkdownReport(result);
  writeFileSync(mdPath, md);

  return { jsonPath, mdPath };
}

/**
 * Write the run manifest listing every JSON report produced by this run.
 * `check` reads this by default instead of globbing the directory.
 */
export function writeManifest(
  reportDir: string,
  runId: string,
  url: string,
  jsonPaths: string[],
): string {
  mkdirSync(reportDir, { recursive: true });
  const manifest: RunManifest = {
    run_id: runId,
    created: new Date().toISOString(),
    url,
    reports: jsonPaths.map((p) => basename(p)),
  };
  const manifestPath = join(reportDir, MANIFEST_FILENAME);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifestPath;
}

function buildMarkdownReport(result: ProbeResult): string {
  const sections: string[] = [];

  sections.push(`# Persona Test: ${result.persona}`);
  sections.push(`**Date:** ${result.timestamp}`);
  sections.push(`**URL:** ${result.url}`);
  sections.push(`**Readiness:** ${result.readiness_pct}%`);
  sections.push(`**Critical Bugs:** ${result.critical_bugs ? "YES" : "None"}`);

  if (result.parse_errors?.length) {
    sections.push(`**Parse warnings:** ${result.parse_errors.join("; ")}`);
  }

  if (result.tool_stats) {
    const s = result.tool_stats;
    sections.push(
      `**Tool calls:** ${s.total_calls} (${s.errors} errors, ` +
        `${s.policy_blocks} policy blocks, ${s.navigation_failures} navigation failures)`,
    );
  }

  // Criteria table
  if (Object.keys(result.criteria).length > 0) {
    const rows = Object.entries(result.criteria)
      .map(([name, verdict]) => `| ${name} | ${verdict} |`)
      .join("\n");
    sections.push(`\n## Criteria Verdicts\n\n| Criterion | Verdict |\n|-----------|---------|
${rows}`);
  }

  // Actionable items
  if (result.items.length > 0) {
    const itemLines = result.items
      .map(
        (item, i) =>
          `${i + 1}. **[${item.classification}]** (${item.priority}) ${item.description}`,
      )
      .join("\n");
    sections.push(`\n## Actionable Items\n\n${itemLines}`);
  }

  // Screenshots
  if (result.screenshots.length > 0) {
    const screenshotLines = result.screenshots
      .map((s) => `- ${s}`)
      .join("\n");
    sections.push(`\n## Screenshots\n\n${screenshotLines}`);
  }

  // Full AI narrative
  if (result.report_markdown) {
    sections.push(`\n---\n\n## Full AI Report\n\n${result.report_markdown}`);
  }

  return sections.join("\n") + "\n";
}
