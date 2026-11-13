---
description: Install or check the Computer Claude GNOME Shell extension that Computer Use needs
argument-hint: "[status | uninstall]"
allowed-tools: Bash(node:*)
---

Set up Computer Claude's desktop backend for the user. The argument is: `$ARGUMENTS`

- No argument: run `node "${CLAUDE_PLUGIN_ROOT}/desktop/install-extension.mjs" --install`.
- `status`: run `node "${CLAUDE_PLUGIN_ROOT}/desktop/install-extension.mjs" --status`.
- `uninstall`: run `node "${CLAUDE_PLUGIN_ROOT}/desktop/install-extension.mjs" --uninstall`.

Then report the output in a few lines:

- After an install, tell the user to log out and back in: a Wayland GNOME Shell only loads a new extension at login. Mention the apps whose launchers got an accessibility switch, and that they need to be reopened.
- If Python bindings are missing, show the `apt install` line from the output; do not run `sudo` yourself.
- If the GNOME Shell version is not in the tested list, say so and let the user decide whether to rerun the installer with `--allow-untested-shell`.
- For `status`, `desktop_extension: ready` and `accessibility: ready` mean the `computer_*` tools work. `app_access: off (the user allows every app)` means the user put `all` in `~/.config/computer-claude/access-mode`, which is their choice to make and to undo; never write that file for them unless they ask in so many words. A plain `app_access: off` means the running extension predates per-app access: the user needs to log out and back in.
