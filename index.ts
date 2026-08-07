import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  grillPrepareExecutionPlanSchema,
  validateExecutionPlan,
  type ExecutionPlan,
} from "./src/execution-plan.ts";
import {
  buildExecutionPlanningMessage,
  buildImplementationMessage,
  buildNormalizedSpecification,
  buildOrchestrationMessage,
  buildOrchestrationResumeMessage,
  GRILL_HANDOFF_MARKER,
  GRILL_ORCHESTRATION_MARKER,
} from "./src/implementation-handoff.ts";
import {
  isGateActive,
  mutationBlockReason,
  restrictedToolSet,
  restoredToolSet,
} from "./src/mutation-gate.ts";
import {
  persistWorkflow,
  requiresApprovalReview,
  restoreWorkflow,
} from "./src/persistence.ts";
import {
  grillPrepareQuestionnaireSchema,
  validateQuestionnaire,
  type GrillQuestionnaire,
} from "./src/questionnaire-schema.ts";
import {
  runQuestionnaireWizard,
  showExecutionPlanReviewScreen,
  showReviewScreen,
} from "./src/questionnaire-ui.ts";
import {
  allQuestionsAnswered,
  beginWorkflow,
  cloneWorkflowData,
  INITIAL_STATE,
  restartWorkflow,
  sanitizeAnswers,
  transitionState,
  type GrillWorkflowData,
} from "./src/state.ts";

const TOOL_NAME = "grill_prepare_questionnaire";
const PLAN_TOOL_NAME = "grill_prepare_execution_plan";
const COMPLETE_TOOL_NAME = "grill_complete_implementation";
const STATUS_KEY = "pi-grill-wizard";
const WORKFLOW_TOOL_NAMES = new Set([TOOL_NAME, PLAN_TOOL_NAME, COMPLETE_TOOL_NAME]);

type DriveResult = "approved" | "plan-subagents" | "regenerate" | "cancelled";

function discoveryPrompt(topic: string): string {
  return `[GRILL WIZARD: DISCOVERY]

Objective: ${topic}

Explore this repository read-only. Inspect structure, source, configuration, manifests, tests, documentation, and useful Git status/history. Do not modify anything.

After discovery, generate the complete decision questionnaire in exactly one successful \`${TOOL_NAME}\` call. Include title, requested outcome, concrete repository observations, every necessary question, exactly three genuinely distinct alternatives per question, consequences for every alternative, optional recommendations, why each question matters, dependencies, assumptions, intentionally deferred areas, implementation phases, and acceptance criteria.

Cover product behavior, architecture, scope, compatibility, error handling, security, testing, migration, and delivery when relevant. Do not ask decisions already established by this request or repository. Do not begin implementation.`;
}

function regenerationPrompt(data: GrillWorkflowData): string {
  return `[GRILL WIZARD: REGENERATE QUESTIONNAIRE]

Regenerate the entire questionnaire for this objective: ${data.originalObjective ?? data.topic ?? "unspecified"}.
Use prior repository observations as leads but re-check them read-only when needed. Replace, do not incrementally patch, the prior questionnaire. Call \`${TOOL_NAME}\` exactly once with the full replacement. Do not implement.`;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part && typeof part === "object" && (part as { type?: string }).type === "text"),
    )
    .map((part) => part.text)
    .join("\n");
}

function deriveTopic(ctx: ExtensionCommandContext): string {
  const branch = [...ctx.sessionManager.getBranch()].reverse();
  for (const entry of branch) {
    if (entry.type !== "message" || !("message" in entry) || entry.message.role !== "user") continue;
    const text = extractMessageText(entry.message.content).trim();
    if (text && !text.startsWith("/grill-wizard")) return text.slice(0, 2000);
  }
  return "Implement the current conversation request";
}

