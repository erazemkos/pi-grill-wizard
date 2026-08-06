import assert from "node:assert/strict";
import test from "node:test";
import grillWizardExtension from "../index.ts";
import { GRILL_HANDOFF_MARKER } from "../src/implementation-handoff.ts";
import type { GrillWorkflowData } from "../src/state.ts";
import { makeQuestionnaire } from "./fixtures.ts";

function approvedWorkflow(): GrillWorkflowData {
  const questionnaire = makeQuestionnaire();
  return {
    version: 1,
    state: "approved",
    questionnaire,
    answers: Object.fromEntries(
      questionnaire.questions.map((question) => [
        question.id,
        { kind: "alternative", alternativeId: question.alternatives[0].id },
      ]),
    ),
    currentPosition: 0,
    approvedSessionId: "session-a",
    toolsBeforeGate: ["read", "bash", "write", "grill_prepare_questionnaire"],
  };
}

test("approved snapshot stays gated until marked handoff turn", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  let activeTools = ["read", "bash", "write"];
  const entries: unknown[] = [];
  const workflow = approvedWorkflow();
  let branchEntries: unknown[] = [
    {
      type: "custom",
      customType: "pi-grill-wizard-state",
      data: { sessionId: "session-a", workflow },
    },
  ];

  const pi = {
    registerTool(definition: { name: string }) {
      if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
    },
    registerCommand() {},
    on(name: string, handler: (event: any, ctx: any) => any) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => ["read", "bash", "write", "grill_prepare_questionnaire"].map((name) => ({ name })),
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    sendUserMessage() {},
  };

  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-a",
      getBranch: () => branchEntries,
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
      notify() {},
    },
  };

  grillWizardExtension(pi as any);
  await handlers.get("session_start")![0]!({}, ctx);
  assert.equal(activeTools.includes("write"), false);

  const blocked = await handlers.get("tool_call")![0]!(
    { toolName: "write", input: { path: "x", content: "bad" } },
    ctx,
  );
  assert.equal(blocked.block, true);

  await handlers.get("before_agent_start")![0]!({ prompt: "unrelated prompt" }, ctx);
  assert.equal(activeTools.includes("write"), false);

  await handlers.get("message_start")![0]!(
    { message: { role: "user", content: `${GRILL_HANDOFF_MARKER}\nimplement` } },
    ctx,
  );
  assert.equal(activeTools.includes("write"), true);

  // Dormant branch: no workflow snapshot means the gate must release everything.
  branchEntries = [];
  await handlers.get("session_tree")![0]!({}, ctx);
  assert.equal(activeTools.includes("write"), true);
  assert.equal(
    await handlers.get("tool_call")![0]!({ toolName: "write", input: { path: "x", content: "ok" } }, ctx),
    undefined,
  );
  assert.equal(await handlers.get("before_agent_start")![0]!({ prompt: "unrelated" }, ctx), undefined);

  branchEntries = [
    {
      type: "custom",
      customType: "pi-grill-wizard-state",
      data: {
        sessionId: "session-a",
        workflow: {
          version: 1,
          state: "answering",
          questionnaire: { ...makeQuestionnaire(), questions: [null] },
          answers: {},
          currentPosition: 0,
        },
      },
    },
  ];
  await assert.doesNotReject(() => handlers.get("session_tree")![0]!({}, ctx));
  assert.equal(activeTools.includes("write"), true);
  assert.ok(entries.length > 0);
});

test("dormant startup leaves the active tool set untouched", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const initialTools = ["read", "bash", "write", "edit", "some_other_extension_tool"];
  let activeTools = [...initialTools];
  let setActiveToolsCalls = 0;

  const pi = {
    registerTool(definition: { name: string }) {
      if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
    },
    registerCommand() {},
    on(name: string, handler: (event: any, ctx: any) => any) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => activeTools.map((name) => ({ name })),
    setActiveTools(names: string[]) {
      setActiveToolsCalls += 1;
      activeTools = [...names];
    },
    appendEntry() {},
    sendUserMessage() {},
  };

  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "session-a", getBranch: () => [] },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
      notify() {},
    },
  };

  grillWizardExtension(pi as any);
  const toolsAfterRegistration = [...activeTools];
  await handlers.get("session_start")![0]!({}, ctx);

  assert.equal(setActiveToolsCalls, 0);
  assert.deepEqual(activeTools, toolsAfterRegistration);
  assert.equal(await handlers.get("before_agent_start")![0]!({ prompt: "unrelated" }, ctx), undefined);
  assert.equal(
    await handlers.get("tool_call")![0]!({ toolName: "write", input: { path: "x", content: "ok" } }, ctx),
    undefined,
  );
});

test("active questionnaire state gates tools and injects enforcement context", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  let activeTools = ["read", "bash", "write"];
  const questionnaire = makeQuestionnaire();

  const pi = {
    registerTool(definition: { name: string }) {
      if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
    },
    registerCommand() {},
    on(name: string, handler: (event: any, ctx: any) => any) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => ["read", "bash", "write", "grill_prepare_questionnaire"].map((name) => ({ name })),
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
    appendEntry() {},
    sendUserMessage() {},
  };

  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-a",
      getBranch: () => [
        {
          type: "custom",
          customType: "pi-grill-wizard-state",
          data: {
            sessionId: "session-a",
            workflow: {
              version: 1,
              state: "answering",
              questionnaire,
              answers: {},
              currentPosition: 0,
            },
          },
        },
      ],
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
      notify() {},
    },
  };

  grillWizardExtension(pi as any);
  await handlers.get("session_start")![0]!({}, ctx);
  assert.equal(activeTools.includes("write"), false);

  const blocked = await handlers.get("tool_call")![0]!(
    { toolName: "write", input: { path: "x", content: "bad" } },
    ctx,
  );
  assert.equal(blocked.block, true);

  const injected = await handlers.get("before_agent_start")![0]!({ prompt: "unrelated" }, ctx);
  assert.match(injected.message.content, /GRILL WIZARD STATE: answering/);
});
