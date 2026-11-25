# Install Keelcrew (steps for Claude)

For an AI assistant asked to install Keelcrew. Tell the person what you're doing, and ask before installing anything other than Keelcrew.

1. **Check.** `uname -s` must be `Darwin` (Keelcrew is Mac-only). The Claude desktop app must be at `/Applications/Claude.app`; if it isn't, ask them to install it from https://claude.ai/download. `claude --version` must be 2.1.292 or newer; if it isn't, ask, then run `curl -fsSL https://claude.ai/install.sh | bash`. Node must be 20 or newer, git present, and `gh auth status` signed in; if `gh` isn't, they run `gh auth login` themselves.
2. **Install.** `claude plugin install keelcrew --marketplace Mayank9404/keelcrew`. If `claude plugin list` already shows `keelcrew@keelcrew`, run `claude plugin update keelcrew@keelcrew` instead.
3. **Open setup.** `open "claude://code/new?q=Set%20up%20Keelcrew"`, then tell them: choose the folder that holds your repos, press Enter, and click **Install** when the app asks. If no session opens, they start one in that folder and send **Set up Keelcrew**.

Don't run setup in your own session, sign in or accept dialogs for them, or edit the Claude app's config or `~/.keelcrew`.