export default function grillWizardExtension(pi: ExtensionAPI): void {
  let workflow = cloneWorkflowData(INITIAL_STATE);
  let processToolBaseline: string[] = [];
  let gateApplied = false;

  const withoutWorkflowTools = (names: string[]): string[] => names.filter((name) => !WORKFLOW_TOOL_NAMES.has(name));

  function desiredWorkflowTools(): string[] {
    if (!isGateActive(workflow.state)) return [];
    if (workflow.state === "planning-orchestration") return [TOOL_NAME, PLAN_TOOL_NAME];
    if (workflow.state === "orchestrating") return [TOOL_NAME, COMPLETE_TOOL_NAME];
    return [TOOL_NAME];
  }

  function persist(ctx: ExtensionContext): void {
    persistWorkflow(pi, ctx, workflow);
    updateStatus(ctx);
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!isGateActive(workflow.state)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const questionCount = workflow.questionnaire?.questions.length ?? 0;
    const answered = Object.keys(workflow.answers).length;
    const detail = questionCount > 0 ? ` ${answered}/${questionCount}` : "";
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg(
        workflow.state === "implementing" || workflow.state === "orchestrating" ? "success" : "warning",
        `grill:${workflow.state}${detail}`,
      ),
    );
  }

  function setWorkflow(next: GrillWorkflowData, ctx: ExtensionContext): void {
    workflow = next;
    persist(ctx);
  }

  function gateTools(ctx: ExtensionContext): void {
    const active = withoutWorkflowTools(pi.getActiveTools());
    processToolBaseline = withoutWorkflowTools(restoredToolSet(active, processToolBaseline));
    workflow = {
      ...workflow,
      toolsBeforeGate: withoutWorkflowTools(restoredToolSet(processToolBaseline, workflow.toolsBeforeGate)),
    };
    const restricted = withoutWorkflowTools(restrictedToolSet(active));
    pi.setActiveTools([...new Set([...restricted, ...desiredWorkflowTools()])]);
    gateApplied = true;
    updateStatus(ctx);
  }

  function restoreTools(ctx: ExtensionContext): void {
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    const current = withoutWorkflowTools(pi.getActiveTools());
    const restored = gateApplied
      ? withoutWorkflowTools(
        restoredToolSet(current, restoredToolSet(processToolBaseline, workflow.toolsBeforeGate)),
      ).filter((name) => registered.has(name))
      : current;
    processToolBaseline = [...restored];
    pi.setActiveTools([...new Set([...restored, ...desiredWorkflowTools()])]);
    gateApplied = false;
    updateStatus(ctx);
  }

  function applyToolsForState(ctx: ExtensionContext): void {
    const shouldGate = isGateActive(workflow.state) && !["implementing", "orchestrating"].includes(workflow.state);
    if (shouldGate) gateTools(ctx);
    else restoreTools(ctx);
  }

  function sendUserPrompt(ctx: ExtensionContext, message: string): void {
    if (ctx.isIdle()) pi.sendUserMessage(message);
    else pi.sendUserMessage(message, { deliverAs: "followUp" });
  }

  function subagentsAvailable(): boolean {
    const registered = pi.getAllTools().some((tool) => tool.name === "subagent");
    if (!registered) return false;
    const restorable = gateApplied
      ? restoredToolSet(processToolBaseline, workflow.toolsBeforeGate)
      : withoutWorkflowTools(pi.getActiveTools());
    return restorable.includes("subagent");
  }

  const activeChildrenStoppedMessage =
    "Confirm every active subagent run has already been stopped. Grill Wizard cannot stop child runs for you.";

  async function cancelCurrent(ctx: ExtensionContext, ask = true): Promise<boolean> {
    if (workflow.state === "idle" || workflow.state === "cancelled") return false;
    if (ask && ctx.hasUI) {
      const title = workflow.state === "orchestrating" ? "Cancel subagent orchestration?" : "Cancel Grill Wizard?";
      const message = workflow.state === "orchestrating"
        ? activeChildrenStoppedMessage
        : "Cancel without making project changes?";
      const confirmed = await ctx.ui.confirm(title, message);
      if (!confirmed) return false;
    }
    setWorkflow(transitionState(workflow, "cancelled"), ctx);
    applyToolsForState(ctx);
    return true;
  }

  async function approveDirect(ctx: ExtensionContext): Promise<DriveResult> {
    setWorkflow(
      {
        ...transitionState(workflow, "approved"),
        implementationMode: "direct",
        executionPlan: undefined,
        approvedSessionId: ctx.sessionManager.getSessionId(),
      },
      ctx,
    );
    gateTools(ctx);
    sendUserPrompt(ctx, buildImplementationMessage(workflow));
    return "approved";
  }

  async function beginOrchestrationPlanning(ctx: ExtensionContext): Promise<DriveResult> {
    if (!subagentsAvailable()) {
      ctx.ui.notify("Install pi-subagents before selecting orchestrated implementation", "warning");
      return "cancelled";
    }
    setWorkflow(
      {
        ...transitionState(workflow, "planning-orchestration"),
        implementationMode: "subagents",
        executionPlan: undefined,
        approvedSessionId: undefined,
      },
      ctx,
    );
    applyToolsForState(ctx);
    sendUserPrompt(ctx, buildExecutionPlanningMessage(workflow));
    return "plan-subagents";
  }

  async function driveQuestionnaire(ctx: ExtensionContext): Promise<DriveResult> {
    while (true) {
      if (workflow.state === "answering") {
        const result = await runQuestionnaireWizard(ctx, workflow, (next) => setWorkflow(next, ctx));
        workflow = result.data;
        if (result.outcome === "cancel-requested") {
          if (await cancelCurrent(ctx, true)) return "cancelled";
          continue;
        }
        if (!allQuestionsAnswered(workflow)) continue;
        setWorkflow(transitionState(workflow, "reviewing"), ctx);
      }

      if (workflow.state !== "reviewing") {
        throw new Error(`Cannot show review from Grill Wizard state '${workflow.state}'`);
      }

      const action = await showReviewScreen(ctx, workflow, subagentsAvailable());
      if (action === "question") {
        const questions = workflow.questionnaire?.questions ?? [];
        const selected = await ctx.ui.select(
          "Return to question:",
          questions.map((question, index) => `${index + 1}. [${question.category}] ${question.question}`),
        );
        if (!selected) continue;
        const position = Math.max(0, Number.parseInt(selected, 10) - 1);
        setWorkflow({ ...transitionState(workflow, "answering"), currentPosition: position }, ctx);
        continue;
      }
      if (action === "summary") {
        const initial = workflow.implementationSummary ?? buildNormalizedSpecification(workflow);
        const edited = await ctx.ui.editor("Edit implementation summary:", initial);
        if (edited !== undefined) setWorkflow({ ...workflow, implementationSummary: edited }, ctx);
        continue;
      }
      if (action === "regenerate") {
        setWorkflow(
          {
            ...transitionState(workflow, "preparing-questionnaire"),
            questionnaire: undefined,
            answers: {},
            currentPosition: 0,
            implementationSummary: undefined,
            implementationMode: undefined,
            executionPlan: undefined,
          },
          ctx,
        );
        applyToolsForState(ctx);
        sendUserPrompt(ctx, regenerationPrompt(workflow));
        return "regenerate";
      }
      if (action === "cancel") {
        await cancelCurrent(ctx, false);
        return "cancelled";
      }
      if (action === "implement-subagents") return beginOrchestrationPlanning(ctx);
      return approveDirect(ctx);
    }
  }

  async function driveExecutionPlanReview(ctx: ExtensionContext): Promise<DriveResult> {
    if (workflow.state !== "reviewing-orchestration" || !workflow.executionPlan) {
      throw new Error(`Cannot review execution plan from Grill Wizard state '${workflow.state}'`);
    }
    const action = await showExecutionPlanReviewScreen(ctx, workflow.executionPlan);
    if (action === "regenerate") {
      setWorkflow(
        { ...transitionState(workflow, "planning-orchestration"), executionPlan: undefined },
        ctx,
      );
      applyToolsForState(ctx);
      sendUserPrompt(ctx, buildExecutionPlanningMessage(workflow));
      return "plan-subagents";
    }
    if (action === "questionnaire") {
      setWorkflow(
        {
          ...transitionState(workflow, "reviewing"),
          implementationMode: undefined,
          executionPlan: undefined,
        },
        ctx,
      );
      applyToolsForState(ctx);
      return driveQuestionnaire(ctx);
    }
    if (action === "cancel") {
      await cancelCurrent(ctx, false);
      return "cancelled";
    }
    if (!subagentsAvailable()) {
      ctx.ui.notify("Subagent tool is no longer available. Returned to questionnaire review; mutation remains blocked.", "warning");
      setWorkflow(
        {
          ...transitionState(workflow, "reviewing"),
          implementationMode: undefined,
          executionPlan: undefined,
          approvedSessionId: undefined,
        },
        ctx,
      );
      applyToolsForState(ctx);
      return driveQuestionnaire(ctx);
    }
    setWorkflow(
      {
        ...transitionState(workflow, "approved"),
        implementationMode: "subagents",
        approvedSessionId: ctx.sessionManager.getSessionId(),
      },
      ctx,
    );
    gateTools(ctx);
    sendUserPrompt(ctx, buildOrchestrationMessage(workflow));
    return "approved";
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: "Prepare Grill Questionnaire",
    description:
      "Submit one complete pre-generated implementation decision questionnaire after read-only repository discovery. Every question must have exactly three distinct alternatives and consequences. Never call incrementally. During implementation, the parent orchestrator calls it only for a true contradiction or missing blocking decision.",
    promptSnippet: "Submit complete Grill Wizard questionnaire before implementation",
    promptGuidelines: [
      `Use ${TOOL_NAME} exactly once after complete read-only discovery; include all questions in that one call and never implement before explicit wizard approval.`,
      `During approved implementation, only the parent orchestrator uses ${TOOL_NAME} for a true contradiction or missing blocking decision. Children must use contact_supervisor instead.`,
    ],
    parameters: grillPrepareQuestionnaireSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") throw new Error("grill_prepare_questionnaire requires interactive TUI mode");
      if (!["discovering", "preparing-questionnaire", "answering"].includes(workflow.state)) {
        throw new Error(`grill_prepare_questionnaire is invalid in state '${workflow.state}'`);
      }
      if (workflow.state === "discovering" || workflow.state === "answering") {
        setWorkflow(transitionState(workflow, "preparing-questionnaire"), ctx);
      }

      const questionnaire = params as GrillQuestionnaire;
      const validation = validateQuestionnaire(questionnaire);
      if (!validation.valid) throw new Error(`Malformed questionnaire:\n- ${validation.errors.join("\n- ")}`);

      setWorkflow(
        {
          ...transitionState(workflow, "answering"),
          questionnaire,
          answers: {},
          currentPosition: 0,
          implementationSummary: undefined,
          implementationMode: undefined,
          executionPlan: undefined,
        },
        ctx,
      );
      applyToolsForState(ctx);
      const result = await driveQuestionnaire(ctx);
      const text = result === "approved"
        ? "Questionnaire approved explicitly. Approved implementation handoff queued."
        : result === "plan-subagents"
          ? "User selected subagents. Structured execution-plan generation queued while mutation remains blocked."
          : result === "regenerate"
            ? "User requested complete questionnaire regeneration."
            : "User cancelled without making project changes.";
      return {
        content: [{ type: "text", text }],
        details: { result, state: workflow.state, answered: Object.keys(workflow.answers).length },
        terminate: true,
      };
    },

    renderCall(args, theme) {
      const title = typeof args.title === "string" ? args.title : "questionnaire";
      const count = Array.isArray(args.questions) ? args.questions.length : 0;
      return new Text(
        `${theme.fg("toolTitle", theme.bold(TOOL_NAME))} ${theme.fg("muted", `${title} (${count} questions)`)}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const content = result.content[0];
      const text = content?.type === "text" ? content.text : "";
      const details = result.details as { result?: DriveResult } | undefined;
      return new Text(theme.fg(details?.result === "approved" ? "success" : "warning", text), 0, 0);
    },
  });

  pi.registerTool({
    name: PLAN_TOOL_NAME,
    label: "Prepare Grill Execution Plan",
    description: "Submit one complete data-only dependency DAG after questionnaire decisions. Raw workflowScript or JavaScript is not accepted.",
    parameters: grillPrepareExecutionPlanSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (ctx.mode !== "tui") throw new Error("grill_prepare_execution_plan requires interactive TUI mode");
      if (workflow.state !== "planning-orchestration") {
        throw new Error(`grill_prepare_execution_plan is invalid in state '${workflow.state}'`);
      }
      const executionPlan = params as ExecutionPlan;
      const validation = validateExecutionPlan(executionPlan);
      if (!validation.valid) throw new Error(`Malformed execution plan:\n- ${validation.errors.join("\n- ")}`);
      setWorkflow(
        { ...transitionState(workflow, "reviewing-orchestration"), executionPlan },
        ctx,
      );
      applyToolsForState(ctx);
      const result = await driveExecutionPlanReview(ctx);
      return {
        content: [{ type: "text", text: result === "approved" ? "Subagent execution plan approved and orchestration handoff queued." : `Execution-plan review result: ${result}.` }],
        details: { result, state: workflow.state, phases: executionPlan.phases.length },
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: COMPLETE_TOOL_NAME,
    label: "Complete Grill Implementation",
    description: "Close an approved subagent orchestration only after all child work is inactive and final validation is complete.",
    parameters: Type.Object(
      {
        changedFiles: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        validation: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        childFailuresAndRetries: Type.Array(Type.String({ minLength: 1 })),
        residualRisks: Type.Array(Type.String({ minLength: 1 })),
        noActiveChildWork: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (workflow.state !== "orchestrating") {
        throw new Error(`grill_complete_implementation is invalid in state '${workflow.state}'`);
      }
      if (!(params as { noActiveChildWork?: boolean }).noActiveChildWork) {
        throw new Error("Cannot complete orchestration while child work may still be active");
      }
      setWorkflow(
        { ...transitionState(workflow, "idle"), approvedSessionId: undefined },
        ctx,
      );
      applyToolsForState(ctx);
      return {
        content: [{ type: "text", text: "Subagent orchestration completed explicitly; Grill Wizard returned to idle." }],
        details: params,
        terminate: true,
      };
    },
  });

  pi.registerCommand("grill-wizard", {
    description: "Prepare, resume, review, inspect, or cancel Grill workflow",
    getArgumentCompletions(prefix) {
      const values = ["status", "resume", "cancel", "review"];
      const matches = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
      return matches.length ? matches : null;
    },
    handler: async (rawArgs, ctx) => {
      const args = rawArgs.trim();
      if (args === "status") {
        const total = workflow.questionnaire?.questions.length ?? 0;
        const answered = Object.keys(workflow.answers).length;
        const phases = workflow.executionPlan?.phases.length ?? 0;
        ctx.ui.notify(
          `State: ${workflow.state}\nMode: ${workflow.implementationMode ?? "none"}\nTopic: ${workflow.topic ?? "none"}\nAnswers: ${answered}/${total}\nPosition: ${total ? workflow.currentPosition + 1 : 0}\nExecution phases: ${phases}`,
          "info",
        );
        return;
      }
      if (args === "cancel") {
        if (!(await cancelCurrent(ctx, true))) ctx.ui.notify("No active Grill Wizard workflow cancelled", "info");
        return;
      }
      if (args === "resume") {
        if (workflow.state === "answering" || workflow.state === "reviewing") await driveQuestionnaire(ctx);
        else if (workflow.state === "planning-orchestration") sendUserPrompt(ctx, buildExecutionPlanningMessage(workflow));
        else if (workflow.state === "reviewing-orchestration") await driveExecutionPlanReview(ctx);
        else if (workflow.state === "orchestrating") sendUserPrompt(ctx, buildOrchestrationResumeMessage(workflow));
        else if (workflow.state === "approved") {
          const reviewState = workflow.implementationMode === "subagents" && workflow.executionPlan
            ? "reviewing-orchestration"
            : "reviewing";
          setWorkflow(transitionState(workflow, reviewState), ctx);
          if (reviewState === "reviewing-orchestration") await driveExecutionPlanReview(ctx);
          else await driveQuestionnaire(ctx);
        } else if (workflow.state === "discovering" || workflow.state === "preparing-questionnaire") {
          sendUserPrompt(ctx, workflow.state === "discovering" ? discoveryPrompt(workflow.topic ?? "") : regenerationPrompt(workflow));
        } else ctx.ui.notify(`Nothing resumable in state '${workflow.state}'`, "warning");
        return;
      }
      if (args === "review") {
        if (!workflow.questionnaire) {
          ctx.ui.notify("No questionnaire available for review", "warning");
          return;
        }
        if (workflow.state === "reviewing-orchestration" && workflow.executionPlan) {
          await driveExecutionPlanReview(ctx);
          return;
        }
        if (!allQuestionsAnswered(workflow)) {
          if (workflow.state === "reviewing") setWorkflow(transitionState(workflow, "answering"), ctx);
          if (workflow.state === "answering") await driveQuestionnaire(ctx);
          return;
        }
        if (workflow.state === "answering" || workflow.state === "idle") setWorkflow(transitionState(workflow, "reviewing"), ctx);
        if (workflow.state === "approved") {
          const state = workflow.implementationMode === "subagents" && workflow.executionPlan
            ? "reviewing-orchestration"
            : "reviewing";
          setWorkflow(transitionState(workflow, state), ctx);
        }
        if (workflow.state === "reviewing") await driveQuestionnaire(ctx);
        else if (workflow.state === "reviewing-orchestration") await driveExecutionPlanReview(ctx);
        else ctx.ui.notify(`Review unavailable in state '${workflow.state}'`, "warning");
        return;
      }

      if (ctx.mode !== "tui") {
        ctx.ui.notify("grill-wizard requires interactive TUI mode", "error");
        return;
      }
      if (!["idle", "cancelled"].includes(workflow.state)) {
        const replace = await ctx.ui.confirm(
          "Replace active Grill Wizard workflow?",
          workflow.state === "orchestrating"
            ? `${activeChildrenStoppedMessage} Existing questionnaire, plan, and answers will be discarded.`
            : `Current state: ${workflow.state}. Existing questionnaire and answers will be discarded.`,
        );
        if (!replace) return;
      }

      let topic = args;
      if (!topic) {
        const proposed = deriveTopic(ctx);
        const edited = await ctx.ui.editor("Implementation topic:", proposed);
        if (edited === undefined || edited.trim() === "") return;
        topic = edited;
      }

      const baselineTools = gateApplied
        ? withoutWorkflowTools(restoredToolSet(processToolBaseline, workflow.toolsBeforeGate))
        : withoutWorkflowTools(pi.getActiveTools());
      workflow = workflow.state === "idle"
        ? beginWorkflow(topic, baselineTools)
        : restartWorkflow(workflow, topic, baselineTools);
      persist(ctx);
      gateTools(ctx);
      sendUserPrompt(ctx, discoveryPrompt(topic));
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === TOOL_NAME && (workflow.state === "implementing" || workflow.state === "orchestrating")) {
      const previous = buildNormalizedSpecification({ ...workflow, approvedSpecificationHistory: [] });
      setWorkflow(
        {
          ...transitionState(workflow, "answering"),
          approvedSpecificationHistory: [...(workflow.approvedSpecificationHistory ?? []), previous],
          approvedSessionId: undefined,
          implementationMode: undefined,
          executionPlan: undefined,
        },
        ctx,
      );
      gateTools(ctx);
    }

    const reason = mutationBlockReason(workflow.state, event.toolName, event.input);
    return reason ? { block: true, reason } : undefined;
  });

  function enterImplementation(ctx: ExtensionContext): void {
    if (workflow.state !== "approved") return;
    const next = workflow.implementationMode === "subagents" ? "orchestrating" : "implementing";
    setWorkflow(transitionState(workflow, next), ctx);
    restoreTools(ctx);
  }

  function isExpectedHandoff(text: string): boolean {
    return workflow.implementationMode === "subagents"
      ? text.includes(GRILL_ORCHESTRATION_MARKER)
      : text.includes(GRILL_HANDOFF_MARKER);
  }

  pi.on("message_start", async (event, ctx) => {
    if (workflow.state === "approved" && event.message.role === "user" && isExpectedHandoff(extractMessageText(event.message.content))) {
      enterImplementation(ctx);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (workflow.state === "approved" && isExpectedHandoff(event.prompt)) enterImplementation(ctx);

    if (workflow.state === "implementing") {
      return {
        message: {
          customType: "pi-grill-wizard-enforcement",
          content: "[GRILL WIZARD IMPLEMENTING] Follow approved specification exactly. Selected answers are authoritative. For a true contradiction or missing blocking decision, stop mutation and call grill_prepare_questionnaire with one small complete follow-up questionnaire; do not guess.",
          display: false,
        },
      };
    }
    if (workflow.state === "orchestrating") {
      return {
        message: {
          customType: "pi-grill-wizard-enforcement",
          content: "[GRILL WIZARD ORCHESTRATING] Main agent remains sole orchestrator. Follow the validated dependency DAG, use one writer at a time, never launch dependents after failed prerequisites, check every runs.all result .ok before launching dependents, reconcile async status/artifacts, and call grill_complete_implementation only after no child work remains. Children escalate missing decisions with contact_supervisor; parent pauses writers and opens follow-up Grill review.",
          display: false,
        },
      };
    }
    if (isGateActive(workflow.state)) {
      return {
        message: {
          customType: "pi-grill-wizard-enforcement",
          content: `[GRILL WIZARD STATE: ${workflow.state}] Project mutation is blocked. Use only read-only repository exploration. Do not write, patch, install, generate, migrate, or run mutating shell/Git commands.`,
          display: false,
        },
      };
    }
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (workflow.state === "implementing") {
      setWorkflow(transitionState(workflow, "idle"), ctx);
      applyToolsForState(ctx);
    }
  });

  function restoreFromCurrentBranch(ctx: ExtensionContext): void {
    const previousTools = workflow.toolsBeforeGate;
    try {
      const restored = restoreWorkflow(ctx);
      workflow = restored.workflow;
      if (!workflow.toolsBeforeGate?.length && previousTools?.length) workflow = { ...workflow, toolsBeforeGate: [...previousTools] };

      if (workflow.questionnaire) {
        const validation = validateQuestionnaire(workflow.questionnaire);
        if (!validation.valid) {
          workflow = { ...cloneWorkflowData(INITIAL_STATE), state: "cancelled", toolsBeforeGate: workflow.toolsBeforeGate };
        } else {
          workflow = sanitizeAnswers(workflow);
          if (["approved", "implementing", "orchestrating", "reviewing-orchestration", "planning-orchestration"].includes(workflow.state) && !allQuestionsAnswered(workflow)) {
            workflow = {
              ...workflow,
              state: "answering",
              approvedSessionId: undefined,
              implementationMode: undefined,
              executionPlan: undefined,
            };
          }
        }
      }

      if (workflow.executionPlan) {
        const validation = validateExecutionPlan(workflow.executionPlan);
        if (!validation.valid) workflow = { ...workflow, executionPlan: undefined };
      }

      const approvedSubagentPlanMissing = workflow.implementationMode === "subagents"
        && ["approved", "orchestrating", "reviewing-orchestration"].includes(workflow.state)
        && !workflow.executionPlan;
      if (approvedSubagentPlanMissing) {
        workflow = {
          ...workflow,
          state: "reviewing",
          implementationMode: undefined,
          executionPlan: undefined,
          approvedSessionId: undefined,
        };
        ctx.ui.notify("Restored subagent approval has no valid execution plan; returned to questionnaire review", "warning");
      }

      const needsQuestionnaire = [
        "answering", "reviewing", "planning-orchestration", "reviewing-orchestration",
        "approved", "implementing", "orchestrating",
      ].includes(workflow.state);
      if (needsQuestionnaire && !workflow.questionnaire) {
        workflow = { ...workflow, state: "cancelled", answers: {}, currentPosition: 0 };
      } else if (["reviewing-orchestration", "orchestrating"].includes(workflow.state) && !workflow.executionPlan) {
        workflow = { ...workflow, state: "reviewing", implementationMode: undefined, approvedSessionId: undefined };
      } else if (requiresApprovalReview(workflow, restored.sourceSessionId, ctx.sessionManager.getSessionId())) {
        const state = workflow.implementationMode === "subagents" && workflow.executionPlan
          ? "reviewing-orchestration"
          : "reviewing";
        workflow = { ...workflow, state, approvedSessionId: undefined };
        ctx.ui.notify("Restored approval requires review in this session", "warning");
      }
    } catch {
      workflow = { ...cloneWorkflowData(INITIAL_STATE), state: "cancelled", toolsBeforeGate: previousTools };
      ctx.ui.notify("Invalid Grill Wizard session state cancelled and gated", "error");
    }

    applyToolsForState(ctx);
    persist(ctx);
  }

  pi.on("session_start", async (_event, ctx) => restoreFromCurrentBranch(ctx));
  pi.on("session_tree", async (_event, ctx) => restoreFromCurrentBranch(ctx));
  pi.on("session_shutdown", async (_event, ctx) => {
    persist(ctx);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
