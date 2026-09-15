# Historical documentation — not instructions

Status: archived. **Exclude this directory from routine agent retrieval.** Open a named section only
when tracing a historical decision or reproduction. Commands, paths, APIs, tests, and status labels
below describe old checkouts and may be unsafe or wrong today. Never execute an archived recipe
without deriving a safe procedure from current source and [the device workflow](../ship.md).

| Record | Contents | Current replacement |
|---|---|---|
| [Implementation plan](implementation-plan.md) | Old T1–T17 slices, § references, decisions, retired design metrics | [Current behaviour](../current.md) |
| [Issue history](issues-history.md) | Investigations, open/fixed labels, device evidence | [Issue triage](../issues.md) |
| [Device verification](device-verification.md) | Original cases, historical ticks and walk notes | [Test index](../../TESTS.md) |
| [Ribbon study](ribbon-redesign.md) and [Accessory](ribbon/spec-accessory.md), [Compact](ribbon/spec-compact.md), [Reader](ribbon/spec-reader.md) | Competing proposals and corrections for a feature removed 2026-09-01 | No active replacement; do not rebuild the ribbon |
| [Ribbon walk](ribbon/device-walk.md) | Obsolete worktree, removed case IDs, user-driven historical walk | [Device workflow](../ship.md) |
| [Ribbon HTML report](ribbon/report.html) | Companion visual research artifact, moved unchanged with the retired feature docs | Historical only; not an app screen or current design |

The original bodies are retained for evidence, including contradictions and "corrections override"
sections. An archive banner does not validate those statements. Some unsafe standalone commands were
replaced with comments; git history preserves the original text. No historical tick certifies the
current checkout. Local asset/worktree references can be unavailable; do not recover deleted designs.

Place future lengthy investigations here only after leaving a short current decision/issue summary
outside the archive. Do not automatically load this index or its linked documents into every session.
