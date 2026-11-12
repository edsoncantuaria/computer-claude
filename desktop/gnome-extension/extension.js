// Computer Claude: the compositor-side half of the Computer Claude plugin on GNOME.
//
// GNOME Shell refuses window introspection and screenshots to ordinary session
// processes, and Wayland offers no global coordinates or input injection outside
// the compositor. This extension exposes exactly those primitives on the session
// bus; desktop/computer-claude-desktop composes them into Computer Use actions.
//
// Any process on the user's session bus can call this service. That is the same
// trust domain as the user's own desktop session.
import Clutter from "gi://Clutter"
import Gio from "gi://Gio"
import GLib from "gi://GLib"
import Meta from "gi://Meta"
import Shell from "gi://Shell"
import St from "gi://St"

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js"
import * as Config from "resource:///org/gnome/shell/misc/config.js"
import { getKeyboardManager } from "resource:///org/gnome/shell/misc/keyboardManager.js"
import * as Main from "resource:///org/gnome/shell/ui/main.js"

const BUS_NAME = "io.github.edsoncantuaria.ComputerClaude"
const OBJECT_PATH = "/io/github/edsoncantuaria/ComputerClaude"
const ERROR_NAME = "io.github.edsoncantuaria.ComputerClaude.Error"
const API_VERSION = 5

