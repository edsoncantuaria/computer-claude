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
| `computer_observe` | Screenshot plus a snapshot of the clickable elements of an app, window, or screen |
| `computer_inspect` | Element tree of a snapshot, paged |
| `computer_click` | Click an element, a text match, or screenshot coordinates |
| `computer_type` | Type text into a field |
| `computer_press`, `computer_hotkey` | Key presses and shortcuts |
| `computer_scroll`, `computer_drag` | Scroll and drag |
| `computer_move`, `computer_hold` | Relative pointer motion and held keys or buttons, for games |
| `computer_clipboard` | Read and write the clipboard |
| `computer_app` | Launch, switch to, quit, hide apps |
| `computer_window`, `computer_window_place` | Focus, move, resize, close windows; send them to another screen or workspace |

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
- **Screenshots are in logical pixels**, so screenshot coordinates equal desktop coordinates on HiDPI displays.
- **Element trees depend on the app.** Screenshots, coordinates, typing, and window actions work on every window. GTK, Qt, and X11 toolkits expose elements by default; Chromium, Electron, Firefox, QtWebEngine, and Java apps need the switch that setup enables.

## Trust boundary

Any process on your session bus can call the extension's service, which means it can read the screen and inject input. That is the same trust domain as the desktop session itself; sandboxed (Flatpak) apps cannot reach it unless granted session-bus access. Screenshots are only written inside your runtime directory.

Claude acts on your real desktop with your permissions. Claude Code asks before each tool call unless you allow the tools; keep it that way for anything you would not hand to someone sitting at your keyboard.

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

## License

[MIT](LICENSE)
