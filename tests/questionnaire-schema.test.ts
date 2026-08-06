import assert from "node:assert/strict";
import test from "node:test";
import { MAX_QUESTIONS, validateQuestionnaire } from "../src/questionnaire-schema.ts";
import { makeQuestion, makeQuestionnaire } from "./fixtures.ts";

test("validates complete questionnaire", () => {
  assert.deepEqual(validateQuestionnaire(makeQuestionnaire()), { valid: true, errors: [] });
});

test("requires exactly three alternatives", () => {
  const questionnaire = makeQuestionnaire();
  (questionnaire.questions[0]!.alternatives as unknown[]).pop();
  const result = validateQuestionnaire(questionnaire);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /exactly three alternatives/);
});

test("rejects duplicate question IDs and malformed alternatives", () => {
  const questionnaire = makeQuestionnaire();
  questionnaire.questions[1]!.id = questionnaire.questions[0]!.id;
  questionnaire.questions[0]!.alternatives[1] = { ...questionnaire.questions[0]!.alternatives[0] };
  questionnaire.questions[0]!.alternatives[2]!.consequences = [];
  const result = validateQuestionnaire(questionnaire);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /duplicates/);
  assert.match(result.errors.join("\n"), /meaningfully different/);
  assert.match(result.errors.join("\n"), /must not be empty/);
});

test("rejects malformed model output without throwing", () => {
  const malformedInputs = [
    { title: "partial", questions: "not-an-array" },
    { ...makeQuestionnaire(), questions: [null] },
    {
      ...makeQuestionnaire(),
      questions: [{ ...makeQuestion("bad", "scope"), alternatives: {}, dependsOn: "other" }],
    },
  ];
  for (const input of malformedInputs) {
    const result = validateQuestionnaire(input);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 1);
  }
});

test("rejects empty questionnaire", () => {
  const questionnaire = makeQuestionnaire();
  questionnaire.questions = [];
  const result = validateQuestionnaire(questionnaire);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /must not be empty/);
});

test("accepts maximum-size questionnaire and rejects larger input", () => {
  const questionnaire = makeQuestionnaire();
  const categories = ["product behavior", "scope", "architecture", "error handling", "testing", "delivery", "migration"];
  questionnaire.questions = Array.from({ length: MAX_QUESTIONS }, (_, index) =>
    makeQuestion(`q-${index}`, categories[index % categories.length]!),
  );
  assert.equal(validateQuestionnaire(questionnaire).valid, true);

  questionnaire.questions.push(makeQuestion("overflow", "scope"));
  const result = validateQuestionnaire(questionnaire);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /exceeds maximum/);
});

test("rejects dependency cycles", () => {
  const questionnaire = makeQuestionnaire();
  questionnaire.questions[0]!.dependsOn = [questionnaire.questions[1]!.id];
  questionnaire.questions[1]!.dependsOn = [questionnaire.questions[0]!.id];
  const result = validateQuestionnaire(questionnaire);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /cycle/);
});
