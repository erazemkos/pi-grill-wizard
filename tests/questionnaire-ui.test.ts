import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReviewLines,
  cycleHighlight,
  executionPlanReviewActionForInput,
  isAnswerConfirmationInput,
  reviewActionForInput,
} from "../src/questionnaire-ui.ts";
import { setAlternativeAnswer, type GrillWorkflowData } from "../src/state.ts";
import { makeQuestionnaire } from "./fixtures.ts";

test("highlight cycling wraps in both directions", () => {
  assert.equal(cycleHighlight(0, 1, 3), 1);
  assert.equal(cycleHighlight(2, 1, 3), 0);
  assert.equal(cycleHighlight(0, -1, 3), 2);
  assert.equal(cycleHighlight(1, -1, 3), 0);
});

test("highlight cycling tolerates malformed or empty input", () => {
  assert.equal(cycleHighlight(Number.NaN, 1, 3), 1);
  assert.equal(cycleHighlight(99, -1, 3), 2);
  assert.equal(cycleHighlight(0, 1, 0), 0);
});

test("Enter and Right accept the highlighted answer while n remains navigation", () => {
  assert.equal(isAnswerConfirmationInput("\r"), true);
  assert.equal(isAnswerConfirmationInput("\x1b[C"), true);
  assert.equal(isAnswerConfirmationInput("n"), false);
});

test("review actions distinguish direct and available subagent implementation", () => {
  assert.equal(reviewActionForInput("1", false), "implement-direct");
  assert.equal(reviewActionForInput("2", false), undefined);
  assert.equal(reviewActionForInput("2", true), "implement-subagents");
  assert.equal(reviewActionForInput("3", true), "question");
  assert.equal(reviewActionForInput("6", true), "cancel");
  assert.equal(executionPlanReviewActionForInput("1"), "start");
  assert.equal(executionPlanReviewActionForInput("2"), "regenerate");
  assert.equal(executionPlanReviewActionForInput("3"), "questionnaire");
});

test("review lines list every question and selected answer", () => {
  const questionnaire = makeQuestionnaire();
  let workflow: GrillWorkflowData = {
    version: 1,
    state: "reviewing",
    questionnaire,
    answers: {},
    currentPosition: 0,
  };
  workflow = setAlternativeAnswer(workflow, questionnaire.questions[0]!.id, questionnaire.questions[0]!.alternatives[2]!.id);
  const lines = buildReviewLines(workflow).join("\n");
  assert.match(lines, /Expansive product behavior/);
  assert.match(lines, /Unanswered/);
});
