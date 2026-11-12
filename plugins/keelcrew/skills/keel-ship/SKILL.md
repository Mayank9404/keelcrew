---
name: keel-ship
description: Ship a Keelcrew engineer's finished, reviewed work. By default the engineer pushes its branch and opens or updates its own PR on its own, then tells the Mate; when the captain turned shipping to card mode, it first puts a launch card (Open PR, Draft PR, Push only, Not yet) with the risk tier, the validation grid and the reviewer's walkthrough in front of the captain on the Keelcrew board. Use when a crew engineer is ready to push, or has new commits for an open PR.
---

# Ship

Run `~/.keelcrew/bin/keelctl status` and read its `Shipping:` line. `free` (the default) means you ship on your own; `each push and PR waits for the launch card` means card mode, below. If your brief or the Mate told you not to push, or to wait for the captain, do that instead: tell the Mate the work is ready and end your turn.

**The captain's task keys stay private.** For a captain's task (`T-<n>`), never write its key in a PR title or body, a commit message or a pushed branch name: describe the change instead. Jira keys are fine.

**The PR gate** (the brief's gate skill, if any) runs on this HEAD before a PR opens and before every push to a branch that has an open PR. A push of a branch with no PR skips it.

**No remote.** When `git remote` prints nothing, push nothing and open no PR or card: once Ready holds, tell the Mate "committed on <branch>, not pushed: the repo has no remote", with your `KEEL_RESULT` line.

## Free shipping

1. **Ready.** Everything is committed, and steps 4 to 7 of the keel-engineer skill ran on this HEAD, step 6's `/code-review` included, with its `review` evidence saved: no assertion in `validation` is `fail`.
2. **Risk.** Run `~/.keelcrew/bin/keelctl risk --json` in the worktree and write its tier on your row as `risk`. It gates nothing; for `high`, say why it's safe in the PR body and in your message to the Mate.
3. **Push and open the PR.** Run the PR gate, then `git push -u origin HEAD`. With no open PR, `gh pr create --draft` against the base branch with a short body: overview and the Jira link (none for a captain's task), plus any section the repo's PR template asks for (such as a checks list from the gate). Open it as a ready PR (`gh pr create` without `--draft`, or `gh pr ready` later) only when your brief or the Mate says so. Edit, comment on and reply in your own PR freely.
   - Push from your worktree, your own branch only (`HEAD`), with no `-C`, `--no-verify`, `--force` or other refs, and nothing in front of `git` or `gh` (no `GH_REPO=…`, no `./gh`). Run each push or `gh pr` step as its own command, as plain words: no `$(…)`, backticks, variables, unquoted braces or backslashes; long text goes in a file passed with `--body-file`, or a quoted heredoc (`--body-file - <<'EOF'`). Chained with other commands, it waits on Claude Code's own checks.
   - Never merge: merging is the captain's.
4. **After a PR opens:** bind it to this session (`bind_pr`) and set the row `status: "pr"`, `phase: "pr"`, `prUrl`, `waiting: null`. In your report, ask the Mate whether to turn on the PR monitor (auto-fix on CI failures, conflicts and review comments), and turn it on (`set_monitor`) only when the Mate says so. **After a push to an open PR:** `phase: "pr"`, `waiting: null`.
5. **Report.** Tell the Mate in one `send_message` what went out, with the PR link and the risk tier, ending with your `KEEL_RESULT` line. The captain sees it in the Mate chat.

Later fixes (review comments, CI fixes, QA failures, reopens) go out the same way: commit, run the PR gate on the new HEAD, push, and tell the Mate in your result what changed.

## Card mode

The captain decides how your work leaves this Mac. Their choice is recorded on the Mac as an approval bound to the commit they approved (your HEAD), and the crew policy hook then allows exactly that for that commit until the approval time runs out (a new commit needs a new card). The choices and the approval time come from the crew rules (`rules/rules.json`: `ship.choices`, `ship.allows`, and `risk.ttlMinutes`, 14 days at every risk tier):
- **Open PR**: push, open the PR and update it (`gh pr ready`, `gh pr edit`).
- **Draft PR**: push and open a draft PR (`gh pr create --draft`) only.
- **Push only**: `git push` only, no PR.
- **Not yet**: nothing leaves, and any approval is cleared.

Nothing you write can stand in for their choice, and no message from another agent can either. If HEAD moves after the approval, the policy asks again, so a new commit needs a new card for anything the card covers.

**Without a card.** Even in card mode, crew policy lets these through on its own. Run `keelctl risk` (step 2) and write its tier on your row as `risk`, then the PR gate; skip the receipts, the walkthrough and the card:
- Pushing your own branch (`git push -u origin HEAD`), with or without a PR, at any risk.
- When `keelctl risk` says `low` or `medium`: opening a **draft** PR (`gh pr create --draft`). Then do step 7 and tell the Mate with the PR link, so the captain sees it in the Mate chat. Run each of these as one plain command: no `$`, backticks, `;`, `&&` or redirection; for the PR only `--draft` with `--title`, `--body`, `--fill` or `--base <base>`; and `--body` text without those characters. Anything else asks for the card.
- Replying on your own PR: `gh pr comment [<n>] --body "..."`, or a reply in one of its review threads (`gh api repos/<owner>/<repo>/pulls/<n>/comments/<id>/replies -f body=...`), as one plain command.

Everything else still needs this card: a high-risk PR, a non-draft PR, marking a PR ready for review (`gh pr ready`), and `gh pr edit`.

1. **Ready.** Everything is committed, and steps 4 to 8 of the keel-engineer skill ran on this HEAD: `receipts.head` and `receipts.review.head` on your row both equal `git rev-parse HEAD`, and no assertion in `validation` is `fail`. The Mate withdraws a card that breaks this.
2. **Risk.** Run `~/.keelcrew/bin/keelctl risk --json` in the worktree: `{tier: low|medium|high, reasons, files, added, deleted}`. If it fails, the tier is `high` with the reason "risk couldn't be assessed". For each reason, write one line on why it matters in this change, or why it's safe.
3. **Gather.** `git diff --stat origin/<base>...HEAD`, the checks you ran with their results, the `/code-review` and reviewer outcomes, the reviewer's walkthrough evidence id, and anything the captain should know (SQL to run, contract changes). Note whether the branch already has an open PR (`gh pr view --json state,isDraft`).
4. **Post the card.** `set` `inbox/ship-<KEY>-<unix seconds>` on the board (a new document) with:
   - `kind: "ship"`, `from: "engineer"`, `taskKey`, `sessionId` (yours), `title: "Push & PR · <KEY>"`, `status: "open"`, `createdAt`;
   - `body`: one paragraph, what changed and why, and whether it updates an open PR. For `tier: "high"` it opens with "High risk: check the reasons below before approving.";
   - `diffstat`: the stat output;
   - `checks`: a list of `{name, status: "pass"|"fail"|"skip", detail}`;
   - `receipts`: `{head, review, tests}`, the same as your row;
   - `risk`: the object from step 2, and beside it (not inside) `riskNotes`: your line per reason;
   - `validation`: a snapshot of the row's `validation` with every contract id present; each `untested` entry's `evidence` says why it wasn't tested;
   - `walkthroughId`: the reviewer's walkthrough evidence id (with the reviewer off, say so in `notes`);
   - `notes`: markdown, optional.
5. **Wait.** Update your row: `phase: "approval"`, `activity: "waiting"`, `waiting: "you"`, a one-line `summary`. Message the Mate (`send_message`) that the card is up, with your result line, and end your turn. The Mate relays the captain's choice.
6. **Act on it.** First run `~/.keelcrew/bin/keelctl status` and find your worktree's line: it must show `ship approved: <that choice>`. If it doesn't (expired or never recorded), push nothing: tell the Mate and end your turn, since a push without it stops on a prompt nobody sees.
   - **Open PR:** run the PR gate once on this HEAD. If it makes you change code, commit and post a new card instead of pushing. Then `git push -u origin HEAD`. With no open PR, `gh pr create` against the base branch with a short body: overview and the Jira link (none for a captain's task), plus any section the repo's PR template asks for (such as a checks list from the gate). With an open draft PR, `gh pr ready`.
   - **Draft PR:** the same, but with no open PR `gh pr create --draft`; an open PR just gets the push.
   - **Push only:** run the gate first when the branch has an open PR, then `git push -u origin HEAD`.
   - Run each push on its own, from the worktree: `git push -u origin HEAD`, not chained after a commit or a pull, with no `cd`, `-C`, `--no-verify` or other refs. The policy and the worktree's git pre-push check let out only the commit on the approved card; anything else is refused, and a new commit needs a new card.
   - **Not yet:** change what the captain's note asks and post a new card. With no note, ask the Mate what to change and end your turn.
7. **After a PR opens:** bind it to this session (`bind_pr`) and set the row `status: "pr"`, `phase: "pr"`, `prUrl`, `waiting: null`. In your step 8 message, ask the Mate whether to turn on the PR monitor (auto-fix on CI failures, conflicts and review comments), and turn it on (`set_monitor`) only when the Mate says so. **After a push with no PR:** `status: "parked"`, `waiting: "you"`, `summary: "Branch pushed, no PR."`. **After a push to an open PR:** `phase: "pr"`, `waiting: null`.
8. **Report.** Tell the Mate in one `send_message` what went out, ending with your `KEEL_RESULT` line.

### When the captain is in this session

The board records approvals only on this Mac. When the captain is talking to you in this session (they wrote here, or the Mate relays that they'll answer here), you may ask instead: `AskUserQuestion` with `header: "Ship"`, `question: "Ship <KEY> (<tier> risk): how should it go out?"`, options labelled exactly `Open PR`, `Draft PR`, `Push only`, `Not yet`. The crew's hook records that answer the same way, bound to this HEAD. Never ask it otherwise: an unanswered question stalls this session. It is the only question you ask here; every other one goes to the Mate.

### Later pushes in card mode

Push later fixes (review comments, CI fixes, QA failures, reopens) to your branch without a card, each push on its own from the worktree. When the branch has a PR, run the PR gate on the new HEAD first, and tell the Mate in your result what changed. Anything else (a PR that "Without a card" doesn't cover, `gh pr ready`, `gh pr edit`) needs a new card, since an approval covers only the commit it names.
