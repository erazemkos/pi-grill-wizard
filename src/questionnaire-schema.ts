import { Type } from "typebox";

export const MAX_QUESTIONS = 100;

export interface GrillAlternative {
  id: string;
  label: string;
  description: string;
  consequences?: string[];
}

export interface GrillQuestion {
  id: string;
  category: string;
  question: string;
  whyItMatters: string;
  alternatives: [GrillAlternative, GrillAlternative, GrillAlternative];
  recommendedAlternativeId?: string;
  dependsOn?: string[];
}

export interface GrillQuestionnaire {
  title: string;
  requestedOutcome: string;
  repositoryObservations: string[];
  questions: GrillQuestion[];
  assumptions: string[];
  areasIntentionallyDeferred: string[];
  proposedImplementationPhases: string[];
  proposedAcceptanceCriteria: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const nonEmptyString = Type.String({ minLength: 1 });
const alternativeSchema = Type.Object(
  {
    id: nonEmptyString,
    label: nonEmptyString,
    description: nonEmptyString,
    consequences: Type.Array(nonEmptyString, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const questionSchema = Type.Object(
  {
    id: nonEmptyString,
    category: nonEmptyString,
    question: nonEmptyString,
    whyItMatters: nonEmptyString,
    alternatives: Type.Array(alternativeSchema, { minItems: 3, maxItems: 3 }),
    recommendedAlternativeId: Type.Optional(nonEmptyString),
    dependsOn: Type.Optional(Type.Array(nonEmptyString)),
  },
  { additionalProperties: false },
);

export const grillPrepareQuestionnaireSchema = Type.Object(
  {
    title: nonEmptyString,
    requestedOutcome: nonEmptyString,
    repositoryObservations: Type.Array(nonEmptyString),
    questions: Type.Array(questionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }),
    assumptions: Type.Array(nonEmptyString),
    areasIntentionallyDeferred: Type.Array(nonEmptyString),
    proposedImplementationPhases: Type.Array(nonEmptyString, { minItems: 1 }),
    proposedAcceptanceCriteria: Type.Array(nonEmptyString, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const CATEGORY_ALIASES: Record<string, string[]> = {
  product: ["product", "behavior", "ux", "user experience"],
  architecture: ["architecture", "design", "technical approach"],
  scope: ["scope", "boundaries", "non-goals"],
  compatibility: ["compatibility", "backward compatibility", "platform"],
  errors: ["error", "failure", "recovery", "resilience"],
  security: ["security", "privacy", "permission", "trust"],
  testing: ["test", "testing", "validation", "quality"],
  migration: ["migration", "rollout", "upgrade", "transition"],
  delivery: ["delivery", "release", "deployment", "documentation"],
};

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, " ") : "";
}

function hasCategory(questions: GrillQuestion[], category: string): boolean {
  const aliases = CATEGORY_ALIASES[category] ?? [category];
  return questions.some((question) => {
    const value = normalized(question.category);
    return aliases.some((alias) => value.includes(alias));
  });
}

function relevantCategories(questionnaire: GrillQuestionnaire): string[] {
  const observations = Array.isArray(questionnaire.repositoryObservations)
    ? questionnaire.repositoryObservations.filter((item): item is string => typeof item === "string")
    : [];
  const text = normalized([
    questionnaire.title,
    questionnaire.requestedOutcome,
    ...observations,
  ].join(" "));
  const required = new Set(["product", "scope"]);
  if (/implement|feature|code|system|service|application|extension|package|architecture|refactor/.test(text)) {
    required.add("architecture");
    required.add("errors");
    required.add("testing");
    required.add("delivery");
  }
  if (/api|public|config|version|platform|integration|plugin|extension|package|cli/.test(text)) {
    required.add("compatibility");
  }
  if (/auth|secret|security|permission|trust|privacy|network|shell|command|input|database|data/.test(text)) {
    required.add("security");
  }
  if (/existing|replace|change|refactor|upgrade|version|config|database|schema|backward|legacy/.test(text)) {
    required.add("migration");
  }
  return [...required];
}

function validateStringArray(value: unknown, path: string, errors: string[], requireNonEmpty = false): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return;
  }
  if (requireNonEmpty && value.length === 0) errors.push(`${path} must not be empty`);
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "") errors.push(`${path}[${index}] must be a non-empty string`);
  });
}

