/**
 * Runtime validation for persona and config files.
 *
 * YAML is untrusted input: `parseYaml(...) as PersonaDefinition` provides no
 * runtime guarantees. These validators fail fast with actionable errors
 * before any browser or model call is made.
 */

import { CONFIG_FIELD_SCHEMA } from "./schema.js";
import type {
  PersonaDefinition,
  ProbeConfig,
  EvaluationCriterion,
  Scenario,
} from "./schema.js";

const WEIGHTS = new Set(["critical", "high", "medium", "low"]);
const PERSONA_KEYS = new Set([
  "name",
  "title",
  "experience",
  "technical_comfort",
  "context",
  "goals",
  "scenarios",
  "evaluation_criteria",
  "voice",
  "known_routes",
  "critical_bug_protocol",
]);
const SCENARIO_KEYS = new Set(["name", "description", "success"]);
const CRITERION_KEYS = new Set(["name", "weight", "question"]);
const BUG_PROTOCOL_KEYS = new Set(["stop_on", "continue_on"]);
const CONFIG_KEYS = new Set(Object.keys(CONFIG_FIELD_SCHEMA));
type ConfigKey = keyof typeof CONFIG_FIELD_SCHEMA;

export type PersonaValidationMode = "gate" | "exploratory";
export const GATE_PERSONA_MIN_INSTRUCTION_CHARS = 20;

class ValidationErrors {
  errors: string[] = [];
  constructor(private source: string) {}
  add(msg: string) {
    this.errors.push(msg);
  }
  throwIfAny(): void {
    if (this.errors.length > 0) {
      throw new Error(
        `Invalid ${this.source}:\n  - ${this.errors.join("\n  - ")}`,
      );
    }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

function nearestKey(key: string, allowed: Set<string>): string {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return [...allowed].reduce((best, candidate) => {
    const candidateNormalized = candidate.toLowerCase().replace(/[^a-z0-9]/g, "");
    return levenshtein(normalized, candidateNormalized) <
      levenshtein(normalized, best.toLowerCase().replace(/[^a-z0-9]/g, ""))
      ? candidate
      : best;
  });
}

function rejectUnknownKeys(
  data: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  errs: ValidationErrors,
): void {
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      errs.add(
        `unknown key "${path}${key}"; did you mean "${path}${nearestKey(key, allowed)}"?`,
      );
    }
  }
}

function asString(v: unknown, field: string, errs: ValidationErrors, fallback = ""): string {
  if (v === undefined) return fallback;
  if (typeof v !== "string") {
    errs.add(
      `"${field}" must be a string (got ${v === null ? "null" : Array.isArray(v) ? "array" : typeof v})`,
    );
    return fallback;
  }
  return v;
}

function asStringArray(
  v: unknown,
  field: string,
  errs: ValidationErrors,
  allowScalar = false,
): string[] {
  if (v === undefined) return [];
  if (allowScalar && typeof v === "string") return [v];
  if (!Array.isArray(v)) {
    errs.add(
      `"${field}" must be a list of strings (got ${v === null ? "null" : typeof v})`,
    );
    return [];
  }
  const out: string[] = [];
  v.forEach((item, i) => {
    if (typeof item === "string") out.push(item);
    else errs.add(`"${field}[${i}]" must be a string`);
  });
  return out;
}

