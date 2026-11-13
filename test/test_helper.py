"""The desktop helper's own logic, without a desktop: parsing, access checks, clicks."""

import importlib.machinery
import importlib.util
import os
import sys
import unittest

sys.dont_write_bytecode = True
_path = os.path.join(os.path.dirname(__file__), "..", "desktop", "computer-claude-desktop")
_loader = importlib.machinery.SourceFileLoader("helper", _path)
helper = importlib.util.module_from_spec(importlib.util.spec_from_loader("helper", _loader))
_loader.exec_module(helper)


def window(window_id, stacking, access, x=0, y=0, width=100, height=100, **extra):
    return {
        "id": window_id, "stacking": stacking, "access": access, "x": x, "y": y, "width": width,
        "height": height, "minimized": False, "on_active_workspace": True, "focused": True,
        "app": f"App{window_id}", "wm_class": "", "title": "", "monitor": 0, **extra,
    }


class FakeDesktop:
    """Records the input a command sends instead of sending it."""

    def __init__(self, windows, need=None):
        self._windows = windows
        self.need = need
        self.sent = []

    def windows(self):
        return self._windows

    def ensure_input_available(self):
        pass

    def focus(self, _window):
        pass

    def pointer_move(self, x, y):
        self.sent.append(("move", x, y))

    def hold(self, kind, code, pressed):
        self.sent.append(("hold", code, pressed))

    def click(self, x, y, button, count, hold):
        self.sent.append(("click", x, y, button, count))


def fails_with(case, code, function, *args):
    with case.assertRaises(helper.Fail) as raised:
        function(*args)
    case.assertEqual(raised.exception.code, code)


class Arguments(unittest.TestCase):
    def test_options_flags_and_positionals(self):
        positional, options = helper.parse_args(
            ["click", "Save", "--snapshot", "S1", "--hover", "--open", "a", "--open", "b"]
        )
        self.assertEqual(positional, ["click", "Save"])
        self.assertEqual(options, {"--snapshot": "S1", "--hover": True, "--open": ["a", "b"]})

    def test_shortcuts_that_end_the_session_are_refused(self):
        fails_with(self, "BLOCKED_SHORTCUT", helper.keysyms_for_token, "ctrl+alt+delete")
        fails_with(self, "BLOCKED_SHORTCUT", helper.keysyms_for_token, "ctrl+alt+f3")
        fails_with(self, "INVALID_KEY", helper.keysyms_for_token, "ctrl+nope")
        self.assertEqual(helper.keysyms_for_token("ctrl+a"), [0xFFE3, ord("a")])


class Access(unittest.TestCase):
    def test_an_app_needs_a_grant_of_at_least_the_tier_the_command_needs(self):
        fails_with(self, "APP_NOT_GRANTED", helper.require_access, FakeDesktop([], "read"), window(1, 0, ""))
        fails_with(self, "ACCESS_TIER", helper.require_access, FakeDesktop([], "click"), window(1, 0, "read"))
        fails_with(self, "ACCESS_TIER", helper.require_access, FakeDesktop([], "full"), window(1, 0, "click"))
        for need, access in (("read", "read"), ("click", "full"), ("full", "full")):
            granted = window(1, 0, access)
            self.assertIs(helper.require_access(FakeDesktop([], need), granted), granted)

    def test_an_extension_without_access_control_is_not_gated(self):
        legacy = window(1, 0, "")
        del legacy["access"]
        self.assertIs(helper.require_access(FakeDesktop([], "full"), legacy), legacy)

    def test_resolving_a_window_checks_its_access(self):
        desktop = FakeDesktop([window(1, 0, "read")], "full")
        fails_with(self, "ACCESS_TIER", helper.resolve_window, desktop, {"--window-id": "1"})