export function validateQuestionnaire(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return { valid: false, errors: ["Questionnaire must be an object"] };
  const questionnaire = value as GrillQuestionnaire;

  if (!normalized(questionnaire.title)) errors.push("title must be a non-empty string");
  if (!normalized(questionnaire.requestedOutcome)) errors.push("requestedOutcome must be a non-empty string");
  validateStringArray(questionnaire.repositoryObservations, "repositoryObservations", errors);
  validateStringArray(questionnaire.assumptions, "assumptions", errors);
  validateStringArray(questionnaire.areasIntentionallyDeferred, "areasIntentionallyDeferred", errors);
  validateStringArray(questionnaire.proposedImplementationPhases, "proposedImplementationPhases", errors, true);
  validateStringArray(questionnaire.proposedAcceptanceCriteria, "proposedAcceptanceCriteria", errors, true);

  if (!Array.isArray(questionnaire.questions)) {
    errors.push("questions must be an array");
    return { valid: false, errors };
  }
  if (questionnaire.questions.length === 0) errors.push("questions must not be empty");
  if (questionnaire.questions.length > MAX_QUESTIONS) {
    errors.push(`questions exceeds maximum of ${MAX_QUESTIONS}`);
  }

  const questionIds = new Set<string>();
  const normalizedQuestions = new Set<string>();
  questionnaire.questions.forEach((question, questionIndex) => {
    const path = `questions[${questionIndex}]`;
    if (!question || typeof question !== "object") {
      errors.push(`${path} must be an object`);
      return;
    }
    const id = normalized(question.id);
    if (!id) errors.push(`${path}.id must be non-empty`);
    else if (questionIds.has(id)) errors.push(`${path}.id duplicates ${question.id}`);
    else questionIds.add(id);

    if (!normalized(question.category)) errors.push(`${path}.category must be non-empty`);
    const questionText = normalized(question.question);
    if (!questionText) errors.push(`${path}.question must be non-empty`);
    else if (normalizedQuestions.has(questionText)) errors.push(`${path}.question duplicates another question`);
    else normalizedQuestions.add(questionText);
    if (!normalized(question.whyItMatters)) errors.push(`${path}.whyItMatters must be non-empty`);

    if (!Array.isArray(question.alternatives) || question.alternatives.length !== 3) {
      errors.push(`${path}.alternatives must contain exactly three alternatives`);
    } else {
      const ids = new Set<string>();
      const meanings = new Set<string>();
      question.alternatives.forEach((alternative, alternativeIndex) => {
        const altPath = `${path}.alternatives[${alternativeIndex}]`;
        if (!alternative || typeof alternative !== "object") {
          errors.push(`${altPath} must be an object`);
          return;
        }
        const altId = normalized(alternative.id);
        if (!altId) errors.push(`${altPath}.id must be non-empty`);
        else if (ids.has(altId)) errors.push(`${altPath}.id must be unique within question`);
        else ids.add(altId);
        if (!normalized(alternative.label)) errors.push(`${altPath}.label must be non-empty`);
        if (!normalized(alternative.description)) errors.push(`${altPath}.description must be non-empty`);
        validateStringArray(alternative.consequences, `${altPath}.consequences`, errors, true);
        const meaning = normalized(`${alternative.label} ${alternative.description}`);
        if (meaning && meanings.has(meaning)) errors.push(`${altPath} is not meaningfully different`);
        meanings.add(meaning);
      });
    }

    if (question.recommendedAlternativeId !== undefined) {
      const recommended = normalized(question.recommendedAlternativeId);
      if (
        !Array.isArray(question.alternatives) ||
        !question.alternatives.some(
          (alternative) => alternative && typeof alternative === "object" && normalized(alternative.id) === recommended,
        )
      ) {
        errors.push(`${path}.recommendedAlternativeId must reference one of its alternatives`);
      }
    }
    if (question.dependsOn !== undefined && !Array.isArray(question.dependsOn)) {
      errors.push(`${path}.dependsOn must be an array`);
    }
  });

  const validQuestions = questionnaire.questions.filter(
    (question): question is GrillQuestion => Boolean(question && typeof question === "object"),
  );
  const dependencyGraph = new Map<string, string[]>();
  validQuestions.forEach((question) => {
    const questionIndex = questionnaire.questions.indexOf(question);
    const dependencies = Array.isArray(question.dependsOn) ? question.dependsOn.map(normalized) : [];
    dependencyGraph.set(normalized(question.id), dependencies);
    for (const dependency of Array.isArray(question.dependsOn) ? question.dependsOn : []) {
      if (normalized(dependency) === normalized(question.id)) {
        errors.push(`questions[${questionIndex}].dependsOn cannot reference itself`);
      } else if (!questionIds.has(normalized(dependency))) {
        errors.push(`questions[${questionIndex}].dependsOn references unknown question ${dependency}`);
      }
    }
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function hasCycle(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencyGraph.get(id) ?? []) {
      if (dependencyGraph.has(dependency) && hasCycle(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  if ([...dependencyGraph.keys()].some(hasCycle)) errors.push("Question dependencies contain a cycle");

  if (validQuestions.length > 0) {
    const deferredText = normalized(
      (Array.isArray(questionnaire.areasIntentionallyDeferred)
        ? questionnaire.areasIntentionallyDeferred.filter((item): item is string => typeof item === "string")
        : []
      ).join(" "),
    );
    for (const category of relevantCategories(questionnaire)) {
      if (!hasCategory(validQuestions, category) && !deferredText.includes(category)) {
        errors.push(`Questionnaire lacks relevant ${category} coverage or an explicit deferral`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
