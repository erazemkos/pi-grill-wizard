import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { answerText } from "./implementation-handoff.ts";
import {
  allQuestionsAnswered,
  moveQuestion,
  setAlternativeAnswer,
  setCustomAnswer,
  type GrillWorkflowData,
} from "./state.ts";

export type WizardOutcome = "completed" | "cancel-requested";

/** Wrap-around highlight movement inside one question's alternatives. */
export function cycleHighlight(current: number, delta: -1 | 1, total: number): number {
  if (total <= 0) return 0;
  const safeCurrent = Number.isInteger(current) && current >= 0 && current < total ? current : 0;
  return (safeCurrent + delta + total) % total;
}
export type ReviewAction = "implement" | "question" | "summary" | "regenerate" | "cancel";

function editorTheme(theme: ExtensionContext["ui"]["theme"]): EditorTheme {
  return {
    borderColor: (text) => theme.fg("accent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
}

function addWrapped(lines: string[], width: number, text: string, prefix = ""): void {
  const prefixWidth = visibleWidth(prefix);
  const available = Math.max(1, width - prefixWidth);
  const wrapped = wrapTextWithAnsi(text, available);
  wrapped.forEach((line, index) => lines.push(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${line}`));
}

export async function runQuestionnaireWizard(
  ctx: ExtensionContext,
  initial: GrillWorkflowData,
  onChange: (next: GrillWorkflowData) => void,
): Promise<{ outcome: WizardOutcome; data: GrillWorkflowData }> {
  if (ctx.mode !== "tui") throw new Error("Grill Wizard requires interactive TUI mode");
  if (!initial.questionnaire) throw new Error("Questionnaire is not prepared");

  let data = initial;
  const outcome = await ctx.ui.custom<WizardOutcome>((tui, theme, _keybindings, done) => {
    let highlighted = 0;
    let mode: "question" | "custom" | "search" | "answers" = "question";
    let cachedLines: string[] | undefined;
    let answerScroll = 0;
    let searchStatus = "";
    const customEditor = new Editor(tui, editorTheme(theme));
    const searchEditor = new Editor(tui, editorTheme(theme));

    const questions = data.questionnaire!.questions;

    function refresh(): void {
      cachedLines = undefined;
      tui.requestRender();
    }

    function update(next: GrillWorkflowData): void {
      data = next;
      onChange(next);
      refresh();
    }

    function currentQuestion() {
      return questions[data.currentPosition]!;
    }

    function syncHighlight(): void {
      const answer = data.answers[currentQuestion().id];
      if (answer?.kind === "alternative") {
        const index = currentQuestion().alternatives.findIndex((alternative) => alternative.id === answer.alternativeId);
        highlighted = index >= 0 ? index : 0;
      } else {
        highlighted = 0;
      }
    }

    function move(delta: -1 | 1): void {
      const currentPosition = moveQuestion(data.currentPosition, delta, questions.length);
      update({ ...data, currentPosition });
      syncHighlight();
    }

    function advanceAfterAnswer(): void {
      if (data.currentPosition < questions.length - 1) move(1);
      else if (allQuestionsAnswered(data)) done("completed");
    }

    customEditor.onSubmit = (value) => {
      if (value.length === 0) return;
      const question = currentQuestion();
      update(setCustomAnswer(data, question.id, value));
      customEditor.setText("");
      mode = "question";
      advanceAfterAnswer();
    };

    searchEditor.onSubmit = (value) => {
      const query = value.trim().toLowerCase();
      if (!query) {
        mode = "question";
        searchStatus = "Search cancelled";
        refresh();
        return;
      }
      const ordered = [
        ...questions.slice(data.currentPosition + 1),
        ...questions.slice(0, data.currentPosition + 1),
      ];
      const match = ordered.find((question) =>
        `${question.category} ${question.question} ${question.whyItMatters}`.toLowerCase().includes(query),
      );
      if (match) {
        update({ ...data, currentPosition: questions.findIndex((question) => question.id === match.id) });
        syncHighlight();
        searchStatus = `Found: ${match.id}`;
      } else {
        searchStatus = `No match for: ${value}`;
      }
      searchEditor.setText("");
      mode = "question";
      refresh();
    };

    syncHighlight();

    function handleInput(input: string): void {
      if (mode === "custom") {
        if (matchesKey(input, Key.escape)) {
          customEditor.setText("");
          mode = "question";
          refresh();
          return;
        }
        customEditor.handleInput(input);
        refresh();
        return;
      }
      if (mode === "search") {
        if (matchesKey(input, Key.escape)) {
          searchEditor.setText("");
          mode = "question";
          refresh();
          return;
        }
        searchEditor.handleInput(input);
        refresh();
        return;
      }
      if (mode === "answers") {
        if (matchesKey(input, Key.escape) || input === "r") {
          mode = "question";
          refresh();
        } else if (matchesKey(input, Key.up)) {
          answerScroll = Math.max(0, answerScroll - 1);
          refresh();
        } else if (matchesKey(input, Key.down)) {
          answerScroll += 1;
          refresh();
        } else if (input === "q") {
          done("cancel-requested");
        }
        return;
      }

      if (["1", "2", "3"].includes(input)) {
        highlighted = Number(input) - 1;
        refresh();
        return;
      }
      if (matchesKey(input, Key.up) || input === "k") {
        highlighted = cycleHighlight(highlighted, -1, currentQuestion().alternatives.length);
        refresh();
        return;
      }
      if (matchesKey(input, Key.down) || input === "j") {
        highlighted = cycleHighlight(highlighted, 1, currentQuestion().alternatives.length);
        refresh();
        return;
      }
      if (input === "4" || input === "e") {
        const answer = data.answers[currentQuestion().id];
        customEditor.setText(answer?.kind === "custom" ? answer.text : "");
        mode = "custom";
        refresh();
        return;
      }
      if (matchesKey(input, Key.enter)) {
        const question = currentQuestion();
        update(setAlternativeAnswer(data, question.id, question.alternatives[highlighted]!.id));
        advanceAfterAnswer();
        return;
      }
      if (matchesKey(input, Key.left) || input === "b") {
        move(-1);
        return;
      }
      if (matchesKey(input, Key.right) || input === "n") {
        move(1);
        return;
      }
      if (input === "r") {
        mode = "answers";
        answerScroll = 0;
        refresh();
        return;
      }
      if (input === "/") {
        mode = "search";
        searchStatus = "";
        refresh();
        return;
      }
      if (input === "q" || matchesKey(input, Key.escape)) done("cancel-requested");
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;
      const renderWidth = Math.max(1, width);
      const lines: string[] = [theme.fg("accent", "─".repeat(renderWidth))];

      if (mode === "answers") {
        addWrapped(lines, renderWidth, theme.bold("Answered questions"), " ");
        lines.push("");
        const answerLines: string[] = [];
        questions.forEach((question, index) => {
          const answer = data.answers[question.id];
          answerLines.push(`${index + 1}. [${question.category}] ${question.question}`);
          answerLines.push(`   ${answer ? answerText(question, answer) : "Unanswered"}`);
        });
        const visible = answerLines.slice(answerScroll, answerScroll + 28);
        visible.forEach((line) => addWrapped(lines, renderWidth, line, " "));
        lines.push("", theme.fg("dim", " ↑↓ scroll • r/Esc return • q cancel"));
        lines.push(theme.fg("accent", "─".repeat(renderWidth)));
        cachedLines = lines;
        return lines;
      }

      const question = currentQuestion();
      addWrapped(
        lines,
        renderWidth,
        theme.bold(`${data.questionnaire!.title} — Question ${data.currentPosition + 1}/${questions.length}`),
        " ",
      );
      addWrapped(lines, renderWidth, theme.fg("accent", `Category: ${question.category}`), " ");
      lines.push("");
      addWrapped(lines, renderWidth, question.question, " ");
      lines.push("");
      addWrapped(lines, renderWidth, theme.fg("muted", `Why it matters: ${question.whyItMatters}`), " ");
      if (question.dependsOn?.length) {
        addWrapped(lines, renderWidth, theme.fg("dim", `Depends on: ${question.dependsOn.join(", ")}`), " ");
      }
      lines.push("");

      question.alternatives.forEach((alternative, index) => {
        const selected = highlighted === index;
        const recommended = question.recommendedAlternativeId === alternative.id ? " [recommended]" : "";
        const marker = selected ? theme.fg("accent", "> ") : "  ";
        addWrapped(
          lines,
          renderWidth,
          theme.fg(selected ? "accent" : "text", `${index + 1}. ${alternative.label}${recommended}`),
          marker,
        );
        addWrapped(lines, renderWidth, theme.fg("muted", alternative.description), "     ");
        for (const consequence of alternative.consequences ?? []) {
          addWrapped(lines, renderWidth, theme.fg("dim", `• ${consequence}`), "     ");
        }
      });
      lines.push("");
      const current = data.answers[question.id];
      addWrapped(
        lines,
        renderWidth,
        theme.fg("success", `Current answer: ${current ? answerText(question, current) : "Unanswered"}`),
        " ",
      );
      if (searchStatus) addWrapped(lines, renderWidth, theme.fg("warning", searchStatus), " ");

      if (mode === "custom") {
        lines.push("");
        addWrapped(lines, renderWidth, theme.fg("accent", "Write my own answer (stored exactly as written):"), " ");
        customEditor.render(Math.max(1, renderWidth - 2)).forEach((line) => lines.push(` ${line}`));
        addWrapped(lines, renderWidth, theme.fg("dim", "Editor submit saves • Esc returns without saving"), " ");
      } else if (mode === "search") {
        lines.push("");
        addWrapped(lines, renderWidth, theme.fg("accent", "Search question text or category:"), " ");
        searchEditor.render(Math.max(1, renderWidth - 2)).forEach((line) => lines.push(` ${line}`));
      } else {
        lines.push("");
        addWrapped(
          lines,
          renderWidth,
          theme.fg("dim", "↑↓/jk or 1/2/3 highlight • 4/e custom • Enter accept • ←/b previous • →/n next"),
          " ",
        );
        addWrapped(lines, renderWidth, theme.fg("dim", "r review answers • / search • q/Esc request cancel"), " ");
      }
      lines.push(theme.fg("accent", "─".repeat(renderWidth)));
      cachedLines = lines;
      return lines;
    }

    return { render, handleInput, invalidate: () => { cachedLines = undefined; } };
  });

  return { outcome, data };
}

export function buildReviewLines(data: GrillWorkflowData): string[] {
  const questionnaire = data.questionnaire;
  if (!questionnaire) return ["No questionnaire prepared."];
  const lines = [
    `# ${questionnaire.title}`,
    "",
    "Original objective:",
    data.originalObjective ?? questionnaire.requestedOutcome,
    "",
    "Repository observations:",
    ...questionnaire.repositoryObservations.map((observation) => `- ${observation}`),
    "",
    "Decisions:",
  ];
  questionnaire.questions.forEach((question, index) => {
    lines.push(`${index + 1}. [${question.category}] ${question.question}`);
    lines.push(`   ${answerText(question, data.answers[question.id])}`);
  });
  lines.push(
    "",
    "Remaining assumptions:",
    ...questionnaire.assumptions.map((assumption) => `- ${assumption}`),
    "",
    "Deferred decisions:",
    ...questionnaire.areasIntentionallyDeferred.map((area) => `- ${area}`),
    "",
    "Proposed implementation phases:",
    ...questionnaire.proposedImplementationPhases.map((phase, index) => `${index + 1}. ${phase}`),
    "",
    "Proposed acceptance criteria:",
    ...questionnaire.proposedAcceptanceCriteria.map((criterion) => `- ${criterion}`),
  );
  if (data.implementationSummary !== undefined) {
    lines.push("", "Edited implementation summary:", data.implementationSummary);
  }
  return lines;
}

export async function showReviewScreen(ctx: ExtensionContext, data: GrillWorkflowData): Promise<ReviewAction> {
  if (ctx.mode !== "tui") throw new Error("Grill Wizard review requires interactive TUI mode");
  return ctx.ui.custom<ReviewAction>((tui, theme, _keybindings, done) => {
    let scroll = 0;
    let cachedLines: string[] | undefined;

    function refresh(): void {
      cachedLines = undefined;
      tui.requestRender();
    }

    function handleInput(input: string): void {
      if (input === "1") done("implement");
      else if (input === "2") done("question");
      else if (input === "3") done("summary");
      else if (input === "4") done("regenerate");
      else if (input === "5" || input === "q" || matchesKey(input, Key.escape)) done("cancel");
      else if (matchesKey(input, Key.up)) { scroll = Math.max(0, scroll - 1); refresh(); }
      else if (matchesKey(input, Key.down)) { scroll += 1; refresh(); }
      else if (matchesKey(input, Key.pageUp)) { scroll = Math.max(0, scroll - 15); refresh(); }
      else if (matchesKey(input, Key.pageDown)) { scroll += 15; refresh(); }
    }

    function render(width: number): string[] {
      if (cachedLines) return cachedLines;
      const renderWidth = Math.max(1, width);
      const body: string[] = [];
      buildReviewLines(data).forEach((line) => addWrapped(body, renderWidth, line, " "));
      const maxScroll = Math.max(0, body.length - 30);
      scroll = Math.min(scroll, maxScroll);
      const visible = body.slice(scroll, scroll + 30);
      const actions = [
        "",
        theme.fg("accent", theme.bold("Review actions")),
        "1. Start implementation",
        "2. Return to a specific question",
        "3. Edit generated implementation summary",
        "4. Regenerate entire questionnaire",
        "5. Cancel without making changes",
        theme.fg("dim", `↑↓/PgUp/PgDn scroll • ${scroll + 1}-${Math.min(scroll + 30, body.length)}/${body.length}`),
      ];
      cachedLines = [theme.fg("accent", "─".repeat(renderWidth)), ...visible, ...actions, theme.fg("accent", "─".repeat(renderWidth))];
      return cachedLines;
    }

    return { render, handleInput, invalidate: () => { cachedLines = undefined; } };
  });
}
