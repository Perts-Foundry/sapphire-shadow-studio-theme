# TODO List

Open items only. Delete an item when it is done; never check it off or annotate it. A partly finished item is deleted and its remainder written as a new item.

## Deferred review findings

- **chore-claude-md-consolidate-1** (prompt-reviewer, 2026-09-08): the path-scoped rule files under .claude/rules/ may not load on some Claude Code builds, and CLAUDE.md no longer carries their directives inline -> in a fresh session, read a theme file matching one rule's paths and confirm that rule's content is in context; if it is not, switch the frontmatter to the form that loads or restore the directives to CLAUDE.md
