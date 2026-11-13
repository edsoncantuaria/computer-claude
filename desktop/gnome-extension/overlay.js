// What the extension draws over the desktop: Claude's own cursor and the "paused" badge.
import Clutter from "gi://Clutter"
import GLib from "gi://GLib"
import St from "gi://St"

import * as Main from "resource:///org/gnome/shell/ui/main.js"

// The agent's own cursor: it shows where Claude is acting, whether or not it moves the real pointer.
const CURSOR_LINGER_MS = 1800
// A long-running action keeps its label up this long at most if its end is never reported.
const CURSOR_BUSY_MAX_MS = 30_000
const CURSOR_FADE_MS = 350
const CURSOR_TRAVEL_MS = [140, 420]
const CURSOR_PX_PER_MS = 1.6
const TRAIL_SPACING_PX = 5
const TRAIL_FADE_MS = 800
const FRAME_MS = 16
// Claude's orange.
const ORANGE = "rgba(217, 119, 87, ALPHA)"
const color = (alpha) => ORANGE.replace("ALPHA", String(alpha))

export class AgentCursor {
  constructor() {
    this._layer = new St.Widget({ reactive: false, visible: false, opacity: 0 })
    // Claude's own pointer: a hollow white arrowhead, tip at the top left, like the one Claude in
    // Chrome draws. A thin dark rim keeps it visible on white backgrounds.
    this._arrow = new St.DrawingArea({ width: 28, height: 28, reactive: false })
    this._arrow.connect("repaint", (area) => {
      const cr = area.get_context()
      cr.setLineJoin(1) // round
      cr.setLineCap(1)
      cr.moveTo(4.4, 4.4)
      cr.lineTo(20.6, 11)
      cr.lineTo(13.9, 12.9)
      cr.lineTo(11.6, 20.6)
      cr.closePath()
      cr.setSourceRGBA(0, 0, 0, 0.5)
      cr.setLineWidth(3.6)
      cr.strokePreserve()
      cr.setSourceRGBA(0.78, 0.39, 0.26, 0.3)
      cr.fillPreserve()
      cr.setSourceRGBA(1, 1, 1, 1)
      cr.setLineWidth(1.8)
      cr.stroke()
      cr.$dispose()
    })
    // A flat orange pill that names what Claude is doing right now.
    this._label = new St.Label({
      text: "Claude",
      style:
        "background-color: rgb(192, 99, 65); color: rgb(255, 244, 236); " +
        "font-size: 12px; font-weight: 500; border-radius: 999px; padding: 4px 14px; " +
        "box-shadow: 0 1px 5px rgba(0, 0, 0, 0.3);",
    })
    this._layer.add_child(this._arrow)
    this._layer.add_child(this._label)
    Main.uiGroup.add_child(this._layer)
    this._x = null
    this._y = null
    this._tween = 0
    this._linger = 0
    this._pending = null
    this._sticky = false
    this._trail = new Set()
  }

  destroy() {
    this.hide()
    this._layer.destroy()
    this._layer = null
  }

  // Moves the arrow along an eased path, leaving a fading trail. `done` runs on arrival.
  // `label` names the action; left out, the previous one stays. `sticky` keeps the arrow and its
  // label on screen until idle() (the action is still running), with a cap in case that never comes.
  moveTo(x, y, { label, click = false, done = null, sticky = false } = {}) {
    this._stopTween()
    this._pending = done
    this._sticky = sticky
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
      this._scheduleFade(this._sticky ? CURSOR_BUSY_MAX_MS : CURSOR_LINGER_MS)
      this._settle()
      return GLib.SOURCE_REMOVE
    }
    this._tween = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, step)
  }

  // The action ended: let the arrow and its label fade out.
  idle() {
    this._sticky = false
    if (this._layer.visible && !this._tween) this._scheduleFade(CURSOR_LINGER_MS)
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

  _scheduleFade(delay = CURSOR_LINGER_MS) {
    if (this._linger) GLib.source_remove(this._linger)
    this._linger = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
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
    if (label !== undefined) this._label.text = label || "Claude"
  }

  _place(x, y) {
    this._x = x
    this._y = y
    // The arrow's tip is at (4.4, 4.4) in its own space.
    this._arrow.set_position(Math.round(x - 4), Math.round(y - 4))
    // The label sits below and to the right of the arrow, and flips to stay on its screen.
    const monitor =
      Main.layoutManager.monitors.find(
        (m) => x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height
      ) ?? Main.layoutManager.primaryMonitor
    const [, width] = this._label.get_preferred_width(-1)
    const [, height] = this._label.get_preferred_height(-1)
    let labelX = x + 28
    let labelY = y + 5
    if (labelX + width > monitor.x + monitor.width - 8) labelX = x - 8 - width
    if (labelY + height > monitor.y + monitor.height - 8) labelY = y - 8 - height
    this._label.set_position(Math.round(labelX), Math.round(labelY))
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

// A pill at the top of the screen that says the emergency stop is on.
export class HaltBadge {
  constructor() {
    this._label = new St.Label({
      text: "Claude paused · Super+Ctrl+Esc to resume",
      style:
        "background-color: rgba(28, 28, 28, 0.94); color: white; font-weight: bold; " +
        `border: 2px solid ${color(1)}; border-radius: 999px; padding: 6px 18px;`,
      reactive: false,
      visible: false,
    })
    Main.layoutManager.addTopChrome(this._label)
  }

  setVisible(visible) {
    this._label.visible = visible
    if (!visible) return
    const monitor = Main.layoutManager.primaryMonitor
    const width = this._label.get_preferred_width(-1)[1]
    this._label.set_position(Math.round(monitor.x + (monitor.width - width) / 2), monitor.y + 8)
  }

  destroy() {
    Main.layoutManager.removeChrome(this._label)
    this._label.destroy()
  }
}
