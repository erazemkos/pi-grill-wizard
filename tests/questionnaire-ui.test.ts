import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewLines, cycleHighlight } from "../src/questionnaire-ui.ts";
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
