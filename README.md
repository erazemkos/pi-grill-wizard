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
/grill-wizard resume   Resume questionnaire/review or restart preparation turn
/grill-wizard review   Open questionnaire/review flow
/grill-wizard cancel   Cancel without project changes
```

## Workflow

Explicit states:

```text
idle → discovering → preparing-questionnaire → answering → reviewing
                                                   ↑          ↓
                                               follow-up   approved → implementing → idle
                                                   ↘       cancelled
```

Gate activity by state:

| State | Gate | Tools |
| --- | --- | --- |
| `idle`, `cancelled` | dormant | normal |
| `discovering`, `preparing-questionnaire`, `answering`, `reviewing`, `approved` | active | read-only |
| `implementing` | active | restored |

State transitions are checked in code. Session snapshots use Pi custom entries on active session branch. Questionnaire, exact custom answers, current position, summary edit, and state survive resume. Approval is bound to session ID; inherited approval from another/forked session returns to review.

## Mutation gate

Gate is dormant while workflow state is `idle` or `cancelled`. Questionnaire tool is inactive in dormant states, so its prompt guidance is absent until `/grill-wizard` activates workflow. An installed but uninvoked extension does not restrict normal tools, intercept tool calls, inject enforcement context, or occupy footer status.

While a workflow is active and not yet implementing, extension keeps mutation blocked. `approved` records explicit review choice but remains gated until queued specification starts dedicated `implementing` agent turn; this prevents later sibling tool calls from questionnaire batch bypassing handoff.

1. Restricts active tools to previously active read-only discovery tools plus `grill_prepare_questionnaire`.
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

1. Start implementation.
2. Return to specific question.
3. Edit generated implementation summary.
4. Regenerate entire questionnaire.
5. Cancel without changes.

Only action 1 enters `approved`. Extension queues normalized specification as visible user message while mutation remains blocked. Dedicated next agent turn enters `implementing` and restores tools. Selected/custom answers remain authoritative. True blockers must use small complete follow-up questionnaire instead of guessed decisions.

## Tests

```bash
npm install
npm test
```

Tests exercise schema, three-alternative invariant, custom text preservation, navigation, cancellation/FSM, restoration, dormant-versus-active gate behavior, mutation blocking, approval gating, handoff, malformed output, and questionnaire size bounds.

## Limits

- TUI required. `ctx.ui.custom()` is unavailable in print/JSON/RPC custom-component modes.
- Shell allowlist favors safety over convenience.
- Other extensions can change active tools concurrently; restoration merges captured still-registered tools but Pi has no tool-lease API.
- Questionnaire semantic distinctness and “already answered” detection still depend partly on model methodology and repository evidence.
