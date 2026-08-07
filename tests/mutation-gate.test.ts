import assert from "node:assert/strict";
import test from "node:test";
import {
  gateAllowsMutation,
  isGateActive,
  isReadOnlyShellCommand,
  mutationBlockReason,
  restoredToolSet,
  restrictedToolSet,
} from "../src/mutation-gate.ts";

test("permits demonstrably read-only shell commands", () => {
  for (const command of [
    "git status --short",
    "git log -5 --oneline",
    "rg TODO src | head -20",
    "find . -maxdepth 2 -type f",
    "npm list",
  ]) {
    assert.equal(isReadOnlyShellCommand(command), true, command);
  }
});

test("blocks mutation, shell injection, generators, and dangerous read-command flags", () => {
  for (const command of [
    "echo changed > file",
    "git checkout main",
    "git remote add origin example",
    "npm install lodash",
    "npm audit fix",
    "npx create-app demo",
    "find . -delete",
    "find . -fprint results.txt",
    "find . '-fprint' results.txt",
    "find . '-exec' git checkout main '{}' +",
    "tree '-oout.txt' .",
    "sort -oresults.txt input.txt",
    "sed -n 'w grill-mutated.txt' README.md",
    "less -Oout README.md",
    "date --set=2030-01-01",
    "fd --exec touch marker",
    "git diff --ext-diff",
    "git grep --open-files-in-pager='git checkout -- .' needle",
    "rg --pre 'touch marker' query",
    "git diff --output=patch.txt",
    "echo $(touch marker)",
    "git status & touch marker",
    "env sh -c 'echo bad'",
    "python script.py",
  ]) {
    assert.equal(isReadOnlyShellCommand(command), false, command);
  }
});

test("blocks mutating and unknown tools while a workflow is active", () => {
  assert.match(mutationBlockReason("reviewing", "write", { path: "x" }) ?? "", /blocks/);
  assert.match(mutationBlockReason("discovering", "apply_patch", {}) ?? "", /blocks/);
  assert.match(mutationBlockReason("answering", "third_party_generator", {}) ?? "", /blocks/);
  assert.equal(mutationBlockReason("discovering", "read", { path: "x" }), undefined);
  assert.equal(mutationBlockReason("discovering", "bash", { command: "git status" }), undefined);
});

test("inactive states never gate unrelated work", () => {
  for (const state of ["idle", "cancelled"] as const) {
    assert.equal(isGateActive(state), false);
    assert.equal(gateAllowsMutation(state), true);
    assert.equal(mutationBlockReason(state, "write", { path: "x" }), undefined);
    assert.equal(mutationBlockReason(state, "third_party_generator", {}), undefined);
    assert.equal(mutationBlockReason(state, "bash", { command: "npm install lodash" }), undefined);
  }
});

test("active pre-approval states stay gated", () => {
  for (const state of [
    "discovering",
    "preparing-questionnaire",
    "answering",
    "reviewing",
    "planning-orchestration",
    "reviewing-orchestration",
    "approved",
  ] as const) {
    assert.equal(isGateActive(state), true);
    assert.equal(gateAllowsMutation(state), false);
    assert.match(mutationBlockReason(state, "write", { path: "x" }) ?? "", /blocks/);
  }
});

test("approval remains gated until dedicated implementing turn", () => {
  assert.equal(gateAllowsMutation("approved"), false);
  assert.equal(gateAllowsMutation("implementing"), true);
  assert.equal(gateAllowsMutation("orchestrating"), true);
  assert.equal(gateAllowsMutation("reviewing"), false);
  assert.match(mutationBlockReason("approved", "write", {}) ?? "", /blocks/);
  assert.equal(mutationBlockReason("implementing", "write", {}), undefined);
  assert.equal(mutationBlockReason("orchestrating", "write", {}), undefined);
});

test("active tool restriction and restoration preserve current and withheld tools", () => {
  assert.deepEqual(restrictedToolSet(["read", "write", "bash", "custom"]), ["read", "bash"]);
  assert.deepEqual(restoredToolSet(["read", "new-tool"], ["read", "write"]), ["read", "new-tool", "write"]);
});
