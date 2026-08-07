import assert from "node:assert/strict";
import test from "node:test";
import grillWizardExtension from "../index.ts";
import { GRILL_HANDOFF_MARKER, GRILL_ORCHESTRATION_MARKER } from "../src/implementation-handoff.ts";
import type { GrillWorkflowData } from "../src/state.ts";
import { makeExecutionPlan, makeQuestionnaire } from "./fixtures.ts";

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
  const entries: any[] = [];
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

  for (const executionPlan of [undefined, { phases: [], workflowScript: "bad" }]) {
    branchEntries = [{
      type: "custom",
      customType: "pi-grill-wizard-state",
      data: {
        sessionId: "session-a",
        workflow: {
          ...approvedWorkflow(),
          implementationMode: "subagents",
          executionPlan,
        },
      },
    }];
    await handlers.get("session_tree")![0]!({}, ctx);
    assert.equal(entries.at(-1).data.workflow.state, "reviewing");
    assert.equal(entries.at(-1).data.workflow.implementationMode, undefined);
    assert.equal(activeTools.includes("write"), false);
  }
});

test("dormant startup preserves active tools without reviving stale disabled tools", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const initialTools = [
    "read", "bash", "write", "edit", "some_other_extension_tool", "temporarily_unlisted_active_tool",
  ];
  let activeTools = [...initialTools];
  let setActiveToolsCalls = 0;
  let commandHandler: ((rawArgs: string, ctx: any) => Promise<void>) | undefined;

  const pi = {
    registerTool(definition: { name: string }) {
      if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
    },
    registerCommand(_name: string, definition: { handler: (rawArgs: string, ctx: any) => Promise<void> }) {
      commandHandler = definition.handler;
    },
    on(name: string, handler: (event: any, ctx: any) => any) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => [
      ...initialTools.filter((name) => name !== "temporarily_unlisted_active_tool"),
      "stale_disabled_tool",
      "grill_prepare_questionnaire",
    ].map((name) => ({ name })),
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
    sessionManager: {
      getSessionId: () => "session-a",
      getBranch: () => [{
        type: "custom",
        customType: "pi-grill-wizard-state",
        data: {
          sessionId: "session-a",
          workflow: {
            version: 1,
            state: "cancelled",
            answers: {},
            currentPosition: 0,
            toolsBeforeGate: [...initialTools, "stale_disabled_tool"],
          },
        },
      }],
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
      notify() {},
    },
  };

  grillWizardExtension(pi as any);
  // Loading must stay registration-only: Pi's pre-bind runtime throws on action methods.
  assert.equal(setActiveToolsCalls, 0);

  await handlers.get("session_start")![0]!({}, ctx);
  assert.equal(activeTools.includes("grill_prepare_questionnaire"), false);
  assert.deepEqual(activeTools, initialTools);
  assert.equal(activeTools.includes("stale_disabled_tool"), false);
  assert.equal(await handlers.get("before_agent_start")![0]!({ prompt: "unrelated" }, ctx), undefined);
  assert.equal(
    await handlers.get("tool_call")![0]!({ toolName: "write", input: { path: "x", content: "ok" } }, ctx),
    undefined,
  );

  await commandHandler!("activate through command", ctx);
  assert.equal(activeTools.includes("grill_prepare_questionnaire"), true);
  assert.equal(activeTools.includes("write"), false);
});