class Clicks(unittest.TestCase):
    def click(self, access, *flags):
        desktop = FakeDesktop([window(1, 0, access, x=10, y=20)], "click")
        options = helper.parse_args(["--at", "5,5", "--window-id", "1", *flags])[1]
        return desktop, helper.command_click(desktop, [], options)

    def test_hover_moves_the_pointer_and_presses_nothing(self):
        desktop, (data, _) = self.click("click", "--hover")
        self.assertEqual(desktop.sent, [("move", 15.0, 25.0)])
        self.assertIn("hovered", data)

    def test_modifiers_are_held_around_the_click_and_released(self):
        desktop, _ = self.click("full", "--modifiers", "shift+ctrl")
        self.assertEqual(
            desktop.sent,
            [("hold", 0xFFE1, True), ("hold", 0xFFE3, True), ("click", 15.0, 25.0, 1, 1),
             ("hold", 0xFFE3, False), ("hold", 0xFFE1, False)],
        )

    def test_click_only_access_allows_a_left_click_and_nothing_more(self):
        desktop, _ = self.click("click", "--double")
        self.assertEqual(desktop.sent, [("click", 15.0, 25.0, 1, 2)])
        for flags in (["--right"], ["--long-press"], ["--modifiers", "shift"]):
            with self.assertRaises(helper.Fail) as raised:
                self.click("click", *flags)
            self.assertEqual(raised.exception.code, "ACCESS_TIER")


class Elements(unittest.TestCase):
    def test_an_exact_label_beats_one_that_only_contains_the_text(self):
        elements = [
            {"id": "E1", "role": "label", "label": "Save as", "interactive": False},
            {"id": "E2", "role": "button", "label": "Save", "interactive": True},
        ]
        self.assertEqual(helper.find_element({"elements": elements}, query="save")["id"], "E2")
        self.assertEqual(helper.find_element({"elements": elements}, query="as")["id"], "E1")
        fails_with(self, "ELEMENT_NOT_FOUND", helper.find_element, {"elements": elements}, "E9")


def picture(*dark, width=1280, height=800):
    """A white frame with dark rectangles (x, y, width, height) on it."""
    pixbuf = helper.GdkPixbuf.Pixbuf.new(helper.GdkPixbuf.Colorspace.RGB, False, 8, width, height)
    pixbuf.fill(0xFFFFFFFF)
    for x, y, w, h in dark:
        pixbuf.new_subpixbuf(x, y, w, h).fill(0x000000FF)
    return pixbuf


class Motion(unittest.TestCase):
    def test_a_blinking_caret_is_not_a_change_but_a_typed_character_is(self):
        differ = helper.frames_differ
        self.assertFalse(differ(picture(), picture()))
        self.assertFalse(differ(picture(), picture((400, 300, 2, 18))))
        self.assertTrue(differ(picture(), picture((400, 300, 8, 12))))
        self.assertTrue(differ(picture(), picture(width=1000)))

    def test_a_faint_change_is_not_a_change(self):
        faint = picture()
        faint.new_subpixbuf(100, 100, 200, 200).fill(0xF8F8F8FF)
        self.assertFalse(helper.frames_differ(picture(), faint))

    def test_a_small_region_needs_fewer_changed_pixels(self):
        self.assertTrue(helper.frames_differ(picture(width=40, height=20), picture((5, 5, 8, 1), width=40, height=20)))

    def watch(self, until, frames, timeout="1000"):
        """Run the watch command over canned frames, one per poll, on a clock that only sleep() moves."""
        clock = [0.0]
        remaining = iter(frames)
        last = [None]

        def capture():
            last[0] = next(remaining, last[0])
            return last[0]

        originals = helper.frame_source, helper.time.monotonic, helper.time.sleep
        helper.frame_source = lambda _desktop, _options: capture
        helper.time.monotonic = lambda: clock[0]
        helper.time.sleep = lambda seconds: clock.__setitem__(0, clock[0] + seconds)
        try:
            return helper.command_watch(None, [], {"--until": until, "--timeout": timeout})[0]
        finally:
            helper.frame_source, helper.time.monotonic, helper.time.sleep = originals

    def test_change_is_measured_against_the_first_frame(self):
        moved = picture((100, 100, 60, 60))
        self.assertEqual(self.watch("change", [picture(), picture(), moved]), {"met": True, "elapsed_ms": 300})
        self.assertFalse(self.watch("change", [picture()])["met"])

    def test_still_waits_for_the_picture_to_hold(self):
        frames = [picture((x, 100, 60, 60)) for x in (0, 100, 200, 300)]
        settled = self.watch("still", frames, timeout="5000")
        # Three polls of motion, then a full second without any.
        self.assertTrue(settled["met"])
        self.assertGreaterEqual(settled["elapsed_ms"], 3 * 150 + 1000)
        moving = [picture((x, 100, 60, 60)) for x in range(0, 1200, 100)]
        self.assertFalse(self.watch("still", moving, timeout="1000")["met"])


