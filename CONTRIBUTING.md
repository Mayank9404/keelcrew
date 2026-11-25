# Contributing

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Found a way past the policy or push rules? Report it privately, as [SECURITY.md](SECURITY.md) says.

Read [docs/architecture.md](docs/architecture.md) before changing anything: it is the contract every part is built to. [docs/agents.md](docs/agents.md) explains how to add an agent.

## Run it from a checkout

Add the checkout as a local marketplace and install from it, so sessions run your working copy:

```bash
claude plugin marketplace add "$PWD"
```

```bash
claude plugin install keelcrew@keelcrew
```

Restart the Claude app to pick up changes to the plugin's hooks.

## Test

Install the board's dependencies once (Node 22 or newer):

```bash
cd board && npm ci
```

Then, from the repo root, with Claude Code 2.1.326 or newer as `claude` on your PATH (the mod tests run through it):

```bash
node scripts/test.mjs
```

```bash
node scripts/test.mjs --fast
```

The first runs everything (syntax, consistency, core, hooks, helper, mod, board); `--fast` skips the board tests and build, and so does a checkout without `board/node_modules`.

To try the board without a crew, build the demo board (made-up data) and serve `board/dev-dist`:

```bash
cd board && npm run dev:fixture
```

## Release

Bump the version in `plugins/keelcrew/.claude-plugin/plugin.json`, commit, and run `node scripts/pack.mjs`: it zips the last commit to `dist/keelcrew-<version>.zip`. The board's build lands in `plugins/keelcrew/board/`, which ships with the plugin.
