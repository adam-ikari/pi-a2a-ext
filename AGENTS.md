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

## Writing voice

All user-facing prose in this repo (README, CHANGELOG, `docs/`, site copy, commit messages) is written in a specific voice. Read the `write-like-adam` skill before editing any of it — it carries the rules distilled from the prose already in this repo, plus a self-check (compare the paragraph against the CHANGELOG; if it reads more polished than the entries there, cut it back).

`humanizer` removes AI tells but does not supply the target voice. Use it together, not instead.

Diagrams go through the `design-doc-mermaid` skill. No ASCII art.
