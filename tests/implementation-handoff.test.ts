import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExecutionPlanningMessage,
  buildImplementationMessage,
  buildNormalizedSpecification,
  buildOrchestrationMessage,
  buildOrchestrationResumeMessage,
} from "../src/implementation-handoff.ts";
import { setAlternativeAnswer, setCustomAnswer, type GrillWorkflowData } from "../src/state.ts";
import { makeExecutionPlan, makeQuestionnaire } from "./fixtures.ts";

function answeredWorkflow(): GrillWorkflowData {
  const questionnaire = makeQuestionnaire();
  let workflow: GrillWorkflowData = {
    version: 1,
    state: "approved",
    originalObjective: "Ship feature safely",
    questionnaire,
    answers: {},
    currentPosition: 0,
  };
  for (const question of questionnaire.questions) {
    workflow = setAlternativeAnswer(workflow, question.id, question.alternatives[1].id);
  }
  return workflow;
}

test("implementation handoff contains every normalized section", () => {
  const specification = buildNormalizedSpecification(answeredWorkflow());
  for (const heading of [
    "## Objective",
    "## In-scope behavior",
    "## Out-of-scope behavior",
    "## Decisions",
    "## Constraints",
    "## Architecture",
    "## Compatibility requirements",
    "## Error behavior",
    "## Security requirements",
    "## Test requirements",
    "## Migration requirements",
    "## Acceptance criteria",
    "## Ordered implementation plan",
  ]) {
    assert.match(specification, new RegExp(heading));
  }
  assert.match(specification, /Balanced architecture/);
  assert.match(specification, /authoritative/);
});

test("custom answers remain authoritative and exact in handoff", () => {
  const custom = "  Preserve this line\nthen this one  ";
  const workflow = setCustomAnswer(answeredWorkflow(), "scope", custom);
  const specification = buildNormalizedSpecification(workflow);
  assert.ok(specification.includes(custom));
  assert.match(buildImplementationMessage(workflow), /Implement this approved specification now/);
});

test("edited summary cannot replace generated authoritative decisions", () => {
  const workflow = { ...answeredWorkflow(), implementationSummary: "Use a different architecture." };
  const specification = buildNormalizedSpecification(workflow);
  assert.match(specification, /Use a different architecture/);
  assert.match(specification, /Balanced architecture/);
});

test("subagent handoff keeps main agent as dependency-aware one-writer orchestrator", () => {
  const workflow: GrillWorkflowData = {
    ...answeredWorkflow(),
    implementationMode: "subagents",
    executionPlan: makeExecutionPlan(),
  };
  const planning = buildExecutionPlanningMessage(workflow);
  assert.match(planning, /Mutation remains blocked/);
  assert.match(planning, /data-only dependency DAG/);
  assert.match(planning, /Do not emit or execute workflowScript/);

  const handoff = buildOrchestrationMessage(workflow);
  for (const expected of [
    /sole orchestrator/,
    /action: "list"/,
    /workflowScript/,
    /stable phase keys/,
    /every `runs\.all` result/,
    /\.ok` value to be true/,
    /one writer/,
    /do not launch dependents/,
    /contact_supervisor/,
    /grill_complete_implementation/,
  ]) assert.match(handoff, expected);

  const resume = buildOrchestrationResumeMessage(workflow);
  assert.match(resume, /reconcile subagent status and durable artifacts/);
  assert.match(resume, /never rerun completed phases blindly/);
  assert.match(resume, /every `runs\.all` result/);
  assert.match(resume, /\.ok` value to be true/);
});

test("follow-up handoff retains prior approved specification", () => {
  const workflow = {
    ...answeredWorkflow(),
    approvedSpecificationHistory: ["# Earlier approved spec\n- Keep API stable"],
  };
  const specification = buildNormalizedSpecification(workflow);
  assert.match(specification, /Previously approved specification 1/);
  assert.match(specification, /Keep API stable/);
});
