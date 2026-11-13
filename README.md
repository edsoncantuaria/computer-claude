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
| `computer_list` | Apps (with the access each has), windows, screens, backend status, or where the pointer is |
| `computer_access` | Ask you to let Claude use apps, list what is granted, or revoke it all |
| `computer_observe` | Screenshot, snapshot ID, and the element list of an app, window, or screen |
| `computer_inspect` | More of a snapshot's element tree, paged |
| `computer_wait` | Wait until text appears in, or disappears from, an app, window, or the screen; or, for apps with no elements (games, canvases, Wine), until the picture changes or stops changing |
| `computer_frames` | Several small captures in a row, to see motion |
| `computer_zoom` | A region of an observed screenshot at full resolution, for small text |
| `computer_click` | Click an element, a text match, or screenshot coordinates, optionally with Shift, Ctrl, Alt or Super held |
| `computer_hover` | Put the pointer over a target without clicking, for tooltips and hover menus |
| `computer_type` | Type text into a field |
| `computer_press`, `computer_hotkey` | Key presses and shortcuts |
| `computer_scroll`, `computer_drag` | Scroll and drag |
| `computer_move`, `computer_hold` | Relative pointer motion and held keys or buttons, for games |
| `computer_clipboard` | Read and write the clipboard |
| `computer_app` | Launch, switch to, quit, hide apps |
| `computer_window`, `computer_window_place` | Focus, move, resize, close windows; send them to another screen or workspace |
| `computer_batch` | Run several of the tools above in one round trip, stopping at the first failure |

Tools that change the desktop (`computer_click`, `computer_hover`, `computer_type`, `computer_press`, `computer_hotkey`, `computer_scroll`, `computer_drag`, `computer_app`, `computer_window`) accept `observe_after: true`, which returns the new state in the same call.

The plugin also ships a skill, `using-the-desktop`, that teaches Claude how to use these tools: observe a window, act on elements instead of coordinates, confirm the effect, and what to ask you first.

## App access

Claude cannot look at or touch an app until you grant it. When a task needs an app, Claude calls `computer_access` and GNOME Shell shows a dialog that names each app and what Claude would get:

| Tier | Default for | Claude can |
| --- | --- | --- |
| read | Web browsers | See the app in screenshots and read its elements |
| click | Terminals and IDEs | Also left-click and scroll |
| full | Everything else | Also type, press keys, right-click, drag, and manage its windows |

**Allow** grants each app at its default tier, **Allow full control** grants all of them the full tier, and **Deny** (also Enter, Escape, or two minutes without an answer) grants nothing. A grant lasts until you log out; `computer_access` with `action: "revoke"` drops them all sooner. GNOME Shell itself (top bar, Activities, the run prompt) is granted the same way, under the name `shell`.

Until an app is granted, its windows are painted black in screen captures (in the Activities overview too), its elements are left out, and clicks or keys that would land on it fail with `APP_NOT_GRANTED`. An action beyond an app's tier fails with `ACCESS_TIER`. The dialog belongs to the shell, and while it is open the extension refuses all input, so the answer is always yours. Window titles and app names stay visible in `computer_list`.

This needs extension API 8, so log out and back in once after updating. An older extension keeps working with no access control, and `computer_list` with `kind: "permissions"` then reports `app_access: off`.

## The agent cursor

While Claude acts, its own cursor appears on screen: a hollow white arrowhead with a small orange pill beside it that says what Claude is doing right now, such as "Checking Calculadora", "Clicking “Save”", "Typing", "Pressing Enter" or "Opening Calculator". The pill stays while the action runs, then fades. The arrow glides to where the action lands and leaves a fading trail, and clicks end in a ripple. It is drawn by the GNOME Shell extension above all windows, so you can follow what Claude does even when an action never touches your real pointer (element clicks, typing, key presses). Typed text is never shown, only the word "Typing". The cursor is hidden while screenshots are taken, so Claude never sees it.

An extension older than v0.5.0 keeps working but shows the label only briefly; log out and back in once after updating to get the persistent label.

## Emergency stop

Press **Super+Ctrl+Esc** and Claude stops at once, whichever window has the focus. Every action fails with `HALTED` and a "Claude paused" pill shows at the top of the screen; looking (screenshots, element trees) still works. Press the same keys again to resume. Held keys and buttons are released when you pause.

The switch lives in the GNOME Shell extension, not in the plugin, so it works even if Claude Code hangs. Claude can pause itself with those keys but never resume itself: while paused the extension refuses every key it is sent. Needs extension API 6 or newer (v0.4.0), so log out and back in once after updating. If another program already uses the shortcut, the extension still works without it and `Ping` reports `halt_shortcut: false`.

## How it works

| Part | Role |
| --- | --- |
| [`desktop/gnome-extension/`](desktop/gnome-extension/extension.js) | GNOME Shell extension. Exposes `io.github.edsoncantuaria.ComputerClaude` on the session bus: window list and geometry, screenshots (windows are captured even when covered, though a covered app may not have redrawn), pointer and keyboard injection, clipboard, app launch. |
| [`desktop/computer-claude-desktop`](desktop/computer-claude-desktop) | Python command line that composes those primitives with AT-SPI element trees and optional OCR. |
| [`src/`](src/server.ts) → `dist/server.mjs` | stdio MCP server that publishes the `computer_*` tools. The bundle is committed, so the plugin needs no `npm install`. |

The extension exists because GNOME Shell denies window introspection and screenshots to ordinary session processes, and Wayland gives clients no global coordinates or input injection.

## Behavior worth knowing