test("registered but inactive subagent option remains unavailable", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  let activeTools = ["read", "bash", "write"];
  let commandHandler: ((rawArgs: string, ctx: any) => Promise<void>) | undefined;
  let rendered: string[] = [];
  const questionnaire = makeQuestionnaire();
  const workflow: GrillWorkflowData = {
    version: 1,
    state: "reviewing",
    questionnaire,
    answers: Object.fromEntries(questionnaire.questions.map((question) => [
      question.id,
      { kind: "alternative", alternativeId: question.alternatives[0]!.id },
    ])),
    currentPosition: 0,
    toolsBeforeGate: ["read", "bash", "write"],
  };
  const pi = {
    registerTool(definition: any) {
      tools.set(definition.name, definition);
      if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
    },
    registerCommand(_name: string, definition: any) { commandHandler = definition.handler; },
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => [...new Set(["read", "bash", "write", "subagent", ...tools.keys()])].map((name) => ({ name })),
    setActiveTools(names: string[]) { activeTools = [...names]; },
    appendEntry() {},
    sendUserMessage() {},
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-a",
      getBranch: () => [{ type: "custom", customType: "pi-grill-wizard-state", data: { sessionId: "session-a", workflow } }],
    },
    ui: {
      theme,
      setStatus() {},
      notify() {},
      async custom(factory: any) {
        return await new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          rendered = component.render(100);
          component.handleInput("1");
        });
      },
    },
  };

  grillWizardExtension(pi as any);
  await handlers.get("session_start")![0]!({}, ctx);
  await commandHandler!("review", ctx);
  assert.match(rendered.join("\n"), /subagents \(unavailable/);
  assert.equal(activeTools.includes("write"), false);
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

test("subagent review path plans a DAG before restoring mutation tools", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  let activeTools = ["read", "bash", "write", "subagent", "subagent_wait"];
  const sent: string[] = [];
  const notifications: string[] = [];
  const entries: any[] = [];
  let subagentRegistered = true;
  let commandHandler: ((rawArgs: string, ctx: any) => Promise<void>) | undefined;
  const questionnaire = makeQuestionnaire();
  const workflow: GrillWorkflowData = {
    version: 1,
    state: "reviewing",
    questionnaire,
    answers: Object.fromEntries(questionnaire.questions.map((question) => [
      question.id,
      { kind: "alternative", alternativeId: question.alternatives[0]!.id },
    ])),
    currentPosition: 0,
    toolsBeforeGate: ["read", "bash", "write", "subagent", "subagent_wait"],
  };
  const uiInputs = ["2", "1"];
  const pi = {
    registerTool(definition: any) {
      tools.set(definition.name, definition);
      if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
    },
    registerCommand(_name: string, definition: any) { commandHandler = definition.handler; },
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => [...new Set([
      "read", "bash", "write", "subagent_wait",
      ...(subagentRegistered ? ["subagent"] : []),
      ...tools.keys(),
    ])].map((name) => ({ name })),
    setActiveTools(names: string[]) { activeTools = [...names]; },
    appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
    sendUserMessage(message: string) { sent.push(message); },
  };
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "session-a",
      getBranch: () => [{ type: "custom", customType: "pi-grill-wizard-state", data: { sessionId: "session-a", workflow } }],
    },
    ui: {
      theme,
      setStatus() {},
      notify(message: string) { notifications.push(message); },
      async custom(factory: any) {
        return await new Promise((resolve) => {
          const component = factory({ requestRender() {} }, theme, {}, resolve);
          component.handleInput(uiInputs.shift());
        });
      },
    },
  };

  grillWizardExtension(pi as any);
  await handlers.get("session_start")![0]!({}, ctx);
  await commandHandler!("review", ctx);
  assert.equal(entries.at(-1).data.workflow.state, "planning-orchestration");
  assert.equal(entries.at(-1).data.workflow.implementationMode, "subagents");
  assert.equal(activeTools.includes("write"), false);
  assert.equal(activeTools.includes("grill_prepare_execution_plan"), true);
  assert.match(sent.at(-1)!, /data-only dependency DAG/);

  const planTool = tools.get("grill_prepare_execution_plan");
  await planTool.execute("id", makeExecutionPlan(), undefined, undefined, ctx);
  assert.equal(entries.at(-1).data.workflow.state, "approved");
  assert.deepEqual(entries.at(-1).data.workflow.executionPlan, makeExecutionPlan());
  assert.equal(activeTools.includes("write"), false);
  assert.match(sent.at(-1)!, /sole orchestrator/);

  await handlers.get("message_start")![0]!({
    message: { role: "user", content: `${GRILL_ORCHESTRATION_MARKER}\nstart` },
  }, ctx);
  assert.equal(entries.at(-1).data.workflow.state, "orchestrating");
  assert.equal(activeTools.includes("write"), true);
  assert.equal(activeTools.includes("grill_complete_implementation"), true);

  await handlers.get("session_tree")![0]!({}, ctx);
  uiInputs.push("2", "1", "1");
  await commandHandler!("review", ctx);
  subagentRegistered = false;
  await planTool.execute("id-2", makeExecutionPlan(), undefined, undefined, ctx);
  assert.match(notifications.at(-1)!, /no longer available/);
  assert.equal(entries.at(-1).data.workflow.state, "approved");
  assert.equal(entries.at(-1).data.workflow.implementationMode, "direct");
  assert.equal(activeTools.includes("write"), false);
  assert.match(sent.at(-1)!, /GRILL WIZARD APPROVED SPECIFICATION/);
});

