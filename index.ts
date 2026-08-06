import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  buildImplementationMessage,
  buildNormalizedSpecification,
  GRILL_HANDOFF_MARKER,
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
import { runQuestionnaireWizard, showReviewScreen } from "./src/questionnaire-ui.ts";
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
const STATUS_KEY = "pi-grill-wizard";

type DriveResult = "approved" | "regenerate" | "cancelled";

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
        workflow.state === "implementing" ? "success" : "warning",
        `grill:${workflow.state}${detail}`,
      ),
    );
  }

  function setWorkflow(next: GrillWorkflowData, ctx: ExtensionContext): void {
    workflow = next;
    persist(ctx);
  }

  function gateTools(ctx: ExtensionContext): void {
    const active = pi.getActiveTools();
    processToolBaseline = restoredToolSet(active, processToolBaseline);
    workflow = {
      ...workflow,
      toolsBeforeGate: restoredToolSet(processToolBaseline, workflow.toolsBeforeGate),
    };
    pi.setActiveTools([...new Set([...restrictedToolSet(active), TOOL_NAME])]);
    gateApplied = true;
    updateStatus(ctx);
  }

  function restoreTools(ctx: ExtensionContext): void {
    const registered = new Set(pi.getAllTools().map((tool) => tool.name));
    const restored = restoredToolSet(
      pi.getActiveTools(),
      restoredToolSet(processToolBaseline, workflow.toolsBeforeGate),
    ).filter((name) => registered.has(name));
    processToolBaseline = [...restored];
    pi.setActiveTools(restored);
    gateApplied = false;
    updateStatus(ctx);
  }

  function applyToolsForState(ctx: ExtensionContext): void {
    const shouldGate = isGateActive(workflow.state) && workflow.state !== "implementing";
    if (shouldGate) {
      gateTools(ctx);
      return;
    }
    // Dormant or implementing: only undo a restriction this extension applied.
    // Never rewrite the active tool set we never touched.
    if (gateApplied) restoreTools(ctx);
    else updateStatus(ctx);
  }

  function sendUserPrompt(ctx: ExtensionContext, message: string): void {
    if (ctx.isIdle()) pi.sendUserMessage(message);
    else pi.sendUserMessage(message, { deliverAs: "followUp" });
  }

  async function cancelCurrent(ctx: ExtensionContext, ask = true): Promise<boolean> {
    if (workflow.state === "idle" || workflow.state === "cancelled") return false;
    if (ask && ctx.hasUI) {
      const confirmed = await ctx.ui.confirm("Cancel Grill Wizard?", "Cancel without making project changes?");
      if (!confirmed) return false;
    }
    setWorkflow(transitionState(workflow, "cancelled"), ctx);
    applyToolsForState(ctx);
    return true;
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

      const action = await showReviewScreen(ctx, workflow);
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

      setWorkflow(
        {
          ...transitionState(workflow, "approved"),
          approvedSessionId: ctx.sessionManager.getSessionId(),
        },
        ctx,
      );
      gateTools(ctx);
      sendUserPrompt(ctx, buildImplementationMessage(workflow));
      return "approved";
    }
  }

  pi.registerTool({
    name: TOOL_NAME,
    label: "Prepare Grill Questionnaire",
    description:
      "Submit one complete pre-generated implementation decision questionnaire after read-only repository discovery. Every question must have exactly three distinct alternatives and consequences. Never call incrementally. During implementation, call only for a true contradiction or missing blocking decision.",
    promptSnippet: "Submit complete Grill Wizard questionnaire before implementation",
    promptGuidelines: [
      `Use ${TOOL_NAME} exactly once after complete read-only discovery; include all questions in that one call and never implement before explicit wizard approval.`,
      `During approved implementation, use ${TOOL_NAME} only for a true contradiction or missing blocking decision instead of guessing.`,
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
      if (!validation.valid) {
        throw new Error(`Malformed questionnaire:\n- ${validation.errors.join("\n- ")}`);
      }

      setWorkflow(
        {
          ...transitionState(workflow, "answering"),
          questionnaire,
          answers: {},
          currentPosition: 0,
          implementationSummary: undefined,
        },
        ctx,
      );
      applyToolsForState(ctx);
      const result = await driveQuestionnaire(ctx);
      const text =
        result === "approved"
          ? "Questionnaire approved explicitly. Approved specification queued as a user message for implementation."
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

  pi.registerCommand("grill-wizard", {
    description: "Prepare, resume, review, inspect, or cancel implementation questionnaire",
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
        ctx.ui.notify(
          `State: ${workflow.state}\nTopic: ${workflow.topic ?? "none"}\nAnswers: ${answered}/${total}\nPosition: ${total ? workflow.currentPosition + 1 : 0}`,
          "info",
        );
        return;
      }
      if (args === "cancel") {
        if (!(await cancelCurrent(ctx, true))) ctx.ui.notify("No active Grill Wizard workflow cancelled", "info");
        return;
      }
      if (args === "resume") {
        if (workflow.state === "answering" || workflow.state === "reviewing") {
          await driveQuestionnaire(ctx);
        } else if (workflow.state === "approved") {
          setWorkflow(transitionState(workflow, "reviewing"), ctx);
          await driveQuestionnaire(ctx);
        } else if (workflow.state === "discovering" || workflow.state === "preparing-questionnaire") {
          sendUserPrompt(ctx, workflow.state === "discovering" ? discoveryPrompt(workflow.topic ?? "") : regenerationPrompt(workflow));
        } else {
          ctx.ui.notify(`Nothing resumable in state '${workflow.state}'`, "warning");
        }
        return;
      }
      if (args === "review") {
        if (!workflow.questionnaire) {
          ctx.ui.notify("No questionnaire available for review", "warning");
          return;
        }
        if (!allQuestionsAnswered(workflow)) {
          if (workflow.state === "reviewing") setWorkflow(transitionState(workflow, "answering"), ctx);
          if (workflow.state === "answering") await driveQuestionnaire(ctx);
          return;
        }
        if (workflow.state === "answering" || workflow.state === "idle") {
          setWorkflow(transitionState(workflow, "reviewing"), ctx);
        }
        if (workflow.state === "approved") setWorkflow(transitionState(workflow, "reviewing"), ctx);
        if (workflow.state === "reviewing") await driveQuestionnaire(ctx);
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
          `Current state: ${workflow.state}. Existing questionnaire and answers will be discarded.`,
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

      const baselineTools = workflow.toolsBeforeGate ?? pi.getActiveTools();
      workflow =
        workflow.state === "idle"
          ? beginWorkflow(topic, baselineTools)
          : restartWorkflow(workflow, topic, baselineTools);
      persist(ctx);
      gateTools(ctx);
      sendUserPrompt(ctx, discoveryPrompt(topic));
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === TOOL_NAME && workflow.state === "implementing") {
      const previous = buildNormalizedSpecification({ ...workflow, approvedSpecificationHistory: [] });
      setWorkflow(
        {
          ...transitionState(workflow, "answering"),
          approvedSpecificationHistory: [...(workflow.approvedSpecificationHistory ?? []), previous],
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
    setWorkflow(transitionState(workflow, "implementing"), ctx);
    restoreTools(ctx);
  }

  pi.on("message_start", async (event, ctx) => {
    if (
      workflow.state === "approved" &&
      event.message.role === "user" &&
      extractMessageText(event.message.content).includes(GRILL_HANDOFF_MARKER)
    ) {
      enterImplementation(ctx);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (workflow.state === "approved" && event.prompt.includes(GRILL_HANDOFF_MARKER)) {
      enterImplementation(ctx);
    }

    if (workflow.state === "implementing") {
      return {
        message: {
          customType: "pi-grill-wizard-enforcement",
          content:
            "[GRILL WIZARD IMPLEMENTING] Follow approved specification exactly. Selected answers are authoritative. For a true contradiction or missing blocking decision, stop mutation and call grill_prepare_questionnaire with one small complete follow-up questionnaire; do not guess.",
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
      if (!workflow.toolsBeforeGate?.length && previousTools?.length) {
        workflow = { ...workflow, toolsBeforeGate: [...previousTools] };
      }

      if (workflow.questionnaire) {
        const validation = validateQuestionnaire(workflow.questionnaire);
        if (!validation.valid) {
          workflow = {
            ...cloneWorkflowData(INITIAL_STATE),
            state: "cancelled",
            toolsBeforeGate: workflow.toolsBeforeGate,
          };
        } else {
          workflow = sanitizeAnswers(workflow);
          if (
            ["approved", "implementing"].includes(workflow.state) &&
            !allQuestionsAnswered(workflow)
          ) {
            workflow = { ...workflow, state: "answering", approvedSessionId: undefined };
          }
        }
      }
      if (
        ["answering", "reviewing", "approved", "implementing"].includes(workflow.state) &&
        !workflow.questionnaire
      ) {
        workflow = { ...workflow, state: "cancelled", answers: {}, currentPosition: 0 };
      } else if (
        requiresApprovalReview(workflow, restored.sourceSessionId, ctx.sessionManager.getSessionId())
      ) {
        workflow = { ...workflow, state: "reviewing", approvedSessionId: undefined };
        ctx.ui.notify("Restored approval requires review in this session", "warning");
      }
    } catch {
      workflow = {
        ...cloneWorkflowData(INITIAL_STATE),
        state: "cancelled",
        toolsBeforeGate: previousTools,
      };
      ctx.ui.notify("Invalid Grill Wizard session state cancelled and gated", "error");
    }

    applyToolsForState(ctx);
    persist(ctx);
  }

  pi.on("session_start", async (_event, ctx) => {
    restoreFromCurrentBranch(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    restoreFromCurrentBranch(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    persist(ctx);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });

}