const INTERFACE = `
<node>
  <interface name="io.github.edsoncantuaria.ComputerClaude">
    <method name="Ping"><arg type="s" direction="out"/></method>
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

// Held input is released on its own if the caller goes away.
const HOLD_LIMIT_MS = 30_000
const MAX_WORKSPACE_INDEX = 35

// The agent's own cursor: it shows where Claude is acting, whether or not it moves the real pointer.
const CURSOR_LINGER_MS = 1800
const CURSOR_FADE_MS = 350
const CURSOR_TRAVEL_MS = [140, 420]
const CURSOR_PX_PER_MS = 1.6
const TRAIL_SPACING_PX = 5
const TRAIL_FADE_MS = 800
const FRAME_MS = 16
// Claude's orange.
const ORANGE = "rgba(217, 119, 87, ALPHA)"
const color = (alpha) => ORANGE.replace("ALPHA", String(alpha))

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

class AgentCursor {
  constructor() {
    this._layer = new St.Widget({ reactive: false, visible: false, opacity: 0 })
    this._arrow = new St.DrawingArea({ width: 36, height: 36, reactive: false })
    this._arrow.connect("repaint", (area) => {
      const cr = area.get_context()
      cr.scale(1.45, 1.45)
      cr.moveTo(2, 2)
      cr.lineTo(2, 19)
      cr.lineTo(6.5, 15)
      cr.lineTo(9.5, 21.5)
      cr.lineTo(12.5, 20)
      cr.lineTo(9.5, 13.5)
      cr.lineTo(15.5, 13.5)
      cr.closePath()
      // A dark rim under the white one keeps the arrow visible on orange and white backgrounds alike.
      cr.setSourceRGBA(0, 0, 0, 0.55)
      cr.setLineWidth(3.6)
      cr.strokePreserve()
      cr.setSourceRGBA(0.851, 0.467, 0.341, 1)
      cr.fillPreserve()
      cr.setSourceRGBA(1, 1, 1, 1)
      cr.setLineWidth(1.8)
      cr.stroke()
      cr.$dispose()
    })
    this._label = new St.Label({
      text: "Claude",
      style: `background-color: ${color(0.95)}; color: white; border-radius: 10px; padding: 2px 9px; font-size: 11px; font-weight: bold;`,
    })
    this._layer.add_child(this._arrow)
    this._layer.add_child(this._label)
    Main.uiGroup.add_child(this._layer)
    this._x = null
    this._y = null
    this._tween = 0
    this._linger = 0
    this._pending = null
    this._trail = new Set()
  }

  destroy() {
    this.hide()
    this._layer.destroy()
    this._layer = null
  }

  // Moves the arrow along an eased path, leaving a fading trail. `done` runs on arrival.
  moveTo(x, y, { label = "", click = false, done = null } = {}) {
    this._stopTween()
    this._pending = done
    this._setLabel(label)
    this._reveal()
    const fromX = this._x ?? x
    const fromY = this._y ?? y
    const distance = Math.hypot(x - fromX, y - fromY)
    const duration = Math.min(
      CURSOR_TRAVEL_MS[1],
      Math.max(CURSOR_TRAVEL_MS[0], distance / CURSOR_PX_PER_MS)
    )
    const started = GLib.get_monotonic_time()
    let lastDot = [fromX, fromY]
    const step = () => {
      const t = Math.min((GLib.get_monotonic_time() - started) / 1000 / duration, 1)
      const eased = 1 - (1 - t) ** 3
      this._place(fromX + (x - fromX) * eased, fromY + (y - fromY) * eased)
      if (Math.hypot(this._x - lastDot[0], this._y - lastDot[1]) >= TRAIL_SPACING_PX) {
        this._dot(this._x, this._y)
        lastDot = [this._x, this._y]
      }
      if (t < 1) return GLib.SOURCE_CONTINUE
      this._tween = 0
      if (click) this._ripple(x, y)
      this._scheduleFade()
      this._settle()
      return GLib.SOURCE_REMOVE
    }
    this._tween = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, step)
  }

  ripple(x, y) {
    if (this._layer.visible) this._ripple(x, y)
  }

  // Gone at once, as screenshots must not show the agent's own overlay.
  hide() {
    this._stopTween()
    if (this._linger) GLib.source_remove(this._linger)
    this._linger = 0
    for (const dot of this._trail) dot.destroy()
    this._trail.clear()
    this._layer.remove_all_transitions()
    this._layer.opacity = 0
    this._layer.hide()
  }

  // A caller waiting for the arrow must never be left hanging by a newer move or a hide.
  _stopTween() {
    if (this._tween) GLib.source_remove(this._tween)
    this._tween = 0
    this._settle()
  }

  _settle() {
    const done = this._pending
    this._pending = null
    if (done) done()
  }

  _reveal() {
    if (this._linger) GLib.source_remove(this._linger)
    this._linger = 0
    Main.uiGroup.set_child_above_sibling(this._layer, null)
    this._layer.show()
    this._layer.remove_all_transitions()
    this._layer.ease({ opacity: 255, duration: 90, mode: Clutter.AnimationMode.EASE_OUT_QUAD })
  }

  _scheduleFade() {
    if (this._linger) GLib.source_remove(this._linger)
    this._linger = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CURSOR_LINGER_MS, () => {
      this._linger = 0
      this._layer.ease({
        opacity: 0,
        duration: CURSOR_FADE_MS,
        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        onComplete: () => {
          if (this._layer && this._layer.opacity === 0) this._layer.hide()
        },
      })
      return GLib.SOURCE_REMOVE
    })
  }

  _setLabel(label) {
    this._label.text = label ? `Claude · ${label}` : "Claude"
  }

  _place(x, y) {
    this._x = x
    this._y = y
    // The arrow's tip is at (2, 2) in its own space.
    this._arrow.set_position(Math.round(x - 3), Math.round(y - 3))
    this._label.set_position(Math.round(x + 18), Math.round(y + 26))
  }

  _dot(x, y) {
    const size = 11
    const dot = new St.Widget({
      reactive: false,
      width: size,
      height: size,
      style: `background-color: ${color(0.9)}; border-radius: ${size}px; box-shadow: 0 0 9px ${color(0.8)};`,
    })
    dot.set_pivot_point(0.5, 0.5)
    dot.set_position(Math.round(x - size / 2), Math.round(y - size / 2))
    this._layer.insert_child_below(dot, this._arrow)
    this._trail.add(dot)
    dot.ease({
      opacity: 0,
      scale_x: 0.2,
      scale_y: 0.2,
      duration: TRAIL_FADE_MS,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => {
        this._trail.delete(dot)
        dot.destroy()
      },
    })
  }

  _ripple(x, y) {
    const size = 16
    const ring = new St.Widget({
      reactive: false,
      width: size,
      height: size,
      style: `border: 3px solid ${color(0.95)}; border-radius: ${size}px; box-shadow: 0 0 8px ${color(0.7)};`,
    })
    ring.set_pivot_point(0.5, 0.5)
    ring.set_position(Math.round(x - size / 2), Math.round(y - size / 2))
    this._layer.insert_child_below(ring, this._arrow)
    this._trail.add(ring)
    ring.ease({
      opacity: 0,
      scale_x: 3.5,
      scale_y: 3.5,
      duration: 750,
      mode: Clutter.AnimationMode.EASE_OUT_QUAD,
      onComplete: () => {
        this._trail.delete(ring)
        ring.destroy()
      },
    })
  }
}

class DesktopService {
  constructor() {
    const seat = Clutter.get_default_backend().get_default_seat()
    this._pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE)
    this._keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE)
    this._tracker = Shell.WindowTracker.get_default()
    this._agent = new AgentCursor()
    this._held = new Map()
    this._holdTimer = 0
  }

  destroy() {
    this.ReleaseHeld()
    this._agent.destroy()
    this._agent = null
    this._pointer = null
    this._keyboard = null
  }

  Ping() {
    return JSON.stringify({ api: API_VERSION, shell: Config.PACKAGE_VERSION })
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
    const window = findWindow(id)
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
        await new Shell.Screenshot().screenshot_area(
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
          stream
        )
        return bounds
      }
      if (kind !== "window") throw new Error(`INVALID_TARGET: Unknown screenshot kind ${kind}.`)

      // Painting the actor captures the window even when it is covered by others.
      const window = findWindow(id)
      const popups = popupsOf(window)
      if (popups.length > 0) {
        // Popups are separate surfaces, so only a stage capture shows them with their window.
        const bounds = unionRectangle(
          [window, ...popups].map((item) => rectangle(item.get_frame_rect()))
        )
        await new Shell.Screenshot().screenshot_area(
          bounds.x,
          bounds.y,
          bounds.width,
          bounds.height,
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

  PointerMove(x, y) {
    this._pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y)
    this._agent.moveTo(x, y)
  }

  // Shows where the agent is about to act, for actions that never touch the real pointer.
  // The call returns once the arrow has arrived, so the action happens where the user is looking.
  AgentCursorAsync([x, y, action, label], invocation) {
    this._agent.moveTo(x, y, {
      label,
      click: action === "click",
      done: () => invocation.return_value(null),
    })
  }

  // A system dialog or the lock screen takes all input away from applications.
  Hold(kind, code, pressed) {
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
    for (const { kind, code } of this._held.values()) {
      if (kind === "key") this.Key(code, false)
      else this.PointerButton(code, false)
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
    })
  }

  PointerRelative(dx, dy) {
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
    if (pressed) this._agent.ripple(...global.get_pointer())
    this._pointer.notify_button(
      GLib.get_monotonic_time(),
      button,
      pressed ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED
    )
  }

  Scroll(direction, steps) {
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
    this._keyboard.notify_keyval(
      GLib.get_monotonic_time(),
      keyval,
      pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED
    )
  }

  KeyboardGroup() {
    return getKeyboardManager().currentLayout?.groupIndex ?? 0
  }

  // Text delivered through the input method needs no key for any character.
  CommitText(text) {
    if (!Main.inputMethod.currentFocus) return false
    Main.inputMethod.commit(text)
    return true
  }

  SetClipboard(text) {
    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text)
  }

  // Launching from the shell gives the app the same session context as the dash.
  LaunchApp(desktopId, uris) {
    const app = Shell.AppSystem.get_default().lookup_app(desktopId)
    if (!app) throw new Error(`APP_NOT_FOUND: No installed application has ID ${desktopId}.`)
    if (uris.length > 0)
      app.get_app_info().launch_uris(uris, global.create_app_launch_context(0, -1))
    else if (app.get_n_windows() > 0) app.activate()
    else app.open_new_window(-1)
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