- **Input stays out of your way.** Unless `foreground=true`, a plain click on an element runs its accessibility action without moving the pointer or changing focus, and typing writes into the window's field directly. Key presses, drags, and scrolling in covered windows borrow focus and hand it back.
- **The Activities overview is closed first.** It covers every window and takes pointer input away from them, so an action that needs input closes it before acting.
- **A covered window's picture can lag.** Apps stop drawing while nothing shows them, so the screenshot of a covered, minimized or overview-hidden window may be out of date. The observation says so; the element list stays current, so trust it over the picture.
- **Input is checked where it lands.** The extension looks at the window under the pointer before a button press or scroll, and at the focused window before a key, so a shortcut that switches to an app you did not grant leaves Claude unable to type there.
- **System dialogs stop input.** While a GNOME dialog (keyring, polkit) or the lock screen holds the keyboard, input tools fail with `SYSTEM_DIALOG_ACTIVE` or `SCREEN_LOCKED` instead of reporting success.
- **Typing is checked.** When the field can be read, text that did not arrive fails with `INPUT_NOT_DELIVERED`.
- **Typing follows your keyboard layout.** Characters with no key go through the input method or the clipboard.
- **`cmd` means Ctrl.** Use `super` for the Super key.
- **Screenshots are at most 1568 px on the long edge.** Larger captures are downscaled, and coordinates Claude reads from them are mapped back to the desktop, so clicks land where they were aimed on any display size. `save_path` keeps the full-resolution PNG.
- **Shortcuts that end the session are refused.** Ctrl+Alt with a function key, Delete, or Backspace fails with `BLOCKED_SHORTCUT`.
- **Element trees depend on the app.** Screenshots, coordinates, typing, and window actions work on every window. GTK, Qt, and X11 toolkits expose elements by default; Chromium, Electron, Firefox, QtWebEngine, and Java apps need the switch that setup enables.

## Error log

Every failed tool call (a wait that timed out included), any problem the helper worked around without failing the call (text recognition that broke, an observation lost after an action that ran), and any crash of the MCP server adds one JSON line to `~/.local/state/computer-claude/errors.jsonl` (`$XDG_STATE_HOME` if set): time, plugin version, failing command, error code, message, and details such as a traceback for a bug in the helper. It stays on your machine and nothing is sent anywhere. Typed text, screenshots and tool arguments are never recorded, but a message can name a window or app. The file is private to you (mode 600) and rolls over at about 1 MB. Next to it, `timings.jsonl` gets one line per tool call and per helper command with how long it took and whether it worked (`kind`, `name`, `ms`, `ok`), and nothing else, so a slow step can be found later. Set `COMPUTER_CLAUDE_NO_ERROR_LOG=1` to turn both files off.

```bash
tail -n 20 ~/.local/state/computer-claude/errors.jsonl
```

Arguments the MCP SDK rejects before a tool runs are not logged. Failures inside the GNOME Shell extension show up in `journalctl --user -b /usr/bin/gnome-shell`.

## Trust boundary

Any process on your session bus can call the extension's service. It is held to the apps you granted like Claude is: the extension itself checks every screenshot, button press, scroll and key. That limits Claude; it is not a wall against other programs running as you, which have their own ways to read and drive your session (the accessibility bus, for one), and for the same reason the service does not try to tell its callers apart. For callers that must stay inside one window (a remote view of a single window, say), the service also offers `WindowPointer`, `WindowScroll` and `WindowKey`: pointer points are relative to the window and refused unless that exact spot belongs to the window, and keys require the window to have the focus. Those three carry a person's own input to a window they chose, so app grants do not apply to them. That is the same trust domain as the desktop session itself; sandboxed (Flatpak) apps cannot reach it unless granted session-bus access. Screenshots are only written inside your runtime directory.

Claude acts on your real desktop with your permissions, inside the apps you granted. Claude Code asks before each tool call unless you allow the tools; keep it that way for anything you would not hand to someone sitting at your keyboard. Allowing `computer_batch` allows every tool it can run. To skip the prompt only for tools that look and never act, add this to `permissions.allow` in your Claude Code settings:

```json
[
  "mcp__plugin_computer-claude_computer__computer_list",
  "mcp__plugin_computer-claude_computer__computer_observe",
  "mcp__plugin_computer-claude_computer__computer_inspect",
  "mcp__plugin_computer-claude_computer__computer_frames",
  "mcp__plugin_computer-claude_computer__computer_wait",
  "mcp__plugin_computer-claude_computer__computer_zoom"
]
```

## Development

```bash
npm install
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` covers the MCP tool layer against a fake helper and the helper's own logic; neither needs a desktop.

The server keeps one helper process (`computer-claude-desktop serve`) for as long as it runs and sends it one command per line, which saves about 150 ms of Python startup on every command. A command that is cancelled or times out ends that process, and the next command starts a new one. Run alone, the helper still takes one command from its arguments.

Try a checkout without installing it: `claude --plugin-dir .`

## Credits

The desktop backend comes from [Shellby MCP](https://github.com/Serbyte-Development/shellby-mcp) (MIT), where it serves ChatGPT Web. Computer Claude packages it as a standalone Claude Code plugin with its own extension and bus name, so the two can be installed side by side.

Several ideas were learned from other projects in this space, without taking their code: observing after an action and capped screenshots from [computer-use-linux](https://github.com/agent-sh/computer-use-linux), waiting and refused session-ending shortcuts from [Deskwright](https://github.com/tristanmuzzu/deskwright), and wait tools from [gnome-ui-mcp](https://github.com/asattelmaier/gnome-ui-mcp).

## License

[MIT](LICENSE)
