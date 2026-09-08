# TODO List

Open items only. Delete an item when it is done; never check it off or annotate it. A partly finished item is deleted and its remainder written as a new item.

## Deferred review findings

- **chore-claude-md-consolidate-1** (prompt-reviewer, 2026-09-08): the path-scoped rule files under .claude/rules/ may not load on some Claude Code builds, and CLAUDE.md no longer carries their directives inline -> in a fresh session, read a theme file matching one rule's paths and confirm that rule's content is in context; if it is not, switch the frontmatter to the form that loads or restore the directives to CLAUDE.md
- **chore-claude-md-consolidate-2** (doc-sync-checker, 2026-09-08): two workflow-side comments, one in deploy.yml and one in the retry helper script under .github/scripts, cite the CLAUDE.md deploy-gate section for a threat-model sentence that now lives only in docs/deploy-gate-reference.md, and sync.yml and deploy.yml also cite a "Token rotation call-site catalog" section that no longer exists -> repoint all of them in one workflow-comment PR reviewed by infra-reviewer
