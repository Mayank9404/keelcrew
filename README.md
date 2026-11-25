# Keelcrew

**A whole AI crew inside Claude Code. It builds, reviews, tests, writes and reports, and you decide what ships.**

<p align="center"><a href="#get-started"><img src="https://img.shields.io/badge/Install-one%20command-1f6feb?style=for-the-badge" alt="Install: one command"></a></p>
<p align="center">
  <a href="https://github.com/Mayank9404/keelcrew/releases"><img src="https://img.shields.io/github/v/release/Mayank9404/keelcrew?label=release" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="License: Apache-2.0"></a>
  <img src="https://img.shields.io/badge/platform-macOS-lightgrey" alt="Platform: macOS">
  <a href="https://code.claude.com/docs/en/plugins"><img src="https://img.shields.io/badge/Claude%20Code-plugin-5a4fcf" alt="A Claude Code plugin"></a>
</p>

<p align="center">
  <img src="docs/media/board.webp" alt="The Keelcrew board: the crew proposes a fix for a KeyError behind 37 production errors and you click Start it, a writer's release-notes draft is approved to post, then the Deck shows the crew at work aboard a 3D ship at night">
</p>

Keelcrew is a Claude Code plugin for the Mac. One Claude Code session, the **Mate**, runs a crew of others: an engineer for each ticket or task, in its own git worktree with a reviewer and QA behind it, agents for docs, release notes and data questions, and more you can switch on for support triage, product memos, inbox digests and morning briefs. Everything shows up on your own private **Keelcrew board**.

By default engineers push their branch and open their own PR; switch shipping to card mode and a ready PR waits for your signature. Agents that draft mail, chat replies, docs or release notes post only after you approve.

## Why Keelcrew

