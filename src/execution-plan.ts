import { Type } from "typebox";

export const MAX_EXECUTION_PHASES = 30;

export type ExecutionPhaseKind = "analysis" | "implementation" | "validation" | "review";

export interface ExecutionPhase {
  id: string;
  title: string;
  objective: string;
  dependsOn: string[];
  kind: ExecutionPhaseKind;
  scope: string[];
  acceptanceCriteria: string[];
}

export interface ExecutionPlan {
  phases: ExecutionPhase[];
}

export interface ExecutionPlanValidationResult {
  valid: boolean;
  errors: string[];
}

const nonEmptyString = Type.String({ minLength: 1 });
const STABLE_PHASE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const stablePhaseKey = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" });
const phaseKind = Type.String({ pattern: "^(analysis|implementation|validation|review)$" });

export const grillPrepareExecutionPlanSchema = Type.Object(
  {
    phases: Type.Array(
      Type.Object(
        {
          id: stablePhaseKey,
          title: nonEmptyString,
          objective: nonEmptyString,
          dependsOn: Type.Array(stablePhaseKey, { uniqueItems: true }),
          kind: phaseKind,
          scope: Type.Array(nonEmptyString, { minItems: 1 }),
          acceptanceCriteria: Type.Array(nonEmptyString, { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_EXECUTION_PHASES },
    ),
  },
  { additionalProperties: false },
);

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function validateStringArray(value: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  if (value.length === 0) errors.push(`${path} must not be empty`);
  const result: string[] = [];
  value.forEach((item, index) => {
    const text = normalized(item);
    if (!text) errors.push(`${path}[${index}] must be a non-empty string`);
    else result.push(text);
  });
  return result;
}

/** Validate a data-only dependency DAG. Raw workflow code is never accepted. */
export function validateExecutionPlan(value: unknown): ExecutionPlanValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { valid: false, errors: ["Execution plan must be an object"] };
  }
  const topLevelKeys = Object.keys(value);
  for (const key of topLevelKeys) {
    if (key !== "phases") errors.push(`Execution plan contains unknown property ${key}`);
  }
  const rawPhases = (value as { phases?: unknown }).phases;
  if (!Array.isArray(rawPhases)) return { valid: false, errors: ["phases must be an array"] };
  if (rawPhases.length === 0) errors.push("phases must not be empty");
  if (rawPhases.length > MAX_EXECUTION_PHASES) errors.push(`phases exceeds maximum of ${MAX_EXECUTION_PHASES}`);

  const ids = new Set<string>();
  const phases: ExecutionPhase[] = [];
  rawPhases.forEach((candidate, index) => {
    const path = `phases[${index}]`;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      errors.push(`${path} must be an object`);
      return;
    }
    const allowedKeys = new Set([
      "id", "title", "objective", "dependsOn", "kind", "scope", "acceptanceCriteria",
    ]);
    for (const key of Object.keys(candidate)) {
      if (!allowedKeys.has(key)) errors.push(`${path} contains unknown property ${key}`);
    }
    const phase = candidate as Partial<ExecutionPhase>;
    const id = typeof phase.id === "string" ? phase.id : "";
    if (!STABLE_PHASE_KEY_PATTERN.test(id)) errors.push(`${path}.id must be a valid stable phase key`);
    else if (ids.has(id)) errors.push(`${path}.id duplicates ${id}`);
    else ids.add(id);
    if (!normalized(phase.title)) errors.push(`${path}.title must be a non-empty string`);
    if (!normalized(phase.objective)) errors.push(`${path}.objective must be a non-empty string`);
    const kinds = new Set<ExecutionPhaseKind>(["analysis", "implementation", "validation", "review"]);
    if (!phase.kind || !kinds.has(phase.kind)) errors.push(`${path}.kind is invalid`);
    const dependsOn = validateDependencies(phase.dependsOn, `${path}.dependsOn`, errors);
    validateStringArray(phase.scope, `${path}.scope`, errors);
    validateStringArray(phase.acceptanceCriteria, `${path}.acceptanceCriteria`, errors);
    if (STABLE_PHASE_KEY_PATTERN.test(id) && phase.kind && kinds.has(phase.kind)) {
      phases.push({
        id,
        title: typeof phase.title === "string" ? phase.title : "",
        objective: typeof phase.objective === "string" ? phase.objective : "",
        dependsOn,
        kind: phase.kind,
        scope: Array.isArray(phase.scope) ? phase.scope.filter((item): item is string => typeof item === "string") : [],
        acceptanceCriteria: Array.isArray(phase.acceptanceCriteria)
          ? phase.acceptanceCriteria.filter((item): item is string => typeof item === "string")
          : [],
      });
    }
  });

  const graph = new Map(phases.map((phase) => [phase.id, phase.dependsOn]));
  for (const [index, phase] of phases.entries()) {
    for (const dependency of phase.dependsOn) {
      if (dependency === phase.id) errors.push(`phases[${index}].dependsOn cannot reference itself`);
      else if (!ids.has(dependency)) errors.push(`phases[${index}].dependsOn references unknown phase ${dependency}`);
    }
  }

  const roots = phases.filter((phase) => phase.dependsOn.length === 0);
  if (phases.length > 0 && roots.length === 0) errors.push("Execution plan must contain at least one root phase");

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function hasCycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) {
      if (graph.has(dependency) && hasCycle(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  if ([...graph.keys()].some(hasCycle)) errors.push("Execution phase dependencies contain a cycle");

  const dependents = new Map<string, string[]>();
  for (const phase of phases) {
    for (const dependency of phase.dependsOn) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), phase.id]);
    }
  }
  const reachable = new Set<string>();
  const stack = roots.map((phase) => phase.id);
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    stack.push(...(dependents.get(id) ?? []));
  }
  for (const phase of phases) {
    if (!reachable.has(phase.id)) errors.push(`phase ${phase.id} is not reachable from a root phase`);
  }

  const implementationPhases = phases.filter((phase) => phase.kind === "implementation");
  if (phases.length > 0 && implementationPhases.length === 0) errors.push("Execution plan must contain an implementation phase");
  const finalVerification = phases.filter(
    (phase) => (phase.kind === "validation" || phase.kind === "review") && (dependents.get(phase.id)?.length ?? 0) === 0,
  );
  for (const implementation of implementationPhases) {
    const covered = finalVerification.some((verification) => isAncestor(implementation.id, verification.id, graph));
    if (!covered) errors.push(`implementation phase ${implementation.id} lacks final validation/review coverage`);
  }

  return { valid: errors.length === 0, errors };
}

function validateDependencies(value: unknown, path: string, errors: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    if (typeof item !== "string" || !STABLE_PHASE_KEY_PATTERN.test(item)) {
      errors.push(`${path}[${index}] must be a valid stable phase key`);
      return;
    }
    if (seen.has(item)) errors.push(`${path}[${index}] duplicates dependency ${item}`);
    else seen.add(item);
    result.push(item);
  });
  return result;
}

function isAncestor(ancestor: string, descendant: string, graph: Map<string, string[]>): boolean {
  const seen = new Set<string>();
  const stack = [...(graph.get(descendant) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (id === ancestor) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(graph.get(id) ?? []));
  }
  return false;
}

export function executionPlanLines(plan: ExecutionPlan): string[] {
  return plan.phases.flatMap((phase, index) => [
    `${index + 1}. [${phase.kind}] ${phase.title} (${phase.id})`,
    `   Objective: ${phase.objective}`,
    `   Depends on: ${phase.dependsOn.length > 0 ? phase.dependsOn.join(", ") : "none"}`,
    `   Scope: ${phase.scope.join(", ")}`,
    `   Acceptance: ${phase.acceptanceCriteria.join("; ")}`,
  ]);
}