export function validatePersona(
  data: unknown,
  source: string,
  mode: PersonaValidationMode = "gate",
): PersonaDefinition {
  const errs = new ValidationErrors(`persona file ${source}`);

  if (!isRecord(data)) {
    throw new Error(`Invalid persona file ${source}: expected a YAML mapping at top level`);
  }

  rejectUnknownKeys(data, PERSONA_KEYS, "", errs);

  const name = asString(data.name, "name", errs);
  if (!name.trim()) errs.add(`"name" is required and must be a non-empty string`);

  const scenarios: Scenario[] = [];
  if (data.scenarios !== undefined && data.scenarios !== null) {
    if (!Array.isArray(data.scenarios)) {
      errs.add(`"scenarios" must be a list`);
    } else {
      data.scenarios.forEach((s, i) => {
        if (!isRecord(s)) {
          errs.add(`"scenarios[${i}]" must be a mapping with name/description/success`);
          return;
        }
        rejectUnknownKeys(s, SCENARIO_KEYS, `scenarios[${i}].`, errs);
        const scenarioName = asString(s.name, `scenarios[${i}].name`, errs);
        const description = asString(s.description, `scenarios[${i}].description`, errs);
        const success = asString(s.success, `scenarios[${i}].success`, errs);
        if (!scenarioName.trim()) errs.add(`"scenarios[${i}].name" must be non-empty`);
        if (!description.trim()) errs.add(`"scenarios[${i}].description" must be non-empty`);
        if (!success.trim()) errs.add(`"scenarios[${i}].success" must be non-empty`);
        scenarios.push({
          name: scenarioName,
          description,
          success,
        });
      });
    }
  }

  const criteria: EvaluationCriterion[] = [];
  if (data.evaluation_criteria !== undefined && data.evaluation_criteria !== null) {
    if (!Array.isArray(data.evaluation_criteria)) {
      errs.add(`"evaluation_criteria" must be a list`);
    } else {
      data.evaluation_criteria.forEach((c, i) => {
        if (!isRecord(c)) {
          errs.add(`"evaluation_criteria[${i}]" must be a mapping with name/weight/question`);
          return;
        }
        rejectUnknownKeys(c, CRITERION_KEYS, `evaluation_criteria[${i}].`, errs);
        const criterionName = asString(c.name, `evaluation_criteria[${i}].name`, errs);
        const weight = asString(c.weight, `evaluation_criteria[${i}].weight`, errs);
        const question = asString(c.question, `evaluation_criteria[${i}].question`, errs);
        if (!criterionName.trim()) {
          errs.add(`"evaluation_criteria[${i}].name" must be non-empty`);
        }
        if (!question.trim()) {
          errs.add(`"evaluation_criteria[${i}].question" must be non-empty`);
        }
        if (!WEIGHTS.has(weight)) {
          errs.add(
            `"evaluation_criteria[${i}].weight" must be one of critical|high|medium|low (got "${weight}")`,
          );
        }
        criteria.push({
          name: criterionName,
          weight: (WEIGHTS.has(weight) ? weight : "medium") as EvaluationCriterion["weight"],
          question,
        });
      });
    }
  }

  let knownRoutes: Record<string, string> | undefined;
  if (data.known_routes !== undefined && data.known_routes !== null) {
    if (!isRecord(data.known_routes)) {
      errs.add(`"known_routes" must be a mapping of label -> path`);
    } else {
      knownRoutes = {};
      for (const [k, v] of Object.entries(data.known_routes)) {
        if (typeof v === "string") knownRoutes[k] = v;
        else errs.add(`"known_routes.${k}" must be a string path`);
      }
    }
  }

  let bugProtocol: PersonaDefinition["critical_bug_protocol"];
  if (data.critical_bug_protocol !== undefined && data.critical_bug_protocol !== null) {
    if (!isRecord(data.critical_bug_protocol)) {
      errs.add(`"critical_bug_protocol" must be a mapping with stop_on/continue_on`);
    } else {
      rejectUnknownKeys(data.critical_bug_protocol, BUG_PROTOCOL_KEYS, "critical_bug_protocol.", errs);
      bugProtocol = {
        stop_on: asStringArray(
          data.critical_bug_protocol.stop_on,
          "critical_bug_protocol.stop_on",
          errs,
          true,
        ),
        continue_on: asStringArray(
          data.critical_bug_protocol.continue_on,
          "critical_bug_protocol.continue_on",
          errs,
          true,
        ),
      };
    }
  }

  const persona: PersonaDefinition = {
    name,
    title: asString(data.title, "title", errs),
    experience: asString(data.experience, "experience", errs),
    technical_comfort: asString(data.technical_comfort, "technical_comfort", errs),
    context: asString(data.context, "context", errs),
    goals: asStringArray(data.goals, "goals", errs),
    scenarios,
    evaluation_criteria: criteria,
    voice: asString(data.voice, "voice", errs),
    known_routes: knownRoutes,
    critical_bug_protocol: bugProtocol,
  };

  if (mode === "gate") {
    const instructionText = [persona.context, ...persona.goals]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ");
    if (instructionText.length < GATE_PERSONA_MIN_INSTRUCTION_CHARS) {
      errs.add(
        `gate-capable personas require at least ${GATE_PERSONA_MIN_INSTRUCTION_CHARS} characters of context/goal instructions`,
      );
    }
    if (persona.scenarios.length === 0) {
      errs.add(`gate-capable personas require at least one non-empty scenario`);
    }
    if (persona.evaluation_criteria.length === 0) {
      errs.add(`gate-capable personas require at least one non-empty evaluation criterion`);
    }
  }

  errs.throwIfAny();
  return persona;
}

