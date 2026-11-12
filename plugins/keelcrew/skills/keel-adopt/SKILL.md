---
name: keel-adopt
description: Bring an existing Claude Code session into the crew as a ticket's engineer
argument-hint: <session id or title> <TICKET-KEY>
disable-model-invocation: true
---

Use the keel-lead skill. Adopt the existing session $ARGUMENTS as an engineer: find it with `list_sessions`, send it (`send_message`) the engineer brief (with the contract if the row has one, else write it first, and the newest `handoff` evidence id if earlier sessions worked on the task) with "You're joining the crew as the engineer for <KEY>. Start by using the keelcrew:keel-engineer skill.", create or update its `tasks/<KEY>` row on the board (read it first; `update` with `if_version`, or `set` only if it doesn't exist) with `status: "active"`, its `sessionId` and `sessionLink`, and `agents.engineer: {sessionId, sessionLink, status: "running"}`, and file it under the "Keelcrew" sidebar section. It keeps its full history. A session that already worked another ticket can't be adopted for this one (`keelctl register` refuses it, one engineer per ticket): start a fresh engineer instead.
