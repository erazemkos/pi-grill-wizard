import assert from "node:assert/strict";
import test from "node:test";
import { MAX_EXECUTION_PHASES, validateExecutionPlan } from "../src/execution-plan.ts";
import { makeExecutionPlan } from "./fixtures.ts";

test("validates a dependency-aware execution plan", () => {
  assert.deepEqual(validateExecutionPlan(makeExecutionPlan()), { valid: true, errors: [] });
});

test("rejects duplicate, unknown, and self dependencies", () => {
  const duplicate = makeExecutionPlan();
  duplicate.phases[1]!.id = "analyze";
  assert.match(validateExecutionPlan(duplicate).errors.join("\n"), /duplicates/);

  const duplicateDependency = makeExecutionPlan();
  duplicateDependency.phases[1]!.dependsOn = ["analyze", "analyze"];
  assert.match(validateExecutionPlan(duplicateDependency).errors.join("\n"), /duplicates dependency analyze/);

  const unknown = makeExecutionPlan();
  unknown.phases[1]!.dependsOn = ["missing"];
  assert.match(validateExecutionPlan(unknown).errors.join("\n"), /unknown phase missing/);

  const self = makeExecutionPlan();
  self.phases[1]!.dependsOn = ["implement"];
  assert.match(validateExecutionPlan(self).errors.join("\n"), /cannot reference itself/);
});

test("requires canonical stable phase keys and exact case-sensitive dependencies", () => {
  for (const invalidId of [" phase", "phase two", "phase/three", "", "x".repeat(129)]) {
    const plan = makeExecutionPlan();
    plan.phases[0]!.id = invalidId;
    assert.match(validateExecutionPlan(plan).errors.join("\n"), /valid stable phase key/);
  }

  const caseMismatch = makeExecutionPlan();
  caseMismatch.phases[0]!.id = "Analyze";
  assert.match(validateExecutionPlan(caseMismatch).errors.join("\n"), /unknown phase analyze/);

  const invalidDependency = makeExecutionPlan();
  invalidDependency.phases[1]!.dependsOn = [" analyze"];
  assert.match(validateExecutionPlan(invalidDependency).errors.join("\n"), /valid stable phase key/);
});

test("validator rejects extra top-level and phase properties", () => {
  const topLevel = { ...makeExecutionPlan(), workflowScript: "return runs;" };
  assert.match(validateExecutionPlan(topLevel).errors.join("\n"), /unknown property workflowScript/);

  const phaseProperty = makeExecutionPlan() as unknown as { phases: Array<Record<string, unknown>> };
  phaseProperty.phases[0]!.workflowScript = "return runs;";
  assert.match(validateExecutionPlan(phaseProperty).errors.join("\n"), /phases\[0\] contains unknown property workflowScript/);
});

test("rejects cycles and phases unreachable from roots", () => {
  const plan = makeExecutionPlan();
  plan.phases.push({
    id: "cycle-a",
    title: "Cycle A",
    objective: "Invalid cycle node.",
    dependsOn: ["cycle-b"],
    kind: "analysis",
    scope: ["src"],
    acceptanceCriteria: ["Never accepted"],
  });
  plan.phases.push({
    id: "cycle-b",
    title: "Cycle B",
    objective: "Invalid cycle node.",
    dependsOn: ["cycle-a"],
    kind: "analysis",
    scope: ["src"],
    acceptanceCriteria: ["Never accepted"],
  });
  const errors = validateExecutionPlan(plan).errors.join("\n");
  assert.match(errors, /cycle/);
  assert.match(errors, /not reachable from a root/);
});

test("requires final validation or review coverage for every implementation phase", () => {
  const plan = makeExecutionPlan();
  plan.phases[2]!.kind = "analysis";
  const result = validateExecutionPlan(plan);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /implementation phase implement lacks final validation\/review coverage/);
});

test("rejects empty fields and excessive phase counts", () => {
  const plan = makeExecutionPlan();
  plan.phases[0]!.scope = [];
  plan.phases[0]!.title = " ";
  let errors = validateExecutionPlan(plan).errors.join("\n");
  assert.match(errors, /scope must not be empty/);
  assert.match(errors, /title must be a non-empty string/);

  const overflow = makeExecutionPlan();
  overflow.phases = Array.from({ length: MAX_EXECUTION_PHASES + 1 }, (_, index) => ({
    id: `phase-${index}`,
    title: `Phase ${index}`,
    objective: "Bounded phase.",
    dependsOn: index === 0 ? [] : [`phase-${index - 1}`],
    kind: index === MAX_EXECUTION_PHASES ? "validation" as const : index === 1 ? "implementation" as const : "analysis" as const,
    scope: ["src"],
    acceptanceCriteria: ["Complete"],
  }));
  errors = validateExecutionPlan(overflow).errors.join("\n");
  assert.match(errors, /exceeds maximum/);
});
