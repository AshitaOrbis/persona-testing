/**
 * Report writer — saves ProbeResult as JSON and markdown files.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { ProbeResult } from "./schema.js";

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
 * Save a ProbeResult to disk as JSON and markdown.
 *
 * Returns { jsonPath, mdPath } of the written files.
 */
export function saveReport(
  result: ProbeResult,
  reportDir: string,
): { jsonPath: string; mdPath: string } {
  mkdirSync(reportDir, { recursive: true });

  const slug = slugify(result.persona);
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const baseName = `${slug}-${date}`;

  const jsonPath = join(reportDir, `${baseName}.json`);
  const mdPath = join(reportDir, `${baseName}.md`);

  // JSON report (structured data for CI/CD)
  const jsonData = { ...result };
  delete (jsonData as any).report_markdown; // Don't duplicate markdown in JSON
  writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2) + "\n");

  // Markdown report (human-readable)
  const md = buildMarkdownReport(result);
  writeFileSync(mdPath, md);

  return { jsonPath, mdPath };
}

function buildMarkdownReport(result: ProbeResult): string {
  const sections: string[] = [];

  sections.push(`# Persona Test: ${result.persona}`);
  sections.push(`**Date:** ${result.timestamp}`);
  sections.push(`**URL:** ${result.url}`);
  sections.push(`**Readiness:** ${result.readiness_pct}%`);
  sections.push(`**Critical Bugs:** ${result.critical_bugs ? "YES" : "None"}`);

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
