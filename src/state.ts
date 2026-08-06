import type { GrillQuestionnaire } from "./questionnaire-schema.ts";

export type GrillWorkflowState =
  | "idle"
  | "discovering"
  | "preparing-questionnaire"
  | "answering"
  | "reviewing"
  | "approved"
  | "implementing"
  | "cancelled";

export interface AlternativeAnswer {
  kind: "alternative";
  alternativeId: string;
}

export interface CustomAnswer {
  kind: "custom";
  text: string;
}

export type GrillAnswer = AlternativeAnswer | CustomAnswer;

export interface GrillWorkflowData {
  version: 1;
  state: GrillWorkflowState;
  topic?: string;
  originalObjective?: string;
  questionnaire?: GrillQuestionnaire;
  answers: Record<string, GrillAnswer>;
  currentPosition: number;
  implementationSummary?: string;
  approvedSpecificationHistory?: string[];
  toolsBeforeGate?: string[];
  approvedSessionId?: string;
}

export const INITIAL_STATE: GrillWorkflowData = {
  version: 1,
  state: "idle",
  answers: {},
  currentPosition: 0,
};

const ALLOWED_TRANSITIONS: Record<GrillWorkflowState, ReadonlySet<GrillWorkflowState>> = {
  idle: new Set(["discovering", "reviewing"]),
  discovering: new Set(["preparing-questionnaire", "cancelled"]),
  "preparing-questionnaire": new Set(["answering", "cancelled"]),
  answering: new Set(["reviewing", "preparing-questionnaire", "cancelled"]),
  reviewing: new Set(["answering", "preparing-questionnaire", "approved", "cancelled"]),
  approved: new Set(["implementing", "reviewing", "cancelled"]),
  implementing: new Set(["answering", "reviewing", "idle", "cancelled"]),
  cancelled: new Set(["discovering"]),
};

export function cloneWorkflowData(data: GrillWorkflowData): GrillWorkflowData {
  return JSON.parse(JSON.stringify(data)) as GrillWorkflowData;
}

export function transitionState(data: GrillWorkflowData, next: GrillWorkflowState): GrillWorkflowData {
  if (data.state === next) return cloneWorkflowData(data);
  if (!ALLOWED_TRANSITIONS[data.state].has(next)) {
    throw new Error(`Invalid grill-wizard transition: ${data.state} -> ${next}`);
  }
  return { ...cloneWorkflowData(data), state: next };
}

export function beginWorkflow(topic: string, toolsBeforeGate: string[]): GrillWorkflowData {
  const base = transitionState(INITIAL_STATE, "discovering");
  return {
    ...base,
    topic,
    originalObjective: topic,
    toolsBeforeGate: [...toolsBeforeGate],
  };
}

export function restartWorkflow(
  previous: GrillWorkflowData,
  topic: string,
  toolsBeforeGate: string[],
): GrillWorkflowData {
  let restartable = previous;
  if (restartable.state !== "cancelled") {
    if (restartable.state === "idle") restartable = transitionState(restartable, "discovering");
    restartable = transitionState(restartable, "cancelled");
  }
  const next = transitionState(restartable, "discovering");
  return {
    ...next,
    topic,
    originalObjective: topic,
    questionnaire: undefined,
    answers: {},
    currentPosition: 0,
    implementationSummary: undefined,
    approvedSpecificationHistory: [],
    approvedSessionId: undefined,
    toolsBeforeGate: previous.toolsBeforeGate?.length ? [...previous.toolsBeforeGate] : [...toolsBeforeGate],
  };
}

export function setAlternativeAnswer(
  data: GrillWorkflowData,
  questionId: string,
  alternativeId: string,
): GrillWorkflowData {
  return {
    ...cloneWorkflowData(data),
    answers: {
      ...data.answers,
      [questionId]: { kind: "alternative", alternativeId },
    },
  };
}

export function setCustomAnswer(data: GrillWorkflowData, questionId: string, text: string): GrillWorkflowData {
  return {
    ...cloneWorkflowData(data),
    answers: {
      ...data.answers,
      [questionId]: { kind: "custom", text },
    },
  };
}

export function moveQuestion(position: number, delta: -1 | 1, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(total - 1, position + delta));
}

export function allQuestionsAnswered(data: GrillWorkflowData): boolean {
  const questions = data.questionnaire?.questions ?? [];
  return questions.length > 0 && questions.every((question) => {
    if (!Object.hasOwn(data.answers, question.id)) return false;
    const answer = data.answers[question.id];
    if (answer?.kind === "custom") return typeof answer.text === "string" && answer.text.length > 0;
    return (
      answer?.kind === "alternative" &&
      question.alternatives.some((alternative) => alternative.id === answer.alternativeId)
    );
  });
}

export function sanitizeAnswers(data: GrillWorkflowData): GrillWorkflowData {
  if (!data.questionnaire) return { ...cloneWorkflowData(data), answers: {} };
  const answers: Record<string, GrillAnswer> = {};
  for (const question of data.questionnaire.questions) {
    const answer = data.answers[question.id];
    if (!answer) continue;
    if (answer.kind === "custom" && typeof answer.text === "string") {
      answers[question.id] = { kind: "custom", text: answer.text };
    } else if (
      answer.kind === "alternative" &&
      question.alternatives.some((alternative) => alternative.id === answer.alternativeId)
    ) {
      answers[question.id] = { kind: "alternative", alternativeId: answer.alternativeId };
    }
  }
  return { ...cloneWorkflowData(data), answers };
}

export function normalizeRestoredState(value: unknown): GrillWorkflowData {
  if (!value || typeof value !== "object") return cloneWorkflowData(INITIAL_STATE);
  const candidate = value as Partial<GrillWorkflowData>;
  const states = new Set<GrillWorkflowState>(Object.keys(ALLOWED_TRANSITIONS) as GrillWorkflowState[]);
  if (candidate.version !== 1 || !candidate.state || !states.has(candidate.state)) {
    return cloneWorkflowData(INITIAL_STATE);
  }
  const questions = Array.isArray(candidate.questionnaire?.questions) ? candidate.questionnaire.questions : [];
  const rawPosition = candidate.currentPosition;
  const safePosition = typeof rawPosition === "number" && Number.isFinite(rawPosition)
    ? Math.trunc(rawPosition)
    : 0;
  const currentPosition = Math.max(0, Math.min(questions.length > 0 ? questions.length - 1 : 0, safePosition));
  return {
    version: 1,
    state: candidate.state,
    topic: candidate.topic,
    originalObjective: candidate.originalObjective,
    questionnaire: candidate.questionnaire,
    answers: candidate.answers && typeof candidate.answers === "object" ? cloneWorkflowData({ ...INITIAL_STATE, answers: candidate.answers }).answers : {},
    currentPosition,
    implementationSummary: candidate.implementationSummary,
    approvedSpecificationHistory: Array.isArray(candidate.approvedSpecificationHistory)
      ? candidate.approvedSpecificationHistory.filter((item): item is string => typeof item === "string")
      : [],
    toolsBeforeGate: Array.isArray(candidate.toolsBeforeGate) ? [...candidate.toolsBeforeGate] : undefined,
    approvedSessionId: candidate.approvedSessionId,
  };
}
