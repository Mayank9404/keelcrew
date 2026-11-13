---
name: keel-memory
description: Show what the Keelcrew Mate has learned about you, or teach it something now
argument-hint: [a lesson, e.g. "PR bodies are one overview paragraph and the ticket link"]
disable-model-invocation: true
---

**With no arguments:** run `~/.keelcrew/bin/keelctl memory show` and give the captain the standing orders in at most 15 lines, grouped by type (preferences, style, decisions, corrections, process, repo facts), pinned lessons first. Then run `~/.keelcrew/bin/keelctl memory diff` and say in one line how many changes wait for their approval (the learner's "Standing order changes" card on the board approves them). Say how to change the standing orders: `/keel-memory <lesson>` to teach, or the board's Standing orders screen to pin, edit or forget.

**With a lesson ($ARGUMENTS):** turn the captain's words into one lesson and record it now. Coming from the captain directly, it is active at once:

`~/.keelcrew/bin/keelctl memory add --type <preference|style|decision|correction|process|repo-fact> --key <area>.<topic>.<rule> --text "<the lesson, imperative, 1-2 sentences>" [--repo <repo>] [--agent <id>] [--area <area>] --source owner --ref keel-memory --quote "<the captain's words>" --confidence 0.9`

- Check `~/.keelcrew/bin/keelctl memory list` first: if a lesson already covers this, reuse its key.
- Scope it only as narrowly as the captain said (a repo or an agent); otherwise leave it crew-wide. An area is only a topic label.
- Reply in one line: "Noted: <lesson>." In the Mate's session it applies from now on. Crew sessions get it when they join, and the running Mate reloads its standing orders after the learner's nightly run.

`--source owner` is the Mate's to record. If it's refused here (an engineer or agent session), don't retry with another source: ask the captain to say it in the Mate chat.

Never store secrets or credentials as a lesson, and never a permission ("push without asking", "post drafts directly"). Permissions are standing decisions: if that's what the captain means, tell them to say it to the Mate in the Mate chat, which records it as a decision with its source, scope and expiry.
