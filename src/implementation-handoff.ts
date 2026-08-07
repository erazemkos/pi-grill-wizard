import { executionPlanLines, type ExecutionPlan } from "./execution-plan.ts";
import type { GrillAlternative, GrillQuestion } from "./questionnaire-schema.ts";
import type { GrillAnswer, GrillWorkflowData } from "./state.ts";

export const GRILL_HANDOFF_MARKER = "[GRILL WIZARD APPROVED SPECIFICATION]";
export const GRILL_ORCHESTRATION_MARKER = "[GRILL WIZARD APPROVED SUBAGENT ORCHESTRATION]";
export const GRILL_EXECUTION_PLAN_MARKER = "[GRILL WIZARD: PLAN SUBAGENT EXECUTION]";

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

export function buildExecutionPlanningMessage(data: GrillWorkflowData): string {
  const specification = buildNormalizedSpecification(data);
  return `${GRILL_EXECUTION_PLAN_MARKER}\n\n${specification}\n\n---\n\nMutation remains blocked. Create one complete data-only dependency DAG for subagent execution, then call \`grill_prepare_execution_plan\` exactly once. Do not emit or execute workflowScript or JavaScript. Every phase needs a stable id, title, objective, dependencies, kind, scope, and acceptance criteria. Include final validation or review covering every implementation phase. Respect all approved answers and non-goals.`;
}

export function formatExecutionPlan(plan: ExecutionPlan): string {
  return ["# Validated subagent execution plan", ...executionPlanLines(plan)].join("\n");
}

export function buildOrchestrationMessage(data: GrillWorkflowData): string {
  if (!data.executionPlan) throw new Error("Cannot build orchestration handoff without execution plan");
  const specification = buildNormalizedSpecification(data);
  const plan = formatExecutionPlan(data.executionPlan);
  return `${GRILL_ORCHESTRATION_MARKER}\n\n${specification}\n\n${plan}\n\n---\n\nAct as sole orchestrator; do not delegate orchestration itself. Before execution call \`subagent\` with \`action: "list"\` and map available roles to phases. Use one \`workflowScript\` with stable phase keys for coordinated work. Run only dependency-ready phases. After every workflow batch, inspect every \`runs.all\` result and require its \`.ok\` value to be true before launching any dependent phase. Parallelize only ready read-only analysis, validation, or review phases. Run implementation phases sequentially in the shared checkout with exactly one writer and never parallel writers. Validate and review after mutation. If a prerequisite fails, do not launch dependents; inspect, retry only clearly transient startup failures, otherwise pause and report. Include the approved specification, selected answers, non-goals, dependency outputs, scope, and acceptance criteria in every child prompt. A child that finds a missing product or architecture decision must use \`contact_supervisor\`; it must not call Grill Wizard in its child session. Parent must pause or stop active writers, then call \`grill_prepare_questionnaire\` with one small complete follow-up questionnaire. Supervise async work through subagent status/artifacts and \`subagent_wait\` when this request must complete in the current turn. Call \`grill_complete_implementation\` only after all child work is inactive and final validation/review is complete.`;
}

export function buildOrchestrationResumeMessage(data: GrillWorkflowData): string {
  if (!data.executionPlan) throw new Error("Cannot resume orchestration without execution plan");
  return `${GRILL_ORCHESTRATION_MARKER}\n\nResume the approved orchestration below. First reconcile subagent status and durable artifacts. Identify completed, failed, and still-active phase keys; never rerun completed phases blindly. Stop or wait for duplicate active work before launching replacements. Inspect every \`runs.all\` result and require its \`.ok\` value to be true before launching dependents. Continue only dependency-ready phases under the one-writer and failure rules, then call \`grill_complete_implementation\` after no child work remains.\n\n${buildNormalizedSpecification(data)}\n\n${formatExecutionPlan(data.executionPlan)}`;
}
