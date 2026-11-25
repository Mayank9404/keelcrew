# Changelog

All notable changes to Keelcrew are listed here. Versions follow [semantic versioning](https://semver.org); until 1.0, a minor version can change how things work.

## 0.2.0 (2026-11-26)

The first public release.

- **The Mate and its crew.** One Claude Code session, the Mate, staffs each ticket with an engineer in its own git worktree, with a scout before the spec, a fresh-eyes reviewer before the PR and QA after deploy. An analyst and a writer work on request; a contractor for mechanical tickets and a designer for Figma mockups join when you switch them on. Four engineer seats by default.
- **Jira intake and scheduled watches.** Jira intake every 30 minutes in working hours, plus watches that stay off until you switch them on: a morning brief and standup draft, a Friday retro, a PR shepherd, a daily health check, fix suggestions from your repos, weekly CTO and PM reviews, an inbox digest, release prep, and more.
- **Fixed rules.** A policy hook in every crew session and a pre-push hook in every worktree refuse merges, force-pushes, `--no-verify`, cluster and infrastructure changes and `psql` writes. By default engineers push their branch and open their own PR; in card mode a ready PR waits for your signature on a launch card tied to its exact commit. Agents that draft mail, replies, docs or release notes post only after you approve.
- **Learning.** Corrections, decisions and preferences become lessons in a git repo you can read and undo; switch on the learner and each weeknight it turns them into standing orders, with your OK.
- **The Keelcrew board.** Your own private claude.ai artifact: sign-offs, tasks underway with their stage, checks and spend, a 3D Deck of the crew, standing orders, the log, Mate chat and settings, in Day, Dusk or Night.
- **Harbour light.** The Mate's session in the Claude app wears its own look, with the crew moored at a jetty around the chat.
- **Team packs.** Repos, base branches, Jira, PR checks and extra rules for one team, written by setup; `packs/brinewick` shows the format.
- **Install in one line** from Terminal, or from the Claude app's plugin screen, then say **Set up Keelcrew**.
