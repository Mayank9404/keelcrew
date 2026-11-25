# Security

Keelcrew runs Claude Code sessions in Auto mode and relies on its policy hook and pre-push hook to refuse what the rules forbid. A way around those guards is a security bug, and reports are welcome.

## Reporting a problem

Report it privately through GitHub: on this repository, open **Security → Report a vulnerability**. Please don't open a public issue for it.

Include what you ran or asked for, what Keelcrew allowed that it should have refused (or the other way round), the Keelcrew and Claude Code versions (`claude --version`), and `~/.keelcrew/bin/keelctl doctor` output with anything private removed. The maintainer aims to reply within a week.

## In scope

- A crew session getting past the policy hook or the pre-push hook: a forbidden command, a merge, a force-push, a write to a protected path, or a post without the captain's OK.
- An approval or grant that covers more than the commit, card or post it was given for, or that a crew session could give itself.
- The local helper (`keelcrew-local`) reading or writing outside `~/.keelcrew` and the crew's worktrees, or being reachable by anything other than the Claude app.
- Text from tickets, pull requests, mail or web pages that makes a crew session act on it as an instruction.

Problems in Claude Code, the Claude app or claude.ai themselves go to Anthropic, not here.

## Supported versions

Fixes go into the latest release only. Update with the steps in [docs/install.md](docs/install.md#updating).
