# Computer Claude

Computer Use for [Claude Code](https://claude.com/claude-code) on **GNOME Wayland**. Claude sees your real desktop and drives it: screenshots, accessible element trees, clicks, typing, key presses, scrolling, drags, windows, apps, and the clipboard.

It is a Claude Code plugin with one local MCP server. Nothing leaves your machine except the screenshots and text that Claude Code itself sends to the model.

> [!NOTE]
> Community project, not affiliated with or endorsed by Anthropic.

## Requirements

- GNOME Shell 50 on Wayland (other versions: see [Setup](#setup))
- Node.js 22 or later
- `sudo apt install python3-gi python3-gi-cairo gir1.2-atspi-2.0 gir1.2-gtk-3.0`
- Optional: `tesseract-ocr`, which makes on-screen text clickable in apps without an element tree (games, Blender, Godot)

## Install

In Claude Code:

```
/plugin marketplace add edsoncantuaria/computer-claude
/plugin install computer-claude@computer-claude
```

## Setup

Run this once in Claude Code, then **log out and back in** (a Wayland GNOME Shell only loads a new extension at login):

```
/computer-claude:setup
```

It installs a small GNOME Shell extension for your user and turns on accessibility for the Chromium, Electron, Firefox, QtWebEngine, and Java apps among your launchers, so their elements can be read; reopen those apps afterwards. Check the result with `/computer-claude:setup status`; `/computer-claude:setup uninstall` reverts everything.

Without Claude Code, the same installer is `node desktop/install-extension.mjs [--install | --status | --uninstall]`. On an untested GNOME Shell version it stops; `--allow-untested-shell` installs anyway.

## Use

Ask Claude for what you want done on the desktop, for example:

- "Open the calculator and compute 12 × 3."
- "Look at my screen and tell me which window is showing an error."
- "In the text editor that is open, replace the title with 'Notes'."

## Tools

| Tool | What it does |
| --- | --- |
| `computer_list` | Apps, windows, screens, or backend status |
| `computer_observe` | Screenshot, snapshot ID, and the element list of an app, window, or screen |
| `computer_inspect` | More of a snapshot's element tree, paged |
| `computer_wait` | Wait until text appears in, or disappears from, an app, window, or the screen |
| `computer_zoom` | A region of an observed screenshot at full resolution, for small text |
| `computer_click` | Click an element, a text match, or screenshot coordinates |
| `computer_type` | Type text into a field |
| `computer_press`, `computer_hotkey` | Key presses and shortcuts |
| `computer_scroll`, `computer_drag` | Scroll and drag |
| `computer_move`, `computer_hold` | Relative pointer motion and held keys or buttons, for games |
| `computer_clipboard` | Read and write the clipboard |
| `computer_app` | Launch, switch to, quit, hide apps |
| `computer_window`, `computer_window_place` | Focus, move, resize, close windows; send them to another screen or workspace |

Tools that change the desktop (`computer_click`, `computer_type`, `computer_press`, `computer_hotkey`, `computer_scroll`, `computer_drag`, `computer_app`, `computer_window`) accept `observe_after: true`, which returns the new state in the same call.

The plugin also ships a skill, `using-the-desktop`, that teaches Claude how to use these tools: observe a window, act on elements instead of coordinates, confirm the effect, and what to ask you first.

## The agent cursor

While Claude acts, an orange cursor labelled "Claude" glides to where the action lands and leaves a fading trail; clicks end in a ripple. It is Claude's own cursor, drawn by the GNOME Shell extension above all windows, so you can follow what it does even when an action never touches your real pointer (element clicks, typing, key presses). Typing shows "typing", never the text; key presses show the keys. The cursor fades after about two seconds and is hidden while screenshots are taken, so Claude never sees it.

An extension older than v0.3.0 keeps working but draws only a dot for real pointer moves; log out and back in once after updating to get the full cursor.

## How it works

| Part | Role |
| --- | --- |
| [`desktop/gnome-extension/`](desktop/gnome-extension/extension.js) | GNOME Shell extension. Exposes `io.github.edsoncantuaria.ComputerClaude` on the session bus: window list and geometry, screenshots (windows are captured even when covered), pointer and keyboard injection, clipboard, app launch. |
| [`desktop/computer-claude-desktop`](desktop/computer-claude-desktop) | Python command line that composes those primitives with AT-SPI element trees and optional OCR. |
| [`src/`](src/server.ts) → `dist/server.mjs` | stdio MCP server that publishes the `computer_*` tools. The bundle is committed, so the plugin needs no `npm install`. |

The extension exists because GNOME Shell denies window introspection and screenshots to ordinary session processes, and Wayland gives clients no global coordinates or input injection.

## Behavior worth knowing

- **Input stays out of your way.** Unless `foreground=true`, a plain click on an element runs its accessibility action without moving the pointer or changing focus, and typing writes into the window's field directly. Key presses, drags, and scrolling in covered windows borrow focus and hand it back.
- **System dialogs stop input.** While a GNOME dialog (keyring, polkit) or the lock screen holds the keyboard, input tools fail with `SYSTEM_DIALOG_ACTIVE` or `SCREEN_LOCKED` instead of reporting success.
- **Typing is checked.** When the field can be read, text that did not arrive fails with `INPUT_NOT_DELIVERED`.
- **Typing follows your keyboard layout.** Characters with no key go through the input method or the clipboard.
- **`cmd` means Ctrl.** Use `super` for the Super key.
- **Screenshots are at most 1568 px on the long edge.** Larger captures are downscaled, and coordinates Claude reads from them are mapped back to the desktop, so clicks land where they were aimed on any display size. `save_path` keeps the full-resolution PNG.
- **Shortcuts that end the session are refused.** Ctrl+Alt with a function key, Delete, or Backspace fails with `BLOCKED_SHORTCUT`.
- **Element trees depend on the app.** Screenshots, coordinates, typing, and window actions work on every window. GTK, Qt, and X11 toolkits expose elements by default; Chromium, Electron, Firefox, QtWebEngine, and Java apps need the switch that setup enables.

## Trust boundary

Any process on your session bus can call the extension's service, which means it can read the screen and inject input. That is the same trust domain as the desktop session itself; sandboxed (Flatpak) apps cannot reach it unless granted session-bus access. Screenshots are only written inside your runtime directory.

Claude acts on your real desktop with your permissions. Claude Code asks before each tool call unless you allow the tools; keep it that way for anything you would not hand to someone sitting at your keyboard. To skip the prompt only for tools that look and never act, add this to `permissions.allow` in your Claude Code settings:

```json
[
  "mcp__plugin_computer-claude_computer__computer_list",
  "mcp__plugin_computer-claude_computer__computer_observe",
  "mcp__plugin_computer-claude_computer__computer_inspect",
  "mcp__plugin_computer-claude_computer__computer_wait",
  "mcp__plugin_computer-claude_computer__computer_zoom"
]
```

## Development

```bash
npm install
npm run typecheck
npm run lint
npm run build
```

Try a checkout without installing it: `claude --plugin-dir .`

## Credits

The desktop backend comes from [Shellby MCP](https://github.com/Serbyte-Development/shellby-mcp) (MIT), where it serves ChatGPT Web. Computer Claude packages it as a standalone Claude Code plugin with its own extension and bus name, so the two can be installed side by side.

Several ideas were learned from other projects in this space, without taking their code: observing after an action and capped screenshots from [computer-use-linux](https://github.com/agent-sh/computer-use-linux), waiting and refused session-ending shortcuts from [Deskwright](https://github.com/tristanmuzzu/deskwright), and wait tools from [gnome-ui-mcp](https://github.com/asattelmaier/gnome-ui-mcp).

## License

[MIT](LICENSE)
