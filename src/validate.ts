/**
 * Runtime validation for persona and config files.
 *
 * YAML is untrusted input: `parseYaml(...) as PersonaDefinition` provides no
 * runtime guarantees. These validators fail fast with actionable errors
 * before any browser or model call is made.
 */

import type {
  PersonaDefinition,
  ProbeConfig,
  EvaluationCriterion,
  Scenario,
} from "./schema.js";

const WEIGHTS = new Set(["critical", "high", "medium", "low"]);
const PROVIDERS = new Set(["anthropic", "openai"]);

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

function asString(v: unknown, field: string, errs: ValidationErrors, fallback = ""): string {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string") {
    errs.add(`"${field}" must be a string (got ${Array.isArray(v) ? "array" : typeof v})`);
    return fallback;
  }
  return v;
}

function asStringArray(v: unknown, field: string, errs: ValidationErrors): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return [v]; // tolerate single scalar
  if (!Array.isArray(v)) {
    errs.add(`"${field}" must be a list of strings`);
    return [];
  }
  const out: string[] = [];
  v.forEach((item, i) => {
    if (typeof item === "string") out.push(item);
    else errs.add(`"${field}[${i}]" must be a string`);
  });
  return out;
}

export function validatePersona(data: unknown, source: string): PersonaDefinition {
  const errs = new ValidationErrors(`persona file ${source}`);

  if (!isRecord(data)) {
    throw new Error(`Invalid persona file ${source}: expected a YAML mapping at top level`);
  }

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
        scenarios.push({
          name: asString(s.name, `scenarios[${i}].name`, errs),
          description: asString(s.description, `scenarios[${i}].description`, errs),
          success: asString(s.success, `scenarios[${i}].success`, errs),
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
        const weight = asString(c.weight, `evaluation_criteria[${i}].weight`, errs, "medium");
        if (!WEIGHTS.has(weight)) {
          errs.add(
            `"evaluation_criteria[${i}].weight" must be one of critical|high|medium|low (got "${weight}")`,
          );
        }
        criteria.push({
          name: asString(c.name, `evaluation_criteria[${i}].name`, errs),
          weight: (WEIGHTS.has(weight) ? weight : "medium") as EvaluationCriterion["weight"],
          question: asString(c.question, `evaluation_criteria[${i}].question`, errs),
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
      bugProtocol = {
        stop_on: asStringArray(data.critical_bug_protocol.stop_on, "critical_bug_protocol.stop_on", errs),
        continue_on: asStringArray(
          data.critical_bug_protocol.continue_on,
          "critical_bug_protocol.continue_on",
          errs,
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

  errs.throwIfAny();
  return persona;
}

function asOptionalPositiveInt(
  v: unknown,
  field: string,
  errs: ValidationErrors,
): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
    errs.add(`"${field}" must be a positive integer`);
    return undefined;
  }
  return n;
}

export function validateConfig(data: unknown, source: string): ProbeConfig {
  const errs = new ValidationErrors(`config ${source}`);

  if (!isRecord(data)) {
    throw new Error(`Invalid config ${source}: expected a YAML mapping at top level`);
  }

  const provider = asString(data.provider, "provider", errs, "anthropic");
  if (!PROVIDERS.has(provider)) {
    errs.add(`"provider" must be "anthropic" or "openai" (got "${provider}")`);
  }

  const config: ProbeConfig = {
    provider: (PROVIDERS.has(provider) ? provider : "anthropic") as ProbeConfig["provider"],
    model: data.model === undefined || data.model === null ? undefined : asString(data.model, "model", errs) || undefined,
    api_key: data.api_key === undefined || data.api_key === null ? undefined : asString(data.api_key, "api_key", errs) || undefined,
    report_dir: asString(data.report_dir, "report_dir", errs, "./reports") || "./reports",
    screenshot_dir: asString(data.screenshot_dir, "screenshot_dir", errs, "./screenshots") || "./screenshots",
    max_iterations: asOptionalPositiveInt(data.max_iterations, "max_iterations", errs),
    timeout_ms: asOptionalPositiveInt(data.timeout_ms, "timeout_ms", errs),
    request_timeout_ms: asOptionalPositiveInt(data.request_timeout_ms, "request_timeout_ms", errs),
    max_input_tokens: asOptionalPositiveInt(data.max_input_tokens, "max_input_tokens", errs),
    max_output_tokens: asOptionalPositiveInt(data.max_output_tokens, "max_output_tokens", errs),
    allowed_origins: asStringArray(data.allowed_origins, "allowed_origins", errs),
  };

  errs.throwIfAny();
  return config;
}
