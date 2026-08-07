import assert from "node:assert/strict";
import test from "node:test";
import { createSnapshot, requiresApprovalReview } from "../src/persistence.ts";
import {
  allQuestionsAnswered,
  beginWorkflow,
  moveQuestion,
  normalizeRestoredState,
  sanitizeAnswers,
  setAlternativeAnswer,
  setCustomAnswer,
  transitionState,
  type GrillWorkflowData,
} from "../src/state.ts";
import { makeExecutionPlan, makeQuestionnaire } from "./fixtures.ts";

test("custom answer remains exactly as written", () => {
  const original = "  first line\nsecond line\n  ";
  const workflow = setCustomAnswer(beginWorkflow("topic", []), "product", original);
  assert.deepEqual(workflow.answers.product, { kind: "custom", text: original });
});

test("backward navigation clamps at first question", () => {
  assert.equal(moveQuestion(3, -1, 5), 2);
  assert.equal(moveQuestion(0, -1, 5), 0);
  assert.equal(moveQuestion(4, 1, 5), 4);
});

test("cancellation and illegal transitions use explicit FSM", () => {
  let workflow = beginWorkflow("topic", ["read", "write"]);
  workflow = transitionState(workflow, "cancelled");
  assert.equal(workflow.state, "cancelled");
  assert.throws(() => transitionState(workflow, "approved"), /Invalid grill-wizard transition/);
});

test("session snapshot restores answers and position", () => {
  let workflow = beginWorkflow("topic", ["read", "write"]);
  workflow = transitionState(workflow, "preparing-questionnaire");
  workflow = {
    ...transitionState(workflow, "answering"),
    questionnaire: makeQuestionnaire(),
    currentPosition: 3,
  };
  workflow = setAlternativeAnswer(workflow, "product", "product-b");
  const snapshot = createSnapshot("session-a", workflow);
  const restored = normalizeRestoredState(snapshot.workflow);
  assert.equal(restored.state, "answering");
  assert.equal(restored.currentPosition, 3);
  assert.deepEqual(restored.answers.product, { kind: "alternative", alternativeId: "product-b" });
});

test("subagent planning and orchestration transitions are explicit and persisted", () => {
  let workflow = beginWorkflow("topic", ["read", "subagent"]);
  workflow = transitionState(workflow, "preparing-questionnaire");
  workflow = {
    ...transitionState(workflow, "answering"),
    questionnaire: makeQuestionnaire(),
  };
  workflow = transitionState(workflow, "reviewing");
  workflow = {
    ...transitionState(workflow, "planning-orchestration"),
    implementationMode: "subagents",
  };
  workflow = {
    ...transitionState(workflow, "reviewing-orchestration"),
    executionPlan: makeExecutionPlan(),
  };
  workflow = { ...transitionState(workflow, "approved"), approvedSessionId: "session-a" };
  workflow = transitionState(workflow, "orchestrating");

  const restored = normalizeRestoredState(createSnapshot("session-a", workflow).workflow);
  assert.equal(restored.state, "orchestrating");
  assert.equal(restored.implementationMode, "subagents");
  assert.deepEqual(restored.executionPlan, makeExecutionPlan());
  assert.throws(() => transitionState(restored, "implementing"), /Invalid grill-wizard transition/);
});

test("foreign-session approval requires review", () => {
  const workflow: GrillWorkflowData = {
    version: 1,
    state: "approved",
    questionnaire: makeQuestionnaire(),
    answers: {},
    currentPosition: 0,
    approvedSessionId: "session-a",
  };
  assert.equal(requiresApprovalReview(workflow, "session-a", "session-b"), true);
  assert.equal(requiresApprovalReview(workflow, "session-a", "session-a"), false);

  const orchestrating: GrillWorkflowData = {
    ...workflow,
    state: "orchestrating",
    implementationMode: "subagents",
    executionPlan: makeExecutionPlan(),
  };
  assert.equal(requiresApprovalReview(orchestrating, "session-a", "session-b"), true);
});

test("inherited answer-map properties never count as answers", () => {
  const questionnaire = makeQuestionnaire();
  questionnaire.questions = [{ ...questionnaire.questions[0]!, id: "constructor" }];
  const workflow: GrillWorkflowData = {
    version: 1,
    state: "answering",
    questionnaire,
    answers: {},
    currentPosition: 0,
  };
  assert.equal(allQuestionsAnswered(workflow), false);
});

test("malformed restored position resets to zero", () => {
  const restored = normalizeRestoredState({
    version: 1,
    state: "answering",
    questionnaire: makeQuestionnaire(),
    answers: {},
    currentPosition: "bad",
  });
  assert.equal(restored.currentPosition, 0);
});

test("restoration filters orphan and invalid answers", () => {
  const questionnaire = makeQuestionnaire();
  const workflow: GrillWorkflowData = {
    version: 1,
    state: "answering",
    questionnaire,
    answers: {
      product: { kind: "alternative", alternativeId: "missing" },
      scope: { kind: "custom", text: " exact " },
      orphan: { kind: "custom", text: "discard" },
    },
    currentPosition: 0,
  };
  const sanitized = sanitizeAnswers(workflow);
  assert.deepEqual(sanitized.answers, { scope: { kind: "custom", text: " exact " } });
  assert.equal(allQuestionsAnswered(sanitized), false);
});
