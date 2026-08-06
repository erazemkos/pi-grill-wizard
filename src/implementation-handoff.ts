import type { GrillAlternative, GrillQuestion } from "./questionnaire-schema.ts";
import type { GrillAnswer, GrillWorkflowData } from "./state.ts";

export const GRILL_HANDOFF_MARKER = "[GRILL WIZARD APPROVED SPECIFICATION]";

function selectedAlternative(question: GrillQuestion, answer: GrillAnswer): GrillAlternative | undefined {
  return answer.kind === "alternative"
    ? question.alternatives.find((alternative) => alternative.id === answer.alternativeId)
    : undefined;
}

export function answerText(question: GrillQuestion, answer: GrillAnswer | undefined): string {
  if (!answer) return "Unanswered";
  if (answer.kind === "custom") return answer.text;
  const alternative = selectedAlternative(question, answer);
  if (!alternative) return `[Invalid alternative: ${answer.alternativeId}]`;
  const consequences = alternative.consequences?.length
    ? ` Consequences: ${alternative.consequences.join("; ")}`
    : "";
  return `${alternative.label} — ${alternative.description}${consequences}`;
}

function decisionsFor(data: GrillWorkflowData, categoryPattern?: RegExp): string[] {
  return (data.questionnaire?.questions ?? [])
    .filter((question) => !categoryPattern || categoryPattern.test(question.category))
    .map((question) => `${question.question}\n  Decision: ${answerText(question, data.answers[question.id])}`);
}

function section(title: string, lines: string[], empty = "None specified"): string {
  const body = lines.length > 0 ? lines.map((line) => `- ${line}`).join("\n") : `- ${empty}`;
  return `## ${title}\n${body}`;
}

export function buildNormalizedSpecification(data: GrillWorkflowData): string {
  const questionnaire = data.questionnaire;
  if (!questionnaire) throw new Error("Cannot build implementation handoff without questionnaire");

  const scope = decisionsFor(data, /scope|boundar|product|behavior|ux/i);
  const architecture = decisionsFor(data, /architecture|design|technical/i);
  const compatibility = decisionsFor(data, /compatib|platform|backward/i);
  const errors = decisionsFor(data, /error|failure|recover|resilien/i);
  const security = decisionsFor(data, /security|privacy|permission|trust/i);
  const testing = decisionsFor(data, /test|validat|quality/i);
  const migration = decisionsFor(data, /migrat|rollout|upgrade|transition/i);
  const allDecisions = decisionsFor(data);

  const parts = [
    `# Approved implementation specification: ${questionnaire.title}`,
    ...(data.approvedSpecificationHistory ?? []).map(
      (specification, index) => `## Previously approved specification ${index + 1}\n\n${specification}`,
    ),
    data.implementationSummary ? `## Edited implementation summary\n${data.implementationSummary}` : "",
    section("Objective", [questionnaire.requestedOutcome]),
    section("In-scope behavior", scope),
    section("Out-of-scope behavior", questionnaire.areasIntentionallyDeferred),
    section("Decisions", allDecisions),
    section("Constraints", questionnaire.assumptions),
    section("Architecture", architecture),
    section("Compatibility requirements", compatibility),
    section("Error behavior", errors),
    section("Security requirements", security),
    section("Test requirements", testing),
    section("Migration requirements", migration),
    section("Acceptance criteria", questionnaire.proposedAcceptanceCriteria),
    section(
      "Ordered implementation plan",
      questionnaire.proposedImplementationPhases.map((phase, index) => `${index + 1}. ${phase}`),
    ),
    "## Authority and blocking decisions\n- Selected and custom answers above are authoritative. Do not silently choose another alternative.\n- If implementation reveals a true contradiction or missing blocking decision, stop mutation and call `grill_prepare_questionnaire` once with a small complete follow-up questionnaire. Never guess.",
  ];

  return parts.filter(Boolean).join("\n\n");
}

export function buildImplementationMessage(data: GrillWorkflowData): string {
  const specification = buildNormalizedSpecification(data);
  return `${GRILL_HANDOFF_MARKER}\n\n${specification}\n\n---\n\nImplement this approved specification now. Preserve every selected answer. Run relevant tests and report changed files, validation, and residual risks.`;
}
