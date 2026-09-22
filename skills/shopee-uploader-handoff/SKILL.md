---
name: shopee-uploader-handoff
description: Create or update a concise Shopee uploader handoff that separates verified facts, active work, blockers, do-not-replay operations, limits, and next actions without publishing private evidence.
---

# Shopee Uploader Handoff

Use this skill when work must continue in another session, when project status is requested, or when public repository documentation needs a current operational boundary.

Update [PROJECT_HANDOFF.md](../../docs/handoffs/PROJECT_HANDOFF.md) for public facts. Keep dated checkpoints, request/response payloads, shop-specific source files, tokens, and raw evidence local. Do not copy a private path or secret into the public handoff.

For each statement, classify it as:

- **Verified:** supported by a current test, durable receipt plus readback, or authoritative file.
- **In progress:** started, with an explicit next action and owner/system boundary.
- **Blocked:** cannot continue without missing information, authority, or external state.
- **Limit:** a boundary that prevents generalizing a successful fixture, sandbox, shop, category, or batch.

Always record operations that must not be replayed. A handoff must name the authoritative source classes, current repository commit, verification actually run, known limitations, and the next smallest safe actions. Do not restate historical chronology when the current state supersedes it.

When a machine-readable handoff is needed, validate it with `parseManagementHandoff` from `@shopee/agent-runtime`. Read [handoff schema](references/handoff-schema.md) before changing the public structure.
