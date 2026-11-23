# The crew

Everything Keelcrew can staff, and the parts it's made of. Switch agents on or off in the board's Settings → Crew.

## Agents

| Agent | When | What you get |
|---|---|---|
| Engineer | per ticket | Plan, build, verify, review, then its branch and PR (in card mode, after your answer on a launch card) |
| Contractor | per mechanical ticket | Tests, lint, renames, docs or dependency bumps, shipped as a low-risk draft PR; anything else goes back to the Mate |
| Scout | before a spec | The related code, history, owners and open questions, so specs start from facts |
| Designer | frontend ticket that needs UI | Mockup frames in a new Figma file in your drafts, from the team's design system, with a card to use, change or skip the design |
| Reviewer | before the PR | A fresh-eyes review with a confidence per finding, tied to the exact commit |
| QA | after deploy | A pass or fail per acceptance criterion, with browser and API evidence |
| Analyst | on request | Read-only answers to data and investigation questions, with the method shown |
| Writer | on request | Docs, Confluence pages, release notes, email and Teams drafts, posted only after you approve |
| Scan, Briefs | scheduled | Jira intake every 30 minutes on weekdays; morning brief and standup draft, Friday retro |
| Learner | weekday nights | Turns your corrections, answers and edits into lessons, and posts changes to the standing orders for your approval |
| PR shepherd | every 2 hours, weekdays | Stalled reviews, failing CI and conflicts become exact to-dos |
| Health | weekdays 13:05 | Catches stuck, silent or lost sessions and drifted watches, reads what the panel's 2-hourly checks found (alerts, usage, budgets, disk), and reports to the Mate |
| CTO, PM | Mondays | A read-only architecture and tech-debt review with proposal cards; a product memo from usage, the backlog and your goals, with three suggested bets |
| Suggest | weekdays 9:00 and 18:00 | Scans the repos you pick for security issues, production errors, slow endpoints, CI and test gaps, code health and dependency risk, and proposes fixes; the Mate can line up small ones for you to start with one click |
| Comms, Release | weekdays 3 times; Thursdays | Inbox digest with reply drafts; weekly release prep |
| Chief of Staff, Marketing, Support | weekday mornings; Fridays; weekdays | Your cards ranked each morning with a Today note; Friday release notes and changelog drafts; customer issues turned into ticket and reply drafts |

Engineer, Scout, Reviewer, QA, Analyst, Writer and Scan are on by default. Every other agent starts off until you switch it on (setup asks which scheduled ones you want); Chief of Staff, Marketing and Support also need their team switched on.

## How the Mate learns

Every correction, decision, rejection with a reason and stated preference becomes a lesson in `~/.keelcrew/memory` (a git repo, so you can see and undo what it learned). A new lesson stays a candidate until it's seen twice or you approve it. When the learner is on, each weeknight it rebuilds the short list of standing orders, and every new Mate session starts with them loaded. The board's Standing orders screen lets you pin, edit or forget any lesson.

## The parts

| Part | Where | What it does |
|---|---|---|
| Plugin `keelcrew` | `plugins/keelcrew` | Skills for the Mate and every agent, commands (`/keel`, `/keel-setup`, `/keel-start`, `/keel-task`, `/keel-memory`, `/keel-adopt`), the policy and activity hooks, the `keelctl` command, the shared core, and the panel below. |
| Rules | `plugins/keelcrew/rules/rules.json` | The one source of the crew's fixed rules: ship choices, approval times (14 days at every risk tier), commands that are never allowed. A team pack can add rules, never remove one. |
| Team packs | `plugins/keelcrew/packs/<name>` | Everything specific to a team: repos, base branches, Jira, PR gate, extra rules. Setup writes yours; `packs/brinewick`, a made-up company, shows the format. |
| Agents | `plugins/keelcrew/agents/*.json` | One manifest per agent type ([agents.md](agents.md) explains how to add one). |
| Helper `keelcrew-local` | `plugins/keelcrew/helper` | A local MCP server the Claude app runs, so the board can see crew state, transcripts, diffs, costs and memory, open things in your apps, and record approvals. It runs no agents. |
| Panel | `plugins/keelcrew/hooks/register.tsx` | Runs inside Claude: wakes the Mate when you act on the board or an alert fires, shows each engineer's ticket, status, approval and PR above its prompt, and `/keel-panel` approves launch cards with a click. In the Claude app it dresses the Mate's session in the Harbour light look. |
| Keelcrew board | `board/` | The UI, published as your own private claude.ai artifact: sign-offs, tasks underway, the Deck, standing orders, the log, Mate chat and settings, in Day, Dusk or Night. |