class Images(unittest.TestCase):
    def setUp(self):
        import tempfile

        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = os.path.join(self.directory.name, "encoded")

    def test_a_capture_that_already_fits_is_sent_as_it_is(self):
        source = os.path.join(self.directory.name, "capture.png")
        helper.write_png(picture((10, 10, 50, 50), width=400, height=300), source)
        loaded = helper.GdkPixbuf.Pixbuf.new_from_file(source)
        self.assertEqual((loaded.get_width(), loaded.get_height()), (400, 300))
        saved = helper.save_image(loaded, self.base, 1_000_000, 1568, source)
        self.assertEqual((saved["path"], saved["mime"], saved["scale"]), (source, "image/png", 1.0))

    def test_a_large_capture_is_downscaled_into_a_new_png(self):
        saved = helper.save_image(picture(width=3136, height=1000), self.base, 1_000_000, 1568, "unused.png")
        self.assertEqual((saved["path"], saved["mime"]), (self.base + ".png", "image/png"))
        self.assertEqual((saved["width"], saved["scale"]), (1568, 0.5))

    def test_a_picture_too_heavy_for_a_png_becomes_a_jpeg(self):
        noise = helper.GdkPixbuf.Pixbuf.new_from_bytes(
            helper.GLib.Bytes.new(os.urandom(800 * 600 * 3)), helper.GdkPixbuf.Colorspace.RGB, False, 8, 800, 600, 2400
        )
        saved = helper.save_image(noise, self.base, 2_900_000)
        self.assertEqual((saved["path"], saved["mime"]), (self.base + ".jpg", "image/jpeg"))

    def test_an_unchanged_window_is_read_once(self):
        source = os.path.join(self.directory.name, "capture.png")
        helper.write_png(picture(width=40, height=20), source)
        runs = []

        def tesseract(command, **_options):
            runs.append(command)
            return helper.subprocess.CompletedProcess(command, 0, "", "")

        originals = helper.subprocess.run, helper.shutil.which
        helper.subprocess.run, helper.shutil.which = tesseract, lambda _name: "/usr/bin/tesseract"
        try:
            helper.read_text(source)
            helper.read_text(source)
            helper.write_png(picture((1, 1, 5, 5), width=40, height=20), source)
            helper.read_text(source)
        finally:
            helper.subprocess.run, helper.shutil.which = originals
        self.assertEqual(len(runs), 2)

    def test_a_reading_that_fails_is_reported_as_a_warning(self):
        source = os.path.join(self.directory.name, "capture.png")
        helper.write_png(picture(width=30, height=30), source)

        def tesseract(command, **_options):
            return helper.subprocess.CompletedProcess(command, 1, "", "Error opening data file")

        originals = helper.subprocess.run, helper.shutil.which
        helper.subprocess.run, helper.shutil.which = tesseract, lambda _name: "/usr/bin/tesseract"
        helper.WARNINGS.clear()
        try:
            self.assertEqual(helper.read_text(source), [])
        finally:
            helper.subprocess.run, helper.shutil.which = originals
        self.assertEqual([item["code"] for item in helper.WARNINGS], ["OCR_FAILED"])
        self.assertEqual(helper.run(["nonsense"]).get("warnings"), None)


class Serving(unittest.TestCase):
    def test_one_process_answers_each_line_with_one_envelope(self):
        import json
        import subprocess

        lines = '["encode"]\nnot json\n["nonsense"]\n'
        output = subprocess.run(
            [sys.executable, "-B", _path, "serve"], input=lines, capture_output=True, text=True, timeout=30, check=True
        ).stdout
        codes = [json.loads(line)["error"]["code"] for line in output.splitlines()]
        self.assertEqual(codes, ["INVALID_ARGUMENTS", "INVALID_ARGUMENTS", "INVALID_ARGUMENTS"])


if __name__ == "__main__":
    unittest.main()
