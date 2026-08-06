---
name: grill-wizard-methodology
description: Method for generating complete implementation decision questionnaires with three distinct alternatives, repository-aware coverage, and testable acceptance criteria. Use while preparing a Grill Wizard questionnaire.
---

# Grill Wizard Methodology

Generate one complete questionnaire after read-only repository discovery. UI, state, approval, and mutation enforcement belong to extension; this skill governs question quality only.

## Establish known decisions first

Build decision ledger from:

1. Explicit user request and constraints.
2. Existing behavior, public APIs, conventions, manifests, configuration, tests, docs, and supported platforms.
3. Facts implied by repository architecture.
4. True open decisions.

Never ask user to choose facts already established by items 1–3. Record those facts as repository observations, assumptions, constraints, or acceptance criteria instead. Ask only when evidence conflicts or request intentionally changes established behavior.

## Coverage

Consider every area, then ask only relevant unresolved decisions:

- Product behavior: user-visible flows, defaults, outputs, interactions.
- Scope: included work, non-goals, edge cases, follow-on work.
- Architecture: ownership, boundaries, state, interfaces, dependencies.
- Compatibility: APIs, platforms, versions, configuration, accessibility.
- Error handling: validation, retries, recovery, cancellation, diagnostics.
- Security and privacy: trust boundaries, permissions, secrets, untrusted input, data retention.
- Testing: unit, integration, end-to-end, fixtures, negative cases, manual checks.
- Migration: existing data/config/API changes, rollback, staged rollout.
- Delivery: docs, packaging, release strategy, telemetry, operational checks.

If relevant area needs no question, establish it in observations/assumptions or name it under intentionally deferred areas with reason.

## Exactly three distinct alternatives

For every question:

1. Offer exactly three alternatives.
2. Make alternatives different strategies, not wording variants or arbitrary low/medium/high labels.
3. Keep alternatives mutually understandable and independently selectable.
4. State concrete behavior and implementation consequences for each.
5. Include meaningful trade-offs: complexity, compatibility, risk, performance, UX, maintenance, delivery cost.
6. Recommend only when repository evidence or objective favors one. Explain recommendation through description and consequences; do not hide alternative drawbacks.

Useful strategy shapes:

- Preserve existing behavior / additive enhancement / intentional breaking redesign.
- Local implementation / shared abstraction / external dependency.
- Fail closed / degrade gracefully / explicit user recovery.
- Immediate cutover / compatibility shim / staged migration.
- Focused tests / layered integration tests / full end-to-end validation.

Do not force these shapes when domain needs different strategies.

## Domain libraries

### CLI and terminal UI

Consider command syntax, non-interactive behavior, cancellation, keybindings, terminal width, accessibility, persistence, resume semantics, malformed input, and scripting compatibility.

### APIs and libraries

Consider public surface, versioning, defaults, error contracts, idempotency, concurrency, serialization, deprecation, and consumer migration.

### Data and databases

Consider schema ownership, consistency, transaction boundaries, backfill, rollback, retention, privacy, and large-data behavior.

### Authentication and security

Consider trust boundary, identity source, authorization, secret storage, logging/redaction, unsafe input, denial of service, and secure defaults.

### Frontend/product UI

Consider primary flow, empty/loading/error states, responsive behavior, accessibility, analytics, browser support, and rollout.

### Infrastructure and delivery

Consider environment parity, configuration, rollback, observability, failure domains, deployment order, and operational ownership.

### Refactors and migrations

Consider behavioral invariants, compatibility window, sequencing, codemods/backfills, rollback, deprecation, and proof of equivalence.

## Dependencies

Use `dependsOn` only when answering one question changes interpretation or relevance of another. Reference stable question IDs. Avoid cycles. Keep dependent question understandable in review.

## Acceptance criteria

Write observable, testable outcomes:

- Name behavior, input/trigger, and expected result.
- Include relevant negative/error paths.
- Include compatibility and migration checks when applicable.
- Name test level or user flow when useful.
- Avoid implementation-only phrasing such as “code is clean.”
- Avoid vague terms such as “works,” “properly,” or “fast” without measurable condition.
- Include no-mutation-before-approval and authoritative-answer behavior for Grill Wizard work.

## Final quality check

Before calling `grill_prepare_questionnaire`, confirm:

- Entire questionnaire is present in one call.
- IDs are unique and dependencies resolve without cycles.
- Every question has exactly three genuinely different alternatives.
- Every alternative has at least one consequence/trade-off.
- Repository/user-established decisions are not re-asked.
- Relevant coverage is present or explicitly deferred.
- Assumptions and deferred areas are explicit.
- Implementation phases are ordered.
- Acceptance criteria are observable.
- No implementation has begun.
