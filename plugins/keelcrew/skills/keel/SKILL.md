---
name: keel
description: Show the crew at a glance (tasks, who needs you, agents at work) from the Keelcrew board
disable-model-invocation: true
---

Read `~/.keelcrew/config.json` with the Read tool for the Keelcrew board URL. With `ArtifactData`, read the board's `tasks` (a `query` with `where` `status` `not-in` `["done", "cancelled"]`), the open `inbox` cards (`where` `status` `==` `"open"`), `crew/lead` and `settings/main`, paging with `query.cursor` while there is a `next_cursor`. Run `~/.keelcrew/bin/keelctl status` for crew membership, live ship approvals and sessions paused by crew policy.

Reply in at most 10 lines: what each engineer and agent is on (key, agent, phase, one line, the row's `costUsd` when it has one), what is waiting on the captain (urgent cards first, then launch cards with their risk tier, then questions, QA verdicts and other cards), how many questions the Mate holds (`crew/lead.heldQuestions`) and the next time in `questionWindows`, any paused session or row over 85% of its budget, what's queued or proposed, and when the Mate last checked in (`crew/lead.heartbeatAt`, and say if it's paused). End with the board link.