test("orchestration persists until explicit completion and supports resume, cancel, and follow-up", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const tools = new Map<string, any>();
  let activeTools = ["read", "bash", "write", "subagent", "subagent_wait"];
  let sessionId = "session-a";
  const sent: string[] = [];
  const confirmations: Array<{ title: string; message: string }> = [];
  const entries: any[] = [];
  let commandHandler: ((rawArgs: string, ctx: any) => Promise<void>) | undefined;
  const questionnaire = makeQuestionnaire();
  const workflow: GrillWorkflowData = {
    version: 1,
    state: "orchestrating",
    questionnaire,
    answers: Object.fromEntries(questionnaire.questions.map((question) => [
      question.id,
      { kind: "alternative", alternativeId: question.alternatives[0]!.id },
    ])),
    currentPosition: 0,
    approvedSessionId: "session-a",
    implementationMode: "subagents",
    executionPlan: makeExecutionPlan(),
    toolsBeforeGate: ["read", "bash", "write", "subagent", "subagent_wait"],
  };
  let branchEntries: any[] = [{
    type: "custom",
    customType: "pi-grill-wizard-state",
    data: { sessionId: "session-a", workflow },
  }];

  const pi = {
    registerTool(definition: any) {
      tools.set(definition.name, definition);
      if (!activeTools.includes(definition.name)) activeTools.push(definition.name);
    },
    registerCommand(_name: string, definition: any) { commandHandler = definition.handler; },
    on(name: string, handler: (event: any, ctx: any) => any) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getActiveTools: () => [...activeTools],
    getAllTools: () => [...new Set(["read", "bash", "write", "subagent", "subagent_wait", ...tools.keys()])].map((name) => ({ name })),
    setActiveTools(names: string[]) { activeTools = [...names]; },
    appendEntry(customType: string, data: unknown) { entries.push({ customType, data }); },
    sendUserMessage(message: string) { sent.push(message); },
  };
  const ctx = {
    mode: "tui",
    hasUI: true,
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => sessionId,
      getBranch: () => branchEntries,
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus() {},
      notify() {},
      async confirm(title: string, message: string) {
        confirmations.push({ title, message });
        return true;
      },
    },
  };

  grillWizardExtension(pi as any);
  await handlers.get("session_start")![0]!({}, ctx);
  assert.equal(activeTools.includes("write"), true);
  assert.equal(activeTools.includes("grill_complete_implementation"), true);
  assert.equal(activeTools.includes("grill_prepare_execution_plan"), false);

  await handlers.get("agent_settled")![0]!({}, ctx);
  assert.equal(entries.at(-1).data.workflow.state, "orchestrating");

  await commandHandler!("resume", ctx);
  assert.match(sent.at(-1)!, /reconcile subagent status and durable artifacts/);

  const complete = tools.get("grill_complete_implementation");
  await assert.rejects(
    () => complete.execute("id", {
      changedFiles: ["src/file.ts"], validation: ["tests pass"], childFailuresAndRetries: [], residualRisks: [], noActiveChildWork: false,
    }, undefined, undefined, ctx),
    /child work may still be active/,
  );
  await complete.execute("id", {
    changedFiles: ["src/file.ts"], validation: ["tests pass"], childFailuresAndRetries: [], residualRisks: [], noActiveChildWork: true,
  }, undefined, undefined, ctx);
  assert.equal(entries.at(-1).data.workflow.state, "idle");
  assert.equal(activeTools.includes("grill_complete_implementation"), false);

  branchEntries = [{ type: "custom", customType: "pi-grill-wizard-state", data: { sessionId: "session-a", workflow } }];
  await handlers.get("session_tree")![0]!({}, ctx);
  await handlers.get("tool_call")![0]!({ toolName: "grill_prepare_questionnaire", input: {} }, ctx);
  assert.equal(entries.at(-1).data.workflow.state, "answering");
  assert.equal(activeTools.includes("write"), false);

  branchEntries = [{ type: "custom", customType: "pi-grill-wizard-state", data: { sessionId: "session-a", workflow } }];
  await handlers.get("session_tree")![0]!({}, ctx);
  await commandHandler!("replacement objective", ctx);
  assert.match(confirmations.at(-1)!.message, /every active subagent run has already been stopped/);
  assert.equal(entries.at(-1).data.workflow.state, "discovering");

  branchEntries = [{ type: "custom", customType: "pi-grill-wizard-state", data: { sessionId: "session-a", workflow } }];
  await handlers.get("session_tree")![0]!({}, ctx);
  await commandHandler!("cancel", ctx);
  assert.match(confirmations.at(-1)!.message, /active subagent run has already been stopped/);
  assert.equal(entries.at(-1).data.workflow.state, "cancelled");

  sessionId = "session-b";
  branchEntries = [{ type: "custom", customType: "pi-grill-wizard-state", data: { sessionId: "session-a", workflow } }];
  await handlers.get("session_tree")![0]!({}, ctx);
  assert.equal(entries.at(-1).data.workflow.state, "reviewing-orchestration");
  assert.equal(activeTools.includes("write"), false);
});

test("factory registers without calling runtime action methods", () => {
  // Mirrors Pi's pre-bind runtime stubs: action methods throw during extension load.
  const notInitialized = () => {
    throw new Error("Extension runtime not initialized. Action methods cannot be called during extension loading.");
  };
  const pi = {
    registerTool() {},
    registerCommand() {},
    on() {},
    getActiveTools: notInitialized,
    getAllTools: notInitialized,
    setActiveTools: notInitialized,
    appendEntry: notInitialized,
    sendUserMessage: notInitialized,
    sendMessage: notInitialized,
  };

  assert.doesNotThrow(() => grillWizardExtension(pi as any));
});
