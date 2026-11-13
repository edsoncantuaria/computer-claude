// Computer Claude: the compositor-side half of the Computer Claude plugin on GNOME.
//
// GNOME Shell refuses window introspection and screenshots to ordinary session
// processes, and Wayland offers no global coordinates or input injection outside
// the compositor. This extension exposes exactly those primitives on the session
// bus; desktop/computer-claude-desktop composes them into Computer Use actions.
//
// Any process on the user's session bus can call this service. That is the same
// trust domain as the user's own desktop session. Apps are still off limits until
// the user grants them in a dialog only the shell can draw (see RequestAccess).
import Clutter from "gi://Clutter"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Meta from "gi://Meta"
import Mtk from "gi://Mtk"
import Shell from "gi://Shell"
import St from "gi://St"

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js"
import * as Config from "resource:///org/gnome/shell/misc/config.js"
import { getKeyboardManager } from "resource:///org/gnome/shell/misc/keyboardManager.js"
import * as Main from "resource:///org/gnome/shell/ui/main.js"
import {
  accessKey,
  accessMode,
  askAccess,
  describeApp,
  grants,
  SHELL_KEY,
  TIER_TEXT,
  TIERS,
  tierOf,
} from "./access.js"
import { AgentCursor, HaltBadge } from "./overlay.js"

const BUS_NAME = "io.github.edsoncantuaria.ComputerClaude"
const OBJECT_PATH = "/io/github/edsoncantuaria/ComputerClaude"
const ERROR_NAME = "io.github.edsoncantuaria.ComputerClaude.Error"
const API_VERSION = 8

const INTERFACE = `
<node>
  <interface name="io.github.edsoncantuaria.ComputerClaude">
    <method name="Ping"><arg type="s" direction="out"/></method>
    <method name="Halted"><arg type="b" direction="out"/></method>
    <method name="HideOverview"/>
    <method name="WindowPointer">
      <arg type="t" name="id" direction="in"/>
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
      <arg type="u" name="button" direction="in"/>
      <arg type="b" name="pressed" direction="in"/>
    </method>
    <method name="WindowScroll">
      <arg type="t" name="id" direction="in"/>
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
      <arg type="s" name="direction" direction="in"/>
      <arg type="u" name="steps" direction="in"/>
    </method>
    <method name="WindowKey">
      <arg type="t" name="id" direction="in"/>
      <arg type="u" name="keyval" direction="in"/>
      <arg type="b" name="pressed" direction="in"/>
    </method>
    <method name="ListWindows"><arg type="s" direction="out"/></method>
    <method name="ListMonitors"><arg type="s" direction="out"/></method>
    <method name="WindowAction">
      <arg type="t" name="id" direction="in"/>
      <arg type="s" name="action" direction="in"/>
      <arg type="ai" name="geometry" direction="in"/>
    </method>
    <method name="Screenshot">
      <arg type="s" name="kind" direction="in"/>
      <arg type="t" name="id" direction="in"/>
      <arg type="s" name="path" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="PointerMove">
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
    </method>
    <method name="AgentCursor">
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
      <arg type="s" name="action" direction="in"/>
      <arg type="s" name="label" direction="in"/>
    </method>
    <method name="Hold">
      <arg type="s" name="kind" direction="in"/>
      <arg type="u" name="code" direction="in"/>
      <arg type="b" name="pressed" direction="in"/>
    </method>
    <method name="ReleaseHeld"/>
    <method name="GetClipboard"><arg type="s" direction="out"/></method>
    <method name="ShellState"><arg type="s" direction="out"/></method>
    <method name="PointerRelative">
      <arg type="d" name="dx" direction="in"/>
      <arg type="d" name="dy" direction="in"/>
    </method>
    <method name="PointerPosition"><arg type="ad" direction="out"/></method>
    <method name="PointerWarp">
      <arg type="d" name="x" direction="in"/>
      <arg type="d" name="y" direction="in"/>
    </method>
    <method name="PointerButton">
      <arg type="u" name="button" direction="in"/>
      <arg type="b" name="pressed" direction="in"/>
    </method>
    <method name="Scroll">
      <arg type="s" name="direction" direction="in"/>
      <arg type="u" name="steps" direction="in"/>
    </method>
    <method name="Key">
      <arg type="u" name="keyval" direction="in"/>
      <arg type="b" name="pressed" direction="in"/>
    </method>
    <method name="KeyboardGroup"><arg type="u" direction="out"/></method>
    <method name="CommitText">
      <arg type="s" name="text" direction="in"/>
      <arg type="b" direction="out"/>
    </method>
    <method name="ScrollContinuous">
      <arg type="d" name="dx" direction="in"/>
      <arg type="d" name="dy" direction="in"/>
      <arg type="b" name="finish" direction="in"/>
    </method>
    <method name="SetClipboard"><arg type="s" name="text" direction="in"/></method>
    <method name="LaunchApp">
      <arg type="s" name="desktop_id" direction="in"/>
      <arg type="as" name="uris" direction="in"/>
    </method>
    <method name="Access"><arg type="s" direction="out"/></method>
    <method name="RequestAccess">
      <arg type="as" name="keys" direction="in"/>
      <arg type="s" name="reason" direction="in"/>
      <arg type="s" direction="out"/>
    </method>
    <method name="RevokeAccess"/>
  </interface>
</node>`

