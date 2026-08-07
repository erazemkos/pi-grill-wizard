import type { ExecutionPlan } from "../src/execution-plan.ts";
import type { GrillQuestion, GrillQuestionnaire } from "../src/questionnaire-schema.ts";

export function makeQuestion(id: string, category: string): GrillQuestion {
  return {
    id,
    category,
    question: `Choose ${category} strategy for ${id}?`,
    whyItMatters: `${category} changes implementation outcomes.`,
    alternatives: [
      {
        id: `${id}-a`,
        label: `Conservative ${category}`,
        description: `Preserve current ${category} behavior.`,
        consequences: ["Lowest change risk"],
      },
      {
        id: `${id}-b`,
        label: `Balanced ${category}`,
        description: `Add focused ${category} behavior.`,
        consequences: ["Moderate maintenance cost"],
      },
      {
        id: `${id}-c`,
        label: `Expansive ${category}`,
        description: `Redesign ${category} behavior broadly.`,
        consequences: ["Highest migration cost"],
      },
    ],
    recommendedAlternativeId: `${id}-b`,
  };
}

export function makeExecutionPlan(): ExecutionPlan {
  return {
    phases: [
      {
        id: "analyze",
        title: "Analyze implementation seam",
        objective: "Confirm exact files and constraints before mutation.",
        dependsOn: [],
        kind: "analysis",
        scope: ["src"],
        acceptanceCriteria: ["Implementation seam documented"],
      },
      {
        id: "implement",
        title: "Implement approved behavior",
        objective: "Apply approved specification with one writer.",
        dependsOn: ["analyze"],
        kind: "implementation",
        scope: ["src", "tests"],
        acceptanceCriteria: ["Focused behavior implemented"],
      },
      {
        id: "validate",
        title: "Validate implementation",
        objective: "Run focused tests and inspect regressions.",
        dependsOn: ["implement"],
        kind: "validation",
        scope: ["tests"],
        acceptanceCriteria: ["Tests and typecheck pass"],
      },
    ],
  };
}

export function makeQuestionnaire(): GrillQuestionnaire {
  return {
    title: "Feature implementation",
    requestedOutcome: "Implement a repository feature with explicit decisions.",
    repositoryObservations: ["Existing code and tests establish baseline behavior."],
    questions: [
      makeQuestion("product", "product behavior"),
      makeQuestion("scope", "scope"),
      makeQuestion("architecture", "architecture"),
      makeQuestion("errors", "error handling"),
      makeQuestion("testing", "testing"),
      makeQuestion("delivery", "delivery"),
      makeQuestion("migration", "migration"),
    ],
    assumptions: ["Existing build remains supported."],
    areasIntentionallyDeferred: [],
    proposedImplementationPhases: ["Implement core behavior", "Validate and document"],
    proposedAcceptanceCriteria: ["Focused tests pass", "No mutation occurs before approval"],
  };
}
