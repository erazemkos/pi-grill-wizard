# pi-grill-wizard

Pi package that turns implementation requests into repository-aware decision questionnaires. Pi explores read-only, generates every question in one structured tool call, runs a keyboard wizard, shows complete review, and requires explicit approval before project mutation.

## Install

```bash
pi install git:github.com/erazemkos/pi-grill-wizard
```

For development from a local clone:

```bash
pi -e .
```

Package supplies extension only. `/grill-wizard` is sole entry point for Grill workflow activation.

## Commands

```text
/grill-wizard <topic>  Start discovery for topic
/grill-wizard          Propose topic from current conversation, then open editor
/grill-wizard status   Show state, answer count, and position
/grill-wizard resume   Resume current questionnaire, plan, or orchestration handoff
/grill-wizard review   Open available questionnaire or execution-plan review
/grill-wizard cancel   Cancel Grill workflow; does not undo changes or stop child runs
```

## Workflow

Explicit states:

```text
idle → discovering → preparing-questionnaire → answering → reviewing
                                                   ↑          ├→ approved → implementing → idle
                                               follow-up      └→ planning-orchestration
                                                   ↑                   ↓
                                                   └──── reviewing-orchestration
                                                                  ↓
                                                             approved → orchestrating
                                                                  ↓
                                                   grill_complete_implementation → idle
```

Gate activity by state:

| State | Gate | Tools |
| --- | --- | --- |
| `idle`, `cancelled` | dormant | normal |
| questionnaire and orchestration planning/review states, `approved` | active | read-only + current Grill structured tool |
| `implementing` | active | restored + follow-up questionnaire |
| `orchestrating` | active | restored + follow-up questionnaire + explicit completion |

State transitions are checked in code. Session snapshots preserve questionnaire, exact custom answers, position, summary, implementation mode, validated execution DAG, and state. Approval is bound to session ID. Inherited direct approval returns to questionnaire review; inherited subagent orchestration returns to execution-plan review.

## Mutation gate

Gate is dormant while workflow state is `idle` or `cancelled`. Questionnaire tool is inactive in dormant states, so its prompt guidance is absent until `/grill-wizard` activates workflow. An installed but uninvoked extension does not restrict normal tools, intercept tool calls, inject enforcement context, or occupy footer status.

While workflow is active and not yet implementing/orchestrating, extension keeps mutation blocked. `approved` records explicit review choice but remains gated until queued handoff starts a dedicated execution turn; this prevents later sibling tool calls from structured-tool batch bypassing handoff.

1. Restricts active tools to previously active read-only discovery tools plus only state-relevant Grill structured tools.
2. Intercepts every `tool_call` and fails closed for unknown/mutating tools.
3. Allows `bash` only when each command segment matches narrow read-only policy.

Blocked classes include file writes/edits/patches/replacements, mutating shell commands, Git mutation, package installation, generators, and database migrations. Shell policy rejects redirection, command/process substitution, dangerous flags, and unknown commands. Approval restores captured tools by merging still-registered names with current active set.

Because shell syntax is broad, classifier intentionally rejects commands it cannot prove read-only.

## Questionnaire contract

Model must call `grill_prepare_questionnaire` once with full questionnaire. Runtime validation checks:

- Non-empty questionnaire, maximum 100 questions.
- Unique question IDs and question text.
- Exactly three alternatives per question.
- Unique alternative IDs and non-duplicate meanings.
- At least one consequence for each alternative.
- Valid recommendations and dependencies.
- No self-dependencies or dependency cycles.
- Relevant product, architecture, scope, compatibility, errors, security, testing, migration, and delivery coverage or explicit deferral.
- Non-empty implementation phases and acceptance criteria.

Semantic quality cannot be proven fully by static validation.

## Wizard controls

| Key | Action |
| --- | --- |
| `Up`/`Down`, `k`/`j` | Cycle highlighted alternative (wraps) |
| `1`, `2`, `3` | Highlight proposed alternative directly |
| `4`, `e` | Open multiline custom-answer editor |
| `Enter`, `Right` | Accept highlighted alternative and continue |
| `Left`, `b` | Previous question |
| `n` | Next question without changing its answer |
| `r` | Review answered/unanswered questions |
| `/` | Search question/category text |
| `q`, `Escape` | Request cancellation; confirmation follows |

Custom answers are persisted exactly as editor returns them, including whitespace and newlines.

## Review actions

Review includes objective, repository observations, all decisions, custom answers, assumptions, deferred decisions, implementation phases, and acceptance criteria.

1. Implement directly.
2. Plan and implement with subagents.
3. Return to specific question.
4. Edit generated implementation summary.
5. Regenerate entire questionnaire.
6. Cancel without changes.

Subagent action is available only when `subagent` is registered and was active before Grill gating, so it can be restored safely. Availability is checked again before orchestration starts. Direct mode queues normalized specification while still gated; dedicated next agent turn enters `implementing` and restores tools.

### Dependency-aware subagent mode

Subagent mode has second approval stage. Mutation stays blocked while main agent submits data-only execution DAG through `grill_prepare_execution_plan`. Each phase has stable ID, title, objective, dependencies, kind (`analysis`, `implementation`, `validation`, `review`), scope, and acceptance criteria. Runtime rejects duplicate/unknown/self dependencies, cycles, unreachable phases, oversized plans, and implementation phases lacking final validation/review coverage. Raw workflow JavaScript is never accepted.

Execution-plan review actions:

1. Start orchestrated implementation.
2. Regenerate complete execution plan.
3. Return to questionnaire review.
4. Cancel.

Approved orchestration restores tools and keeps main agent as sole orchestrator. Main lists available subagents first, uses stable `workflowScript` phase keys, runs only dependency-ready work, checks every `runs.all` result `.ok` before launching dependents, parallelizes only ready read-only phases, and runs mutation phases sequentially in shared checkout with one writer. Failed prerequisites block dependents. Child prompts inherit authoritative answers and non-goals. Children escalate missing decisions through `contact_supervisor`; parent pauses writers and opens small follow-up Grill questionnaire.

`orchestrating` never auto-completes on `agent_settled`. Main must reconcile async status/artifacts and call `grill_complete_implementation` with changed files, validation, failures/retries, residual risks, and explicit confirmation no child work remains. Completion proof is self-attested and prompt-level; runtime validates payload shape and confirmation value but does not verify child status, artifacts, project changes, or test results. `/grill-wizard resume` reopens planning/review or reconciles orchestration without blindly rerunning completed phases. Starting a replacement workflow or cancelling during orchestration requires confirmation active child runs were stopped. Grill Wizard cannot stop child runs, and cancellation neither undoes project changes nor stops children.

## Tests

```bash
npm install
npm test
```

Tests exercise questionnaire and execution-DAG schemas, navigation, direct/subagent actions, cancellation/FSM, state restoration, mutation/approval gating, orchestration handoff and completion, cross-session review, malformed output, and size bounds.

## Limits

- TUI required. `ctx.ui.custom()` is unavailable in print/JSON/RPC custom-component modes.
- Shell allowlist favors safety over convenience.
- Other extensions can change active tools concurrently; restoration merges captured still-registered tools but Pi has no tool-lease API.
- Grill Wizard integrates with pi-subagents only through prompts and registered-tool discovery. It does not inspect private pi-subagents event names or stop child processes.
- Parallel writers are intentionally unsupported in shared checkout. Worktree integration/conflict policy remains future scope.
- Questionnaire semantic distinctness, execution-phase decomposition, and “already answered” detection still depend partly on model quality and repository evidence.
