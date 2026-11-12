---
name: keel-task
description: Hand the Keelcrew Mate any task (an investigation, a doc, a fix, a test run)
argument-hint: <what you want done>
disable-model-invocation: true
---

The captain is handing the crew this task: $ARGUMENTS

- **In the Mate's session:** use the keel-lead skill and handle it as an ad-hoc task now. Answer it directly if you can; otherwise create its `tasks/T-<n>` row, route it to the best agent that is on, and reply in one line with the key and who took it.
- **In any other session:** don't do the task here. Read `~/.keelcrew/config.json` with the Read tool for the Keelcrew board URL and add a new `requests` document with `ArtifactData` (`set` a new id such as `task-<unix seconds>`): `kind: "task"`, `text` (the captain's words, as given), `status: "open"`, `at` (epoch ms). Reply in one line that the Mate will pick it up within a minute and answer in the Mate chat.

If $ARGUMENTS is empty, ask the captain what they want done.
