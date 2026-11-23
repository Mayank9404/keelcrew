# Installing Keelcrew

About 15 minutes on a Mac with the Claude desktop app, signed in on a paid Claude plan (Pro or higher), since the board is a published artifact. You need:

- Node 20 or newer (for `keelctl` and the crew's hooks; the board's helper runs on the Claude app's own Node);
- git, and the GitHub CLI (`gh`) signed in;
- `jq` for the scheduled agents (macOS 15 and later include it; `brew install jq` otherwise);
- connectors for the agents that use them, added in the Claude app under Settings → Connectors: Atlassian for Jira intake, Outlook and Teams for Comms, Datadog for PM and the Analyst, Figma for the Designer. Everything else works without them.

## 1. Install the plugin

In Terminal, add this repository as a plugin marketplace, install the plugin from it, and open a new Code session in the Claude app with `/keel-setup` typed in, in one line:

```bash
claude plugin marketplace add Mayank9404/keelcrew && claude plugin install keelcrew@keelcrew && open "claude://code/new?q=%2Fkeel-setup"
```

The last part is the Claude app's own link for a new Code session (`q` fills in the prompt without sending it). If it doesn't open, start a Code session yourself and type `/keel-setup`.

This needs Claude Code's `claude` command, 2.1.326 or newer (`brew install --cask claude-code` if you don't have it; `claude --version` shows yours). That's the version Keelcrew is tested on; an engine without `$.theme` doesn't load the panel, since the panel guards its look with a hook on it.

Sessions that start from now on load it; a session already open picks it up with `/reload-plugins`.

## 2. The board's helper

The board reaches your Mac through `keelcrew-local`, a small local helper the Claude app runs. Setup adds it for you as a Claude app extension: the app shows an Install dialog, you click **Install**, and it runs at once, with no restart and with the app's own Node. The dialog warns that a local extension can reach everything on your computer; that is true of any local helper, this one included. It reads and writes only under `~/.keelcrew` and in your crew's worktrees. The extension runs `~/.keelcrew/bin/keelcrew-helper`, which Keelcrew points at the installed plugin whenever a session starts, so a plugin update never needs a new install. To add it again: `~/.keelcrew/bin/keelctl helper bundle --open`.

If your organization blocks extensions, add it to the app's config instead. The app reads that only when it starts, so in Terminal this quits the app, adds the helper and opens the app again (with node 22 or newer: the one running it, else the newest found in nvm, Homebrew or /usr/local):

```bash
~/.keelcrew/bin/keelctl helper install --restart
```

It adds only the `keelcrew-local` entry to `~/Library/Application Support/Claude/claude_desktop_config.json`, keeping a copy of the file as it was (`.keelcrew-backup`). If your repos are in Desktop, Documents or Downloads, macOS must let that node into the folder: allow it when macOS asks.

## 3. Run setup

In a Code session opened in the folder that holds your repos (your Mate folder), run `/keel-setup`. You answer one message and click Install once; it does the rest, and the session becomes your Mate. It:

1. finds the git repos in that folder and their base branches, checks for the Atlassian connector and whether the helper answers;
2. asks, in one message: your name, whether those repos are right, a short team name, and where your tasks come from (the board, or Jira too). The Mate keeps the session's model and effort; the Claude app starts no crew session above them, so a Sonnet Mate keeps the whole crew on Sonnet;
3. opens the helper's Install dialog in the Claude app when the helper isn't there yet (see above);
4. writes your team pack to `~/.keelcrew/packs/<team>` from those answers (`keelctl pack init`), which you can extend later with lint commands, PR checks and notes;
5. publishes your own Keelcrew board, a private artifact only you can open, and saves your answers in its settings;
6. records the board, your Mate folder and its repos, and installs the `keelctl` command and the `keelcrew-helper` link in `~/.keelcrew/bin`;
7. runs `keelctl doctor --fix` and checks the helper answers;
8. switches the session to Auto mode (approve the card it shows) and starts it as your Mate: it registers, loads what it has learned, sets up its watches and starts working.