- **Real parallel work.** Four engineers by default, each in its own session and git worktree, so tickets keep moving while you're in a meeting.
- **Ticket to tested PR.** Jira tickets arrive on their own. A scout gathers context, the engineer builds, a fresh-eyes reviewer checks the exact commit, and QA tests each acceptance criterion once it's deployed.
- **Merges stay yours.** A policy hook in every crew session and a pre-push hook in every worktree refuse merges, force-pushes, `--no-verify`, and kubectl or terraform changes. A team pack can add rules, never remove one.
- **It learns how you work.** Your corrections, decisions and edits become lessons in a git repo you can read and undo. Switch on the nightly learner and, with your OK, it turns them into [standing orders](docs/crew.md#how-the-mate-learns) every new Mate session follows.
- **Watches while you work.** Switch on a morning brief and standup draft, a PR shepherd that chases stalled reviews and failing CI, fix suggestions from your repos, and a Monday tech-debt review. [See every agent](docs/crew.md).
- **Spend you can see.** Every task shows what it cost. Set a budget per ticket and the Mate warns at 85% and stops the task at 100% to ask you.
- **No Keelcrew server.** Crew files stay in `~/.keelcrew` on your Mac, the board is your own private claude.ai artifact, and Keelcrew sends no telemetry.
- **A board worth opening.** Sign-offs, tasks underway and a 3D Deck where every session is a sailor at its post, by day, dusk or night.

## Get started

> [!TIP]
> **One command in Terminal, or a few clicks in the Claude app.**
>
> **In Terminal, one line:**
>
> ```bash
> claude plugin install keelcrew --marketplace Mayank9404/keelcrew && open "claude://code/new?q=Set%20up%20Keelcrew"
> ```
>
> It installs Keelcrew and opens a new Code session in the Claude app with **Set up Keelcrew** typed in. Pick the folder that holds your repos and press Enter. No `claude` command yet? Run `curl -fsSL https://claude.ai/install.sh | bash` first.
>
> **Or in the Claude app, no Terminal:**
>
> 1. Open **Customize → Plugins → Add → Add marketplace**, enter `Mayank9404/keelcrew`, and click **Install** on Keelcrew.
> 2. Start a new Code session in the folder that holds your repos and send **Set up Keelcrew**.
>
> Prefer a command? Type `/keel-setup` instead; it does the same.
>
> **Then** answer setup's one message and click **Install** when the app asks. That session is now your Mate: tell it `start BRIN-123`, or just describe a task.

<sub>You need a Mac with the Claude desktop app (its Claude Code 2.1.326 or newer), Node 20 or newer, git, the GitHub CLI signed in (`gh auth login`) for pull requests, and a paid Claude plan (Pro or higher), since the board is a published artifact. [docs/install.md](docs/install.md) covers connectors, updating and removing.</sub>

## How it works

### 1. Ask the Mate

Tell the Mate what you need in its session. It answers with cards you can act on in the chat. Its look, Harbour light, puts the crew around the conversation: the lighthouse flies a pennant while something waits for you, and each engineer is a boat at the jetty.

<img src="docs/media/harbour-light.gif" alt="A recreation of the Mate's session in the Claude app, animated: its chat with a launch card, a crew card and a refused push, over a night harbour with today's watches, the crew moored at a jetty and a lighthouse sweeping its beam">

### 2. Watch the crew work

The board's Deck shows every session as a sailor at its post: working with a hand to the chin, waving a flag when it needs you, holding a mug when it's done. Each team has its own boat, and teams you've switched off stay moored. Drag to turn it, by night or by day.

<p>
  <img src="docs/media/deck.gif" width="49%" alt="The Deck at night, turning: the crew aboard a 3D ship with cabin lights, each sailor labelled by what it's doing">
  <img src="docs/media/deck-day.png" width="49%" alt="The Deck by day: the crew's ship at a sunny harbour, with teams on their own boats and each sailor labelled by what it's doing">
</p>

Underway lists the same work: stuck tasks first, then every task with its stage, checks and spend.

<img src="docs/media/underway.png" alt="Underway: stuck work first, then every task with its stage, checks, role and spend">

### 3. Sign off

With card mode on, a PR waits on a launch card: what was promised, what was shown, the commit it covers and its risk. Your signature approves that exact commit; a later commit needs a new one.

<img src="docs/media/signoff.gif" width="760" alt="Signing a launch card: ticking that the risk was checked, then one click to sign and open the pull request">

### 4. Step in when it matters

When a crew session hits a rule, it stops and the Mate brings you the call, with what it recommends.

<img src="docs/media/mate-chat.png" alt="The Mate's chat beside a card: an engineer paused by crew policy after five refused commands, with the Mate's recommendation">

The screens above use demo data. The Harbour light image is drawn by the theme's own code in a recreation of the app window, not a screenshot of the app.

## Good to know

- **It runs on your plan.** Every agent is its own Claude Code session and uses your plan's limits, and so does each scheduled job; at most 4 engineers work at once unless you change it. Only the engineer, reviewer, QA, scout, analyst, writer and Jira scan are on at first; scheduled jobs and push notifications stay off until you turn them on. Plan limits assume one person's ordinary use, and Anthropic's terms don't allow sharing an account, so use your own.
- **What the crew reads goes to Anthropic.** The code, tickets, mail and chats it reads are sent under your account's terms and data settings. On a personal plan (Pro or Max), check your privacy setting for model training before you point it at your employer's code.
- **Crew sessions run in Auto mode.** Setup turns it on for sessions in your Mate folder, so they don't stop on prompts. A policy hook in every session, and a pre-push hook in every worktree, refuse what the rules forbid. They read commands as text, so keep GitHub branch protection on the branches that matter.
- **The board is a private claude.ai artifact.** Only you see it unless you share it. A local helper extension lets it read crew state on your Mac and record your approvals. The app warns that a local extension can reach your Mac; this one reads `~/.keelcrew` and the crew's worktrees and starts nothing.
- **Early days.** macOS only, built and tested on Claude Code 2.1.326. Keep the Claude app open: scheduled jobs run only while it is.

## More

- [The crew](docs/crew.md): every agent, how the Mate learns, and the parts.
- [Architecture](docs/architecture.md): the contract every part is built to.
- [Contributing](CONTRIBUTING.md): run it from a checkout, test, release.
- [Changelog](CHANGELOG.md) and [Security](SECURITY.md): what changed, and how to report a problem.

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Keelcrew is an independent project, not made or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.