const LISTED_WINDOW_TYPES = new Set([
  Meta.WindowType.NORMAL,
  Meta.WindowType.DIALOG,
  Meta.WindowType.MODAL_DIALOG,
  Meta.WindowType.UTILITY,
])

const SCROLL_DIRECTIONS = {
  up: Clutter.ScrollDirection.UP,
  down: Clutter.ScrollDirection.DOWN,
  left: Clutter.ScrollDirection.LEFT,
  right: Clutter.ScrollDirection.RIGHT,
}

// Wayland popups (menus, popovers) are windows of their own; they never get listed.
const POPUP_WINDOW_TYPES = new Set([
  Meta.WindowType.MENU,
  Meta.WindowType.DROPDOWN_MENU,
  Meta.WindowType.POPUP_MENU,
  Meta.WindowType.COMBO,
])

// Surfaces that belong to the desktop itself (its icons, a dock), not to an app one could grant.
const UNOWNED_WINDOW_TYPES = new Set([Meta.WindowType.DESKTOP, Meta.WindowType.DOCK])

// Held input is released on its own if the caller goes away.
const HOLD_LIMIT_MS = 30_000
const MAX_WORKSPACE_INDEX = 35

// The user's emergency stop. While it is on, nothing can act on the desktop; reading still works.
const HALT_ACCELERATOR = "<Control><Super>Escape"
const HALT_MESSAGE =
  "HALTED: The user paused Claude with Super+Ctrl+Esc. Do not retry; wait until the user resumes."