**Where tasks come from.** Anything you add on the board (New task) or tell the Mate. With Jira as well, the panel checks your Jira query every 30 minutes in working hours and brings new and changed tickets to the Mate. That needs the Atlassian connector in the Claude app (Settings → Connectors). You can add Jira later: `keelctl setup --cloud-id <id>`, the site and query in your pack, and “The board and Jira” under board Settings → Tasks → Where tasks come from.

## 4. Crew session settings

Every crew session starts in your Mate folder, so Keelcrew keeps two Claude Code settings in `<Mate folder>/.claude/settings.local.json` and leaves the rest of that file alone:

- `permissions.defaultMode: "auto"`, so crew sessions never stall on a permission prompt;
- `autoCompactWindow`, the size at which crew sessions summarise their history (600k tokens by default), so the Mate stays fast and cheap however long it runs.

The defaults live in `plugins/keelcrew/rules/rules.json` (`sessions`). Change the compact size in board Settings → This Mac (Summarise sessions at). Setup applies both (`keelctl doctor --fix`), and `keelctl doctor` reports when they drift. Crew sessions can't change Claude Code settings files: they are yours. Any session you open yourself in the Mate folder gets them too.

Settings → Crew (New engineers and agents) picks how new engineers and agents start. By default the Mate posts a Start card on the board: click **Open the Mate session** on it; within about a minute a **Start <KEY>** button (an engineer) or a New task card (an agent) comes up at the bottom of the Mate's chat, and clicking it starts the session; the session starts with its model, effort and auto mode. “They start on their own” starts agents with no click instead; an engineer always waits for your click. (The app starts a session only from your own action in a session, so neither the board nor the helper can start one by itself.)

## 5. Working with the crew

Setup leaves the session running as your Mate. If you open a new session in the Mate folder later, say **"start the crew"** there to make it the Mate. From then on:

- Act on the board (cards, chat, settings). The panel mod in the Mate's session wakes it within a minute.
- Approve launch cards on the board or with `/keel-panel` in any session.
- Keep the Claude app open: watches and agents run only while it is.

## Checking and fixing

```bash
~/.keelcrew/bin/keelctl doctor
```

```bash
~/.keelcrew/bin/keelctl doctor --fix
```

`doctor` checks the config and crew files, the rules and pack, stale sessions and locks, logs, the memory store and the helper. `--fix` repairs what is safe to repair and never deletes a damaged file.

## Updating

In Terminal:

```bash
claude plugin marketplace update keelcrew && claude plugin update keelcrew@keelcrew
```

Open a new Code session and let it start: it points `~/.keelcrew/bin` at the new plugin. Then quit and reopen the Claude app, so the app starts the new helper (it starts the helper as it opens, before any session could re-point it). In the Mate's session, run `/reload-plugins` if it was open: on its next wake the Mate republishes the board to the same link, which keeps its data.

## Removing

1. Tell the Mate to turn off every scheduled job (or switch them off in board Settings → Crew), so no scheduled task keeps running. Any that are left show in the Claude app's scheduled tasks, where you can delete them.
2. For each engineer or agent worktree still registered, run `~/.keelcrew/bin/keelctl unregister <worktree>`: it points the worktree's git hooks back at the repo's own (Keelcrew's push check sits in `~/.keelcrew/githooks`).
3. In the Claude app, uninstall **keelcrew-local** (Settings → Extensions). If you added it to the app's config instead, quit the app and remove the `keelcrew-local` entry from its config.
4. In Terminal: `claude plugin uninstall keelcrew@keelcrew` and `claude plugin marketplace remove keelcrew`.
5. Setup put `permissions.defaultMode: "auto"` and `autoCompactWindow` in `<Mate folder>/.claude/settings.local.json`; remove them if you don't want them for other sessions there.
6. `~/.keelcrew` holds your crew's state and the Mate's memory. Keep it if you might come back; delete it to start fresh. The board is an artifact in your claude.ai account: delete it there if you want it gone.

## Working on Keelcrew itself

See [CONTRIBUTING.md](../CONTRIBUTING.md).
