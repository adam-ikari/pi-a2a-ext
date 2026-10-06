<!-- BEGIN brain.md -->
## Project Brain

This project keeps a **Project Brain**: a persistent memory layer of its durable decisions, requirements, and constraints. Read `./BRAIN.md` for the full read/write contract.

Maintain the brain as part of normal coding work — not as a separate task. While discussing or implementing features:
- **Start of a task:** load relevant context with the `brain` CLI (`list-pages`, `read-page`, `read-root`). Prefer a narrow read over scanning everything.
- **When a decision, requirement, constraint, or durable insight settles** (in chat or while coding): capture it immediately via the `brain` CLI. Do not wait to be asked and do not batch it for later.
- **Pure implementation with no new decision:** do not write to the brain.
- **When overturning a prior conclusion:** update the page (`update-truth` and/or `append-timeline` with `kind: reversal`, or `archive-page`).
- Only store what will still matter in six months and is hard to reconstruct from the code alone.
- All reads and writes go through the `brain` CLI — never hand-edit brain files.

The brain skills (`brain-setup`, `brain-page`, `brain-ingest`, `brain-bootstrap`) are installed in your global skills directory. Prefer `brain init` to scaffold a new project.
<!-- END brain.md -->

## What this is

Reuse the omp that is already running on this machine. Any MCP client — another omp, Claude Code, a curl script — points `mcp.json` at the endpoint and calls that omp's tools; the calls run in the host's `Main` session against real files and shell.

The bridge sends the call. It does not add meaning on the way.

## Principles

These follow from that one job, not from taste:

- **Don't rebuild what exists.** The host already has `read`/`bash`/`edit`. If a capability can be expressed with the host's own tools, write no new tool.
- **Don't implement a sandbox for omp.** The host already decides what its tools may touch. A second opinion about paths is a second authority, and nobody defined which one wins.
- **Don't filter on permission grounds.** `tools/list` is `pi.getAllTools()` verbatim — hidden tools and tools the host currently has disabled for its own model included. Whatever permissions omp has are the permissions the bridge has.
- **Don't grow a second system.** A bridge-owned tool bypasses the host's approval gate, so it would need its own sandbox — that is one decision, and both halves have to go together.

The test for a proposed change: does it make the bridge more transparent, or does it give the bridge an opinion? Anything that gives it an opinion is a second omp.

## The one exception on record

`POST /blob` gives the bridge two opinions it does not otherwise have: it resolves the path
itself (no root, no allowlist) and it writes without asking the host's approval gate. Both
are known costs, listed in `docs/protocol.md` under what the endpoint gives up. Everything
else here still decides.

## Writing voice

All user-facing prose in this repo (README, CHANGELOG, `docs/`, site copy, commit messages) is written in a specific voice. Read the `write-like-adam` skill before editing any of it — it carries the rules distilled from the prose already in this repo, plus a self-check (compare the paragraph against the CHANGELOG; if it reads more polished than the entries there, cut it back).

`humanizer` removes AI tells but does not supply the target voice. Use it together, not instead.

Diagrams go through the `design-doc-mermaid` skill. No ASCII art.
