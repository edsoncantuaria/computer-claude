// Which apps the user let Claude use, and the dialog that asks.
import Clutter from "gi://Clutter"
import GLib from "gi://GLib"
import Shell from "gi://Shell"

import * as Dialog from "resource:///org/gnome/shell/ui/dialog.js"
import * as ModalDialog from "resource:///org/gnome/shell/ui/modalDialog.js"

// What the user let Claude do, by app. It lives in the module so it survives the shell disabling
// the extension on the lock screen, and it is gone at logout. Only the dialog below adds to it.
export const grants = new Map()
export const TIERS = { read: 1, click: 2, full: 3 }
export const TIER_TEXT = {
  read: "see it only",
  click: "see it, left-click and scroll",
  full: "see it, click, type and manage its windows",
}
// The shell's own interface (top bar, Activities, run prompt) is granted like an app.
export const SHELL_KEY = "shell"
// An unanswered request counts as a refusal.
const ACCESS_TIMEOUT_MS = 120_000

export function accessKey(window) {
  const app = Shell.WindowTracker.get_default().get_window_app(window)
  // An app without a launcher gets a made-up ID that changes with every window.
  return app && !app.is_window_backed() ? app.get_id() : `wm:${window.get_wm_class() ?? ""}`
}

// The name the user knows an app by, and the most Claude gets by default: browsers are only
// looked at, and terminals and IDEs only clicked, as both can do far more than they show.
export function describeApp(key) {
  if (key === SHELL_KEY)
    return { name: "GNOME Shell (top bar, Activities, run prompt)", tier: "full" }
  if (key.startsWith("wm:")) return { name: key.slice(3) || "Unnamed app", tier: "full" }
  const app = Shell.AppSystem.get_default().lookup_app(key)
  if (!app) throw new Error(`APP_NOT_FOUND: No installed application has ID ${key}.`)
  const categories = (app.get_app_info()?.get_categories() ?? "").split(";")
  let tier = "full"
  if (categories.includes("WebBrowser")) tier = "read"
  else if (categories.includes("TerminalEmulator") || categories.includes("IDE")) tier = "click"
  return { name: app.get_name(), tier }
}

// Resolves to "deny", "allow" (each app at its default tier) or "full".
export function askAccess(entries, reason) {
  return new Promise((resolve) => {
    const dialog = new ModalDialog.ModalDialog({ destroyOnClose: true })
    dialog.contentLayout.add_child(
      new Dialog.MessageDialogContent({
        title: "Let Claude use these apps?",
        description: [
          reason,
          ...entries.map((entry) => `${entry.name}: ${TIER_TEXT[entry.tier]}`),
          "This lasts until you log out.",
        ]
          .filter(Boolean)
          .join("\n"),
      })
    )
    let timer = 0
    const finish = (answer) => {
      if (timer) GLib.source_remove(timer)
      timer = 0
      dialog.close()
      resolve(answer)
    }
    // Enter and Escape both refuse, so a key meant for another window never grants anything.
    const buttons = [
      { label: "Deny", action: () => finish("deny"), key: Clutter.KEY_Escape, default: true },
    ]
    if (entries.some((entry) => entry.tier !== "full"))
      buttons.push({ label: "Allow full control", action: () => finish("full") })
    buttons.push({ label: "Allow", action: () => finish("allow") })
    dialog.setButtons(buttons)
    if (!dialog.open()) {
      dialog.destroy()
      resolve("deny")
      return
    }
    timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ACCESS_TIMEOUT_MS, () => {
      timer = 0
      finish("deny")
      return GLib.SOURCE_REMOVE
    })
  })
}