function describeValue(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "string" && !v.trim()) return "empty string";
  return typeof v;
}

function validateConfigField(
  key: ConfigKey,
  value: unknown,
  errs: ValidationErrors,
): unknown {
  const definition = CONFIG_FIELD_SCHEMA[key];
  const reject = (detail = `got ${describeValue(value)}`): undefined => {
    errs.add(`"${key}" must be ${definition.expected} (${detail})`);
    return undefined;
  };

  switch (definition.kind) {
    case "enum":
      return typeof value === "string" &&
        definition.values.some((candidate) => candidate === value)
        ? value
        : reject();
    case "non_empty_string":
      return typeof value === "string" && value.trim() ? value : reject();
    case "positive_integer":
      return typeof value === "number" && Number.isInteger(value) && value > 0
        ? value
        : reject();
    case "non_empty_string_array": {
      if (!Array.isArray(value)) return reject();
      const invalidIndex = value.findIndex(
        (item) => typeof item !== "string" || !item.trim(),
      );
      return invalidIndex === -1
        ? value
        : reject(`item ${invalidIndex} got ${describeValue(value[invalidIndex])}`);
    }
  }
}

export function validateConfig(data: unknown, source: string): ProbeConfig {
  const errs = new ValidationErrors(`config ${source}`);

  if (!isRecord(data)) {
    throw new Error(`Invalid config ${source}: expected a YAML mapping at top level`);
  }

  for (const key of Object.keys(data)) {
    if (key === "browser") {
      errs.add(`"browser" is unsupported; persona-testing currently launches Chromium only`);
    } else if (!CONFIG_KEYS.has(key)) {
      errs.add(`unknown key "${key}"; did you mean "${nearestKey(key, CONFIG_KEYS)}"?`);
    }
  }

  const field = (key: ConfigKey): unknown =>
    Object.hasOwn(data, key) ? validateConfigField(key, data[key], errs) : undefined;

  const provider = field("provider");

  const config: ProbeConfig = {
    provider: (provider ?? "anthropic") as ProbeConfig["provider"],
    model: field("model") as string | undefined,
    api_key: field("api_key") as string | undefined,
    report_dir: (field("report_dir") as string | undefined) ?? "./reports",
    screenshot_dir:
      (field("screenshot_dir") as string | undefined) ?? "./screenshots",
    max_iterations: field("max_iterations") as number | undefined,
    timeout_ms: field("timeout_ms") as number | undefined,
    request_timeout_ms: field("request_timeout_ms") as number | undefined,
    max_input_tokens: field("max_input_tokens") as number | undefined,
    max_output_tokens: field("max_output_tokens") as number | undefined,
    allowed_origins: field("allowed_origins") as string[] | undefined,
  };

  errs.throwIfAny();
  return config;
}