function rectangle(rect) {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function listedWindows() {
  return global
    .get_window_actors()
    .map((actor) => actor.meta_window)
    .filter((window) => window && LISTED_WINDOW_TYPES.has(window.get_window_type()))
}

function findWindow(id) {
  const window = listedWindows().find((candidate) => candidate.get_id() === id)
  if (!window) throw new Error(`WINDOW_NOT_FOUND: No window has ID ${id}.`)
  return window
}

function popupsOf(window) {
  return global
    .get_window_actors()
    .map((actor) => actor.meta_window)
    .filter(
      (candidate) =>
        candidate &&
        POPUP_WINDOW_TYPES.has(candidate.get_window_type()) &&
        candidate.find_root_ancestor() === window
    )
}

function unionRectangle(rectangles) {
  const left = Math.min(...rectangles.map((rect) => rect.x))
  const top = Math.min(...rectangles.map((rect) => rect.y))
  const right = Math.max(...rectangles.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rectangles.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function isMaximized(window) {
  // Mutter 49 replaced get_maximized() flags with is_maximized().
  return window.is_maximized ? window.is_maximized() : window.get_maximized() !== 0
}

function maximize(window) {
  if (Meta.MaximizeFlags) window.maximize(Meta.MaximizeFlags.BOTH)
  else window.maximize()
}

function unmaximize(window) {
  if (!isMaximized(window)) return
  if (Meta.MaximizeFlags) window.unmaximize(Meta.MaximizeFlags.BOTH)
  else window.unmaximize()
}

class DesktopService {
  constructor() {
    const seat = Clutter.get_default_backend().get_default_seat()
    this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE)
    this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE)
    this._tracker = Shell.WindowTracker.get_default()
    this._agent = new AgentCursor()
    this._badge = new HaltBadge()
    this._held = new Map()
    this._holdTimer = 0
    this._halted = false
    this._asking = false
    // A compositor-level shortcut works whichever window has the focus. Synthetic keys can
    // trigger it too, which is harmless: while paused the service refuses every key, so the
    // agent can pause itself but never resume itself.
    this._acceleratorId = global.display.grab_accelerator(
      HALT_ACCELERATOR,
      Meta.KeyBindingFlags.NONE
    )
    if (this._acceleratorId === 0)
      console.warn(`Computer Claude: ${HALT_ACCELERATOR} is already taken`)
    // The shell blocks a grabbed accelerator in every mode until it is allowed, lock screen included.
    else
      Main.wm.allowKeybinding(
        Meta.external_binding_name_for_action(this._acceleratorId),
        Shell.ActionMode.ALL
      )
    this._acceleratorSignal = global.display.connect(
      "accelerator-activated",
      (_display, action) => {
        if (action === this._acceleratorId) this._setHalted(!this._halted)
      }
    )
  }

  destroy() {
    global.display.disconnect(this._acceleratorSignal)
    if (this._acceleratorId !== 0) global.display.ungrab_accelerator(this._acceleratorId)
    this.ReleaseHeld()
    this._agent.destroy()
    this._agent = null
    this._badge.destroy()
    this._badge = null
    this._pointer = null
    this._keyboard = null
  }

  _setHalted(halted) {
    this._halted = halted
    if (halted) {
      this.ReleaseHeld()
      this._agent.hide()
    }
    this._badge.setVisible(halted)
  }

  _guard() {
    if (this._halted) throw new Error(HALT_MESSAGE)
    // The answer to an access request must be the user's own.
    if (this._asking)
      throw new Error(
        "ACCESS_PROMPT_OPEN: The user is being asked for access; wait for the answer."
      )
  }

  _require(key, need) {
    const tier = tierOf(key)
    if (tier && TIERS[tier] >= TIERS[need]) return
    const { name } = describeApp(key)
    if (!tier)
      throw new Error(
        `APP_NOT_GRANTED: ${name} has not been granted to Claude. Ask the user with computer_access.`
      )
    throw new Error(
      `ACCESS_TIER: ${name} is granted "${tier}" access (${TIER_TEXT[tier]}), and this needs "${need}".`
    )
  }

  // Keys go to the focused window, or to the shell while it shows a dialog, a menu or the overview.
  _keyboardTarget() {
    if (Main.modalCount > 0 || Main.overview.visible) return SHELL_KEY
    const window = global.display.focus_window?.find_root_ancestor()
    return window ? accessKey(window) : SHELL_KEY
  }

  // Buttons and scrolling go to whatever is under the pointer.
  _pointerTarget() {
    const [x, y] = global.get_pointer()
    for (
      let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, x, y);
      actor;
      actor = actor.get_parent()
    )
      if (actor instanceof Meta.WindowActor)
        return accessKey(actor.meta_window.find_root_ancestor())
    return SHELL_KEY
  }

  Ping() {
    return JSON.stringify({
      api: API_VERSION,
      shell: Config.PACKAGE_VERSION,
      halted: this._halted,
      halt_shortcut: this._acceleratorId !== 0,
      asking: this._asking,
      access_mode: accessMode(),
    })
  }

  Halted() {
    return this._halted
  }

  ListWindows() {
    const windows = listedWindows()
    const stacking = global.display.sort_windows_by_stacking(windows)
    const activeWorkspace = global.workspace_manager.get_active_workspace()
    return JSON.stringify(
      windows.map((window) => {
        const app = this._tracker.get_window_app(window)
        return {
          id: window.get_id(),
          title: window.get_title() ?? "",
          pid: window.get_pid(),
          wm_class: window.get_wm_class() ?? "",
          app: app?.get_name() ?? "",
          app_id: app?.get_id() ?? "",
          access_key: accessKey(window),
          access: tierOf(accessKey(window)),
          ...rectangle(window.get_frame_rect()),
          // An open menu holds the focus on behalf of its window.
          focused: global.display.focus_window?.find_root_ancestor() === window,
          minimized: window.minimized,
          maximized: isMaximized(window),
          shadow_x: window.get_frame_rect().x - window.get_buffer_rect().x,
          shadow_y: window.get_frame_rect().y - window.get_buffer_rect().y,
          monitor: window.get_monitor(),
          workspace: window.get_workspace()?.index() ?? -1,
          on_active_workspace: window.located_on_workspace(activeWorkspace),
          stacking: stacking.indexOf(window),
        }
      })
    )
  }

  ListMonitors() {
    const display = global.display
    const primary = display.get_primary_monitor()
    const monitors = []
    for (let index = 0; index < display.get_n_monitors(); index++) {
      monitors.push({
        index,
        ...rectangle(display.get_monitor_geometry(index)),
        scale: display.get_monitor_scale(index),
        primary: index === primary,
      })
    }
    return JSON.stringify(monitors)
  }

  WindowAction(id, action, geometry) {
    this._guard()
    const window = findWindow(id)
    // Focusing is free, as focus has to go back to the user's window after a borrowed action.
    if (action !== "focus") this._require(accessKey(window), action === "close" ? "full" : "read")
    const frame = window.get_frame_rect()
    switch (action) {
      case "focus":
        Main.activateWindow(window)
        break
      case "move_monitor":
        if (geometry[0] >= global.display.get_n_monitors())
          throw new Error(`SCREEN_NOT_FOUND: No screen has index ${geometry[0]}.`)
        window.move_to_monitor(geometry[0])
        break
      case "move_workspace": {
        if (geometry[0] > MAX_WORKSPACE_INDEX)
          throw new Error(`INVALID_WORKSPACE: Workspace ${geometry[0]} is out of range.`)
        const manager = global.workspace_manager
        while (manager.n_workspaces <= geometry[0])
          manager.append_new_workspace(false, global.get_current_time())
        window.change_workspace_by_index(geometry[0], false)
        break
      }
      case "close":
        window.delete(global.get_current_time())
        break
      case "minimize":
        window.minimize()
        break
      case "restore":
        if (window.minimized) window.unminimize()
        else unmaximize(window)
        break
      case "maximize":
        if (window.minimized) window.unminimize()
        maximize(window)
        break
      case "move":
        unmaximize(window)
        window.move_frame(true, geometry[0], geometry[1])
        break
      case "resize":
        unmaximize(window)
        window.move_resize_frame(true, frame.x, frame.y, geometry[0], geometry[1])
        break
      case "set_bounds":
        unmaximize(window)
        window.move_resize_frame(true, geometry[0], geometry[1], geometry[2], geometry[3])
        break
      default:
        throw new Error(`INVALID_ACTION: Unknown window action ${action}.`)
    }
  }

  // Promise-returning shell APIs need the invocation, so this method is async.
  ScreenshotAsync([kind, id, path], invocation) {
    this._screenshot(kind, id, path).then(
      (bounds) => invocation.return_value(new GLib.Variant("(s)", [JSON.stringify(bounds)])),
      (error) => invocation.return_dbus_error(ERROR_NAME, error.message)
    )
  }

  async _screenshot(requestedKind, id, path) {
    // "screen+cursor" keeps the agent's overlay in the picture, for demonstrations.
    const kind = requestedKind.replace("+cursor", "")
    if (kind === requestedKind) this._agent.hide()
    const file = Gio.File.new_for_path(path)
    // Callers share the session bus, so this write must not reach arbitrary files.
    if (!file.get_path().startsWith(`${GLib.get_user_runtime_dir()}/computer-claude/`))
      throw new Error("INVALID_PATH: Screenshots can only be written to the runtime directory.")
    const stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null)
    try {
      if (kind === "screen") {
        if (id >= global.display.get_n_monitors())
          throw new Error(`SCREEN_NOT_FOUND: No screen has index ${id}.`)
        const bounds = rectangle(global.display.get_monitor_geometry(id))
        await this._captureStage(bounds, global.display.get_monitor_scale(id), stream)
        return bounds
      }
      if (kind !== "window") throw new Error(`INVALID_TARGET: Unknown screenshot kind ${kind}.`)

      // Painting the actor captures the window even when it is covered by others.
      const window = findWindow(id)
      this._require(accessKey(window), "read")
      const popups = popupsOf(window)
      if (popups.length > 0) {
        // Popups are separate surfaces, so only a stage capture shows them with their window.
        const bounds = unionRectangle(
          [window, ...popups].map((item) => rectangle(item.get_frame_rect()))
        )
        await this._captureStage(
          bounds,
          global.display.get_monitor_scale(window.get_monitor()),
          stream
        )
        return bounds
      }
      const actor = window.get_compositor_private()
      if (!actor) throw new Error(`WINDOW_NOT_CAPTURABLE: Window ${id} has no compositor actor.`)
      const texture = actor.paint_to_content(null).get_texture()
      const scale = actor.get_resource_scale()
      const frame = window.get_frame_rect()
      const buffer = window.get_buffer_rect()
      await Shell.Screenshot.composite_to_stream(
        texture,
        Math.round((frame.x - buffer.x) * scale),
        Math.round((frame.y - buffer.y) * scale),
        Math.round(frame.width * scale),
        Math.round(frame.height * scale),
        scale,
        null,
        0,
        0,
        1,
        stream
      )
      return rectangle(frame)
    } finally {
      stream.close(null)
    }
  }

  // Paints part of the desktop without showing it, with every window of an app the user has not
  // granted drawn black wherever it appears: on the desktop, under a dialog, in the overview.
  async _captureStage(bounds, scale, stream) {
    const blackened = global
      .get_window_actors()
      .filter((actor) => {
        const window = actor.meta_window.find_root_ancestor()
        return !(UNOWNED_WINDOW_TYPES.has(window.get_window_type()) || tierOf(accessKey(window)))
      })
      .map((actor) => {
        const effect = new Clutter.BrightnessContrastEffect()
        effect.set_brightness(-1)
        actor.add_effect(effect)
        return [actor, effect]
      })
    let content
    try {
      // Off screen and in this same turn, so the user never sees a window go black.
      content = global.stage.paint_to_content(
        new Mtk.Rectangle(bounds),
        scale,
        null,
        Clutter.PaintFlag.NO_CURSORS
      )
    } finally {
      for (const [actor, effect] of blackened) actor.remove_effect(effect)
    }
    const texture = content.get_texture()
    await Shell.Screenshot.composite_to_stream(
      texture,
      0,
      0,
      texture.get_width(),
      texture.get_height(),
      scale,
      null,
      0,
      0,
      1,
      stream
    )
  }

  PointerMove(x, y) {
    this._guard()
    this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y)
    this._agent.moveTo(x, y)
  }

  // Shows where the agent is about to act, for actions that never touch the real pointer.
  // The call returns once the arrow has arrived, so the action happens where the user is looking.
  AgentCursorAsync([x, y, action, label], invocation) {
    if (this._halted) {
      invocation.return_dbus_error(ERROR_NAME, HALT_MESSAGE)
      return
    }
    if (action === "idle") {
      this._agent.idle()
      invocation.return_value(null)
    } else if (action === "busy") {
      // Announces a running action and returns at once; the arrow keeps its label until idle.
      this._agent.moveTo(x, y, { label, sticky: true })
      invocation.return_value(null)
    } else {
      this._agent.moveTo(x, y, {
        label,
        click: action === "click",
        done: () => invocation.return_value(null),
      })
    }
  }

  // A system dialog or the lock screen takes all input away from applications.
  Hold(kind, code, pressed) {
    this._guard()
    if (kind !== "key" && kind !== "button") throw new Error(`INVALID_HOLD: Unknown kind ${kind}.`)
    if (kind === "key") this.Key(code, pressed)
    else this.PointerButton(code, pressed)
    if (pressed) this._held.set(`${kind}:${code}`, { kind, code })
    else this._held.delete(`${kind}:${code}`)
    if (this._holdTimer) GLib.source_remove(this._holdTimer)
    this._holdTimer = 0
    if (this._held.size > 0) {
      this._holdTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOLD_LIMIT_MS, () => {
        this._holdTimer = 0
        this.ReleaseHeld()
        return GLib.SOURCE_REMOVE
      })
    }
  }

  ReleaseHeld() {
    if (this._holdTimer) GLib.source_remove(this._holdTimer)
    this._holdTimer = 0
    // Releasing must work while paused, so it skips the guard on purpose.
    for (const { kind, code } of this._held.values()) {
      if (kind === "key") this._key(code, false)
      else this._button(code, false)
    }
    this._held.clear()
  }

  GetClipboardAsync(_parameters, invocation) {
    St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_clipboard, text) => {
      invocation.return_value(new GLib.Variant("(s)", [text ?? ""]))
    })
  }

  ShellState() {
    const dialogs = Main.layoutManager.modalDialogGroup.get_children()
    return JSON.stringify({
      dialog: dialogs.some((actor) => actor.visible),
      locked: Main.sessionMode.isLocked,
      // The Activities overview covers every window and takes pointer input away from them.
      overview: Main.overview.visible,
    })
  }

  HideOverview() {
    this._guard()
    Main.overview.hide()
  }

  PointerRelative(dx, dy) {
    this._guard()
    this._pointer.notify_relative_motion(GLib.get_monotonic_time(), dx, dy)
  }

  PointerPosition() {
    const [x, y] = global.get_pointer()
    return [x, y]
  }

  // Puts the pointer back where the user left it, without the agent's marker.
  PointerWarp(x, y) {
    this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y)
  }

  PointerButton(button, pressed) {
    this._guard()
    // Releases always pass, so nothing stays held when access ends mid-action.
    if (pressed) this._require(this._pointerTarget(), button === 1 ? "click" : "full")
    this._button(button, pressed)
  }

  _button(button, pressed) {
    if (pressed) this._agent.ripple(...global.get_pointer())
    this._pointer.notify_button(
      GLib.get_monotonic_time(),
      button,
      pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED
    )
  }

  Scroll(direction, steps) {
    this._guard()
    this._require(this._pointerTarget(), "click")
    this._scroll(direction, steps)
  }

  _scroll(direction, steps) {
    if (!(direction in SCROLL_DIRECTIONS))
      throw new Error(`INVALID_DIRECTION: Unknown scroll direction ${direction}.`)
    for (let step = 0; step < steps; step++) {
      this._pointer.notify_discrete_scroll(
        GLib.get_monotonic_time(),
        SCROLL_DIRECTIONS[direction],
        Clutter.ScrollSource.WHEEL
      )
    }
  }

  ScrollContinuous(dx, dy, finish) {
    this._guard()
    this._require(this._pointerTarget(), "click")
    const flags = finish
      ? Clutter.ScrollFinishFlags.HORIZONTAL | Clutter.ScrollFinishFlags.VERTICAL
      : Clutter.ScrollFinishFlags.NONE
    this._pointer.notify_scroll_continuous(
      GLib.get_monotonic_time(),
      dx,
      dy,
      Clutter.ScrollSource.FINGER,
      flags
    )
  }

  Key(keyval, pressed) {
    this._guard()
    if (pressed) this._require(this._keyboardTarget(), "full")
    this._key(keyval, pressed)
  }

  _key(keyval, pressed) {
    this._keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      keyval,
      pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED
    )
  }

  // Input scoped to one window, for callers that must never act outside it (a remote view of a
  // single window, say). The point is relative to the window's frame, and it is refused unless
  // that exact spot belongs to the window, so an overlapping window cannot receive the input.
  // These carry a person's own input to a window they chose, so app grants do not apply.
  _pointInWindow(id, x, y) {
    const window = findWindow(id)
    if (window.minimized)
      throw new Error(`WINDOW_MINIMIZED: Window ${id} is minimized; restore it first.`)
    const frame = window.get_frame_rect()
    if (x < 0 || y < 0 || x >= frame.width || y >= frame.height)
      throw new Error(`OUT_OF_WINDOW: ${x},${y} is outside window ${id}.`)
    const belongs = () => {
      const owned = new Set(
        [window, ...popupsOf(window)].map((item) => item.get_compositor_private())
      )
      for (
        let actor = global.stage.get_actor_at_pos(
          Clutter.PickMode.REACTIVE,
          frame.x + x,
          frame.y + y
        );
        actor;
        actor = actor.get_parent()
      )
        if (owned.has(actor)) return true
      return false
    }
    if (!belongs()) {
      Main.activateWindow(window)
      if (!belongs())
        throw new Error(`WINDOW_OBSCURED: Something else covers that point of window ${id}.`)
    }
    return [frame.x + x, frame.y + y]
  }

  WindowPointer(id, x, y, button, pressed) {
    this._guard()
    const [absoluteX, absoluteY] = this._pointInWindow(id, x, y)
    this.PointerMove(absoluteX, absoluteY)
    if (button !== 0) this._button(button, pressed)
  }

  WindowScroll(id, x, y, direction, steps) {
    this._guard()
    const [absoluteX, absoluteY] = this._pointInWindow(id, x, y)
    this.PointerMove(absoluteX, absoluteY)
    this._scroll(direction, steps)
  }

  // Keys go to whichever window has the focus, so the window must have it already.
  WindowKey(id, keyval, pressed) {
    this._guard()
    const window = findWindow(id)
    if (global.display.focus_window?.find_root_ancestor() !== window) {
      Main.activateWindow(window)
      throw new Error(
        `WINDOW_NOT_FOCUSED: Window ${id} was brought to the front; send the key again.`
      )
    }
    this._key(keyval, pressed)
  }

  KeyboardGroup() {
    return getKeyboardManager().currentLayout?.groupIndex ?? 0
  }

  // Text delivered through the input method needs no key for any character.
  CommitText(text) {
    this._guard()
    this._require(this._keyboardTarget(), "full")
    if (!Main.inputMethod.currentFocus) return false
    Main.inputMethod.commit(text)
    return true
  }

  SetClipboard(text) {
    this._guard()
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text)
  }

  // Launching from the shell gives the app the same session context as the dash.
  LaunchApp(desktopId, uris) {
    this._guard()
    const app = Shell.AppSystem.get_default().lookup_app(desktopId)
    if (!app) throw new Error(`APP_NOT_FOUND: No installed application has ID ${desktopId}.`)
    // Handing an app a file or an address makes it act, which looking at it does not cover.
    this._require(desktopId, uris.length > 0 ? "full" : "read")
    if (uris.length > 0)
      app.get_app_info().launch_uris(uris, global.create_app_launch_context(0, -1))
    else if (app.get_n_windows() > 0) app.activate()
    else app.open_new_window(-1)
  }

  Access() {
    return JSON.stringify(
      Object.fromEntries(
        [...grants].map(([key, tier]) => [key, { name: describeApp(key).name, tier }])
      )
    )
  }

  // Asks the user, in a dialog of the shell's own, to let Claude use some apps.
  RequestAccessAsync([keys, reason], invocation) {
    this._requestAccess(keys, reason).then(
      (result) => invocation.return_value(new GLib.Variant("(s)", [JSON.stringify(result)])),
      (error) => invocation.return_dbus_error(ERROR_NAME, error.message)
    )
  }

  async _requestAccess(keys, reason) {
    this._guard()
    if (Main.sessionMode.isLocked)
      throw new Error("SCREEN_LOCKED: The screen is locked. Ask the user to unlock it.")
    const entries = [...new Set(keys)].map((key) => ({ key, ...describeApp(key) }))
    const wanted = entries.filter((entry) => !tierOf(entry.key))
    if (wanted.length > 0) {
      this._asking = true
      this._agent.hide()
      let answer
      try {
        answer = await askAccess(wanted, reason.slice(0, 300))
      } finally {
        this._asking = false
      }
      if (answer !== "deny")
        for (const entry of wanted) grants.set(entry.key, answer === "full" ? "full" : entry.tier)
    }
    return {
      granted: Object.fromEntries(
        entries.filter((entry) => tierOf(entry.key)).map((entry) => [entry.name, tierOf(entry.key)])
      ),
      denied: entries.filter((entry) => !tierOf(entry.key)).map((entry) => entry.name),
    }
  }

  // Taking access away needs no question.
  RevokeAccess() {
    grants.clear()
  }
}

export default class ComputerClaudeExtension extends Extension {
  enable() {
    this._service = new DesktopService()
    this._exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE, this._service)
    this._exported.export(Gio.DBus.session, OBJECT_PATH)
    this._ownerId = Gio.bus_own_name_on_connection(
      Gio.DBus.session,
      BUS_NAME,
      Gio.BusNameOwnerFlags.NONE,
      null,
      null
    )
  }

  disable() {
    if (this._ownerId) Gio.bus_unown_name(this._ownerId)
    this._ownerId = 0
    this._exported?.unexport()
    this._exported = null
    this._service?.destroy()
    this._service = null
  }
}
