"""Tests of the floating window: python3 -m unittest discover -s tests -p 'test_*.py'."""
import json
import os
import re
import sys
import tempfile
import unittest

HOOKS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks")
sys.path.insert(0, HOOKS)

import board_popup  # noqa: E402


def _no_real_programs(*args, **kwargs):
    raise AssertionError(f"a test started a real program: {args!r}")


# The guard: no test starts fzf or tmux. A test that forgot to replace the launcher
# fails here instead of opening a window on the person's screen
board_popup.launch_fzf = _no_real_programs
board_popup.call_tmux = _no_real_programs
board_popup.fzf_version = _no_real_programs

MINUTE = 60_000
HOUR = 60 * MINUTE
DAY = 24 * HOUR
NOW = 1_800_000_000_000
STALE = 10 * MINUTE
HOME = "/home/u"
COLORS = dict(board_popup.DEFAULT_PALETTE)

_ANSI = re.compile(r"\x1b\[[0-9;]*m")


def plain(text):
    """The line without its color codes."""
    return _ANSI.sub("", text)


def session(**fields):
    return {
        "id": "id",
        "pid": 1,
        "title": "Some title",
        "cwd": "/home/u/work/app",
        "status": "idle",
        "statusSinceMs": NOW,
        "lastPrompt": "prompt",
        "lastReply": "A reply.",
        "activity": None,
        "tmuxPane": "%1",
        "tmuxTarget": "main:@1.%1",
        "stamp": "s1",
        "digest": "digest",
        **fields,
    }


WAIT = session(id="wait", pid=10, title="PROJ-1532 collision spec draft", cwd="/home/u/work/billing-api",
               statusSinceMs=NOW - 3 * MINUTE, tmuxPane="%4", tmuxTarget="memory:@4.%4")
WORK = session(id="work", pid=20, title="Save the Claude sessions", cwd="/home/u/github/claude-mods", status="busy",
               statusSinceMs=NOW - 42 * MINUTE, activity="Bash", tmuxPane="%7", tmuxTarget="HOME:@7.%7")
OLD = session(id="old", pid=30, title="ETL v1->v2: spec review", cwd="/home/u/work/billing-api",
              statusSinceMs=NOW - 2 * HOUR, tmuxPane="%2", tmuxTarget="memory:@2.%2")
HERE = session(id="here", pid=40, title="VPN autostart", cwd="/home/u", statusSinceMs=NOW - 5 * HOUR,
               tmuxPane="%5", tmuxTarget="HOME:@5.%5")
ALL = [WAIT, WORK, OLD, HERE]


class PhaseTest(unittest.TestCase):
    def test_a_session_waits_up_to_the_threshold_and_is_stale_past_it(self):
        self.assertEqual(board_popup.phase_of(session(statusSinceMs=NOW - STALE), NOW, STALE), "waiting")
        self.assertEqual(board_popup.phase_of(session(statusSinceMs=NOW - STALE - 1), NOW, STALE), "stale")

    def test_a_busy_session_works_however_long(self):
        self.assertEqual(board_popup.phase_of(session(status="busy", statusSinceMs=NOW - 3 * HOUR), NOW, STALE), "working")

    def test_an_unknown_status_waits_like_an_idle_one(self):
        self.assertEqual(board_popup.phase_of(session(status="blocked", statusSinceMs=NOW - MINUTE), NOW, STALE), "waiting")
        self.assertEqual(board_popup.phase_of(session(status="blocked", statusSinceMs=NOW - HOUR), NOW, STALE), "stale")

    def test_age_label_counts_minutes_hours_days(self):
        cases = [(0, "<1 min"), (MINUTE - 1, "<1 min"), (MINUTE, "1 min"), (HOUR - 1, "59 min"), (HOUR, "1 h"),
                 (DAY - 1, "23 h"), (DAY, "1 d"), (3 * DAY + HOUR, "3 d"), (-5 * MINUTE, "<1 min")]
        for elapsed, label in cases:
            self.assertEqual(board_popup.age_label(elapsed), label, elapsed)

    def test_state_label_says_who_waits_and_for_how_long(self):
        self.assertEqual(board_popup.state_label(session(statusSinceMs=NOW - 3 * MINUTE), "waiting", NOW), "waiting for you 3 min")
        self.assertEqual(board_popup.state_label(session(status="busy", statusSinceMs=NOW - 42 * MINUTE), "working", NOW), "working 42 min")
        self.assertEqual(board_popup.state_label(session(statusSinceMs=NOW - 2 * HOUR), "stale", NOW), "waiting 2 h")
        self.assertEqual(board_popup.state_label(session(status="blocked", statusSinceMs=NOW - 3 * MINUTE), "waiting", NOW), "blocked 3 min")


class OrderTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.order_file = os.path.join(self._tmp.name, "order.json")

    def test_the_waiting_first_then_the_working_then_the_stale_the_latest_on_top(self):
        self.assertEqual(board_popup.order_of([HERE, OLD, WORK, WAIT], NOW, STALE), ["wait", "work", "old", "here"])

    def test_a_tie_is_broken_by_pid(self):
        a, b = session(id="a", pid=9), session(id="b", pid=3)
        self.assertEqual(board_popup.order_of([a, b], NOW, STALE), ["b", "a"])

    def test_merge_keeps_every_pinned_place_and_appends_the_new(self):
        live = [session(id="new"), session(id="b")]
        self.assertEqual(board_popup.merge_order(["a", "b"], live), ["a", "b", "new"])

    def test_the_order_is_pinned_in_a_file_for_as_long_as_the_window_lives(self):
        first = board_popup.pinned_order(self.order_file, ALL, NOW, STALE)
        self.assertEqual(first, ["wait", "work", "old", "here"])
        # `old` is back at work, `wait` went stale, `work` ended, a new one appeared
        fresh = session(id="fresh", pid=5)
        later = [dict(WAIT, statusSinceMs=NOW - HOUR), dict(OLD, status="busy", statusSinceMs=NOW), HERE, fresh]
        self.assertEqual(board_popup.pinned_order(self.order_file, later, NOW, STALE), ["wait", "work", "old", "here", "fresh"])
        with open(self.order_file, encoding="utf-8") as handle:
            self.assertEqual(json.load(handle), ["wait", "work", "old", "here", "fresh"])

    def test_a_broken_order_file_starts_the_order_anew(self):
        with open(self.order_file, "w", encoding="utf-8") as handle:
            handle.write("{broken")
        self.assertEqual(board_popup.pinned_order(self.order_file, [WORK, WAIT], NOW, STALE), ["wait", "work"])


class PaletteTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def write(self, name, value):
        path = os.path.join(self.root, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(value if isinstance(value, str) else json.dumps(value))

    def test_a_custom_theme_gives_its_colors_and_the_defaults_fill_the_rest(self):
        self.write("settings.json", {"theme": "custom:mytheme"})
        self.write("themes/mytheme.json", {"name": "mytheme", "overrides": {"claude": "#CDB184", "selectionBg": "#35424F", "text": "not a color"}})
        colors = board_popup.palette(self.root)
        self.assertEqual(colors["claude"], "#CDB184")
        self.assertEqual(colors["selectionBg"], "#35424F")
        self.assertEqual(colors["text"], board_popup.DEFAULT_PALETTE["text"])
        self.assertEqual(colors["success"], board_popup.DEFAULT_PALETTE["success"])

    def test_a_built_in_theme_a_missing_file_and_broken_json_give_the_defaults(self):
        self.assertEqual(board_popup.palette(self.root), board_popup.DEFAULT_PALETTE)
        self.write("settings.json", {"theme": "dark"})
        self.assertEqual(board_popup.palette(self.root), board_popup.DEFAULT_PALETTE)
        self.write("settings.json", {"theme": "custom:gone"})
        self.assertEqual(board_popup.palette(self.root), board_popup.DEFAULT_PALETTE)
        self.write("settings.json", {"theme": "custom:bad"})
        self.write("themes/bad.json", "{broken")
        self.assertEqual(board_popup.palette(self.root), board_popup.DEFAULT_PALETTE)
        self.write("settings.json", "[1, 2]")
        self.assertEqual(board_popup.palette(self.root), board_popup.DEFAULT_PALETTE)

    def test_a_theme_name_cannot_leave_the_themes_folder(self):
        self.write("settings.json", {"theme": "custom:../secret"})
        self.write("secret.json", {"overrides": {"claude": "#000000"}})
        self.assertEqual(board_popup.palette(self.root), board_popup.DEFAULT_PALETTE)

    def test_paint_wraps_text_in_a_true_color_and_resets_it(self):
        self.assertEqual(board_popup.paint("x", "#CDB184"), "\x1b[38;2;205;177;132mx\x1b[0m")
        self.assertEqual(board_popup.paint("x", "#CDB184", bold=True), "\x1b[1;38;2;205;177;132mx\x1b[0m")
        self.assertEqual(board_popup.paint("x", None), "x")


class ListTest(unittest.TestCase):
    def lines(self, sessions=ALL, order=None, current="here", width=80):
        order = order or board_popup.order_of(sessions, NOW, STALE)
        return board_popup.list_lines(sessions, order, NOW, STALE, current, HOME, COLORS, width)

    def fields(self, line):
        return line.split("\t")

    def test_a_line_is_the_id_the_title_and_what_is_shown(self):
        lines = self.lines()
        self.assertEqual([self.fields(line)[0] for line in lines], ["wait", "work", "old", "here"])
        self.assertEqual(self.fields(lines[0])[1], "PROJ-1532 collision spec draft")
        self.assertEqual(len(self.fields(lines[0])), 3)
        # The id and the title go to fzf as they are, uncolored
        self.assertNotIn("\x1b", self.fields(lines[0])[0] + self.fields(lines[0])[1])

    def test_what_is_shown_is_the_mark_the_number_the_title_the_project_and_the_age(self):
        shown = [plain(self.fields(line)[2]) for line in self.lines()]
        self.assertEqual(shown[0], "● 1  PROJ-1532 collision spec draft                 billing-api            3 min")
        self.assertEqual(shown[1], "◐ 2  Save the Claude sessions                       claude-mods           42 min")
        self.assertEqual(shown[2], "○ 3  ETL v1->v2: spec review                        billing-api              2 h")
        self.assertEqual(shown[3], "○ 4  VPN autostart (this)                           ~                        5 h")
        self.assertEqual({len(line) for line in shown}, {80})

    def test_the_mark_takes_the_color_of_the_state_and_a_stale_row_is_dim(self):
        lines = [self.fields(line)[2] for line in self.lines()]
        self.assertTrue(lines[0].startswith(board_popup.paint("●", COLORS["claude"])))
        self.assertTrue(lines[1].startswith(board_popup.paint("◐", COLORS["success"])))
        self.assertTrue(lines[2].startswith(board_popup.paint("○", COLORS["inactive"])))
        # A stale session's title is gray over its whole cell: 46 in a list of 80
        self.assertIn(board_popup.paint("ETL v1->v2: spec review".ljust(46), COLORS["inactive"]), lines[2])

    def test_a_number_is_the_pinned_place_and_only_the_first_nine_get_one(self):
        many = [session(id=f"s{n}", pid=n + 1, statusSinceMs=NOW - n * 1000) for n in range(11)]
        shown = [plain(line.split("\t")[2]) for line in self.lines(many)]
        self.assertTrue(shown[0].startswith("● 1  "))
        self.assertTrue(shown[8].startswith("● 9  "))
        self.assertTrue(shown[9].startswith("●    "))
        # A session that ended leaves its number unused
        gone = self.lines([WORK, OLD, HERE], order=["wait", "work", "old", "here"])
        self.assertEqual([plain(line.split("\t")[2])[:3] for line in gone], ["◐ 2", "○ 3", "○ 4"])

    def test_a_long_title_is_cut_and_the_mark_of_this_session_stays_whole(self):
        long = session(id="long", title="A very long title of a session that does not fit a row of the list")
        shown = plain(self.lines([long], current="long", width=60)[0].split("\t")[2])
        self.assertEqual(len(shown), 60)
        self.assertIn("A very long ti", shown)
        self.assertIn("… (this)", shown)

    def test_a_narrow_list_drops_the_project(self):
        shown = plain(self.lines([WAIT], width=48)[0].split("\t")[2])
        self.assertEqual(shown, "● 1  PROJ-1532 collision spec draft        3 min")
        self.assertNotIn("billing-api", shown)

    def test_tabs_and_line_breaks_in_a_title_do_not_break_the_line(self):
        odd = session(id="odd", title="one\ttwo\nthree")
        fields = self.lines([odd])[0].split("\t")
        self.assertEqual(len(fields), 3)
        self.assertEqual(fields[1], "one two three")


class PreviewTest(unittest.TestCase):
    def lines(self, one, phase, summary=None, width=60):
        return board_popup.preview_lines(one, phase, summary, NOW, HOME, width, COLORS)

    def test_the_state_where_the_session_is_the_prompt_the_summary_and_the_last_reply(self):
        said = {"stamp": "s0", "text": "Fixed the tests, waits for a call on the commits.", "atMs": NOW}
        waiting = session(statusSinceMs=NOW - 3 * MINUTE, lastPrompt="fix the tests", lastReply="Done.")
        self.assertEqual(
            [plain(line) for line in self.lines(waiting, "waiting", said)],
            ["● waiting for you 3 min", "~/work/app", "tmux main:@1.%1", "", "you", "fix the tests", "", "summary",
             "Fixed the tests, waits for a call on the commits.", "", "agent", "Done."],
        )

    def test_the_state_is_bold_in_its_color_and_the_labels_are_quiet(self):
        lines = self.lines(session(status="busy", activity="Bash"), "working")
        self.assertEqual(lines[0], board_popup.paint("◐ working <1 min", COLORS["success"], bold=True))
        self.assertEqual(lines[1], board_popup.paint("~/work/app", COLORS["suggestion"]))
        self.assertEqual(lines[2], board_popup.paint("tmux main:@1.%1", COLORS["subtle"]))
        self.assertIn(board_popup.paint("you", COLORS["subtle"]), lines)
        self.assertIn(board_popup.paint("now", COLORS["subtle"]), lines)

    def test_a_working_session_names_the_tool_it_runs_and_a_waiting_one_does_not(self):
        busy = session(status="busy", activity="Bash", lastPrompt=None, lastReply=None)
        self.assertEqual([plain(line) for line in self.lines(busy, "working")][3:], ["", "now", "Bash"])
        self.assertNotIn("now", [plain(line) for line in self.lines(dict(busy, status="idle"), "waiting")])

    def test_a_session_outside_tmux_says_so_and_one_with_nothing_said_says_that(self):
        fresh = session(tmuxPane=None, tmuxTarget=None, lastPrompt=None, lastReply=None, stamp=None, digest=None)
        self.assertEqual(
            [plain(line) for line in self.lines(fresh, "waiting")],
            ["● waiting for you <1 min", "~/work/app", "not in tmux", "", "Nothing has been asked in this session yet"],
        )

    def test_long_text_is_wrapped_three_lines_of_prompt_five_of_summary_four_of_reply(self):
        words = lambda word: " ".join([word] * 60)  # noqa: E731
        wordy = session(lastPrompt=words("prompt"), lastReply=words("reply"))
        lines = [plain(line) for line in self.lines(wordy, "waiting", {"stamp": "s", "text": words("summary"), "atMs": NOW}, width=30)]

        def under(label):
            rest = lines[lines.index(label) + 1:]
            return rest[: rest.index("")] if "" in rest else rest

        self.assertEqual(len(under("you")), 3)
        self.assertEqual(len(under("summary")), 5)
        self.assertEqual(len(under("agent")), 4)
        self.assertTrue(all(len(line) <= 30 for line in lines))
        self.assertTrue(under("you")[2].endswith("…"))

    def test_a_long_state_and_a_long_path_are_cut_the_path_from_its_start(self):
        deep = session(status="permission-prompt-open", cwd="/home/u/work/acme/platform/memory/billing-payments-importer",
                       tmuxTarget="billing-payments-importer:@4.%4")
        lines = [plain(line) for line in self.lines(deep, "waiting", width=20)]
        self.assertEqual(lines[:3], ["● permission-prompt…", "…g-payments-importer", "tmux billing-paymen…"])

    def test_summaries_are_read_from_the_file_the_mod_writes(self):
        with tempfile.TemporaryDirectory() as root:
            path = os.path.join(root, "summaries.json")
            self.assertEqual(board_popup.load_summaries(path), {})
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("{half written")
            self.assertEqual(board_popup.load_summaries(path), {})
            with open(path, "w", encoding="utf-8") as handle:
                json.dump({"a": {"stamp": "s", "text": "summary", "atMs": 1}, "b": "not a summary", "c": {"text": 5}}, handle)
            self.assertEqual(board_popup.load_summaries(path), {"a": {"stamp": "s", "text": "summary", "atMs": 1}})


class ChoiceTest(unittest.TestCase):
    ORDER = ["wait", "work", "old", "here"]

    def target(self, choice, sessions=ALL, current="here"):
        return board_popup.target_of(choice, sessions, self.ORDER, current)

    def test_what_fzf_printed_is_a_session_a_number_or_nothing(self):
        self.assertEqual(board_popup.parse_choice("work\n"), ("session", "work"))
        self.assertEqual(board_popup.parse_choice("number:3\n"), ("number", 3))
        self.assertIsNone(board_popup.parse_choice(""))
        self.assertIsNone(board_popup.parse_choice("\n"))
        self.assertIsNone(board_popup.parse_choice("number:x\n"))

    def test_a_session_is_gone_to_by_its_pane(self):
        self.assertEqual(self.target(("session", "work")), ("%7", None))

    def test_a_number_is_the_pinned_place_whatever_the_search_left(self):
        self.assertEqual(self.target(("number", 3)), ("%2", None))
        self.assertEqual(self.target(("number", 1)), ("%4", None))

    def test_a_number_nobody_holds_and_a_session_that_ended_say_so(self):
        self.assertEqual(self.target(("number", 9)), (None, "No session under number 9"))
        self.assertEqual(self.target(("number", 2), sessions=[WAIT, OLD, HERE]), (None, "No session under number 2"))
        self.assertEqual(self.target(("session", "gone")), (None, "The session has already ended"))

    def test_this_session_and_a_session_outside_tmux_are_not_gone_to(self):
        self.assertEqual(self.target(("session", "here")), (None, "You are already in this session"))
        outside = dict(WORK, tmuxPane=None, tmuxTarget=None)
        self.assertEqual(self.target(("session", "work"), sessions=[WAIT, outside, OLD, HERE]),
                         (None, "This session is not in tmux: cannot go to it"))

    def test_nothing_chosen_goes_nowhere_and_says_nothing(self):
        self.assertEqual(self.target(None), (None, None))


class FzfTest(unittest.TestCase):
    SCRIPT = "/mods/session board/hooks/board_popup.py"

    def opts(self, **over):
        opts = {"config": "/home/u/.claude", "summaries": "/run/u/s board/summaries.json", "current": "here",
                "stale_minutes": 10, "order": "/tmp/w/order.json", "socket": "/tmp/w/fzf.sock"}
        opts.update(over)
        return opts

    def argv(self, columns=200, **over):
        return board_popup.fzf_argv(self.SCRIPT, self.opts(**over), COLORS, columns)

    def after(self, argv, flag):
        return argv[argv.index(flag) + 1]

    def binds(self, argv):
        return [argv[index + 1] for index, flag in enumerate(argv) if flag == "--bind"]

    def test_the_window_is_split_between_the_list_and_the_preview_by_its_width(self):
        # The list takes 45% of the window within 50-90 columns, the preview the rest
        self.assertEqual(board_popup.split(200), (90, 110))
        self.assertEqual(board_popup.split(160), (72, 88))
        self.assertEqual(board_popup.split(100), (50, 50))
        self.assertEqual(board_popup.split(60), (50, 10))

    def test_fzf_is_given_the_picker_look(self):
        argv = self.argv()
        self.assertEqual(argv[0], "fzf")
        self.assertNotIn("--tmux", argv)
        self.assertEqual(self.after(argv, "--style"), "full:rounded")
        self.assertEqual(self.after(argv, "--border"), "none")
        self.assertEqual(self.after(argv, "--layout"), "reverse")
        self.assertEqual(self.after(argv, "--input-label"), " Active sessions ")
        self.assertEqual(self.after(argv, "--ghost"), "search · enter: go · alt+digit: by number")
        self.assertNotIn("--footer", argv)
        self.assertEqual(self.after(argv, "--listen"), "/tmp/w/fzf.sock")
        self.assertEqual(self.after(argv, "--with-nth"), "3")
        self.assertEqual(self.after(argv, "--accept-nth"), "1")
        self.assertEqual(self.after(argv, "--preview-window"), "right,110")
        for flag in ("--ansi", "--no-sort", "--track", "--highlight-line", "--no-multi"):
            self.assertIn(flag, argv)

    def test_the_list_and_the_preview_come_from_this_script_paths_quoted(self):
        argv = self.argv()
        start = next(bind for bind in self.binds(argv) if bind.startswith("start:"))
        self.assertIn("reload-sync(", start)
        self.assertIn("'/mods/session board/hooks/board_popup.py' list", start)
        self.assertIn("--order /tmp/w/order.json", start)
        self.assertIn("--current here", start)
        # The list lines are made exactly for the text of the list frame: 90 columns less its chrome
        self.assertIn(f"--width {90 - board_popup.LIST_CHROME}", start)
        preview = self.after(argv, "--preview")
        self.assertIn("'/mods/session board/hooks/board_popup.py' preview", preview)
        self.assertIn("--summaries '/run/u/s board/summaries.json'", preview)
        self.assertTrue(preview.endswith("--id {1}"))

    def test_alt_and_a_digit_ask_for_the_session_under_that_number(self):
        binds = self.binds(self.argv())
        for digit in range(1, 10):
            self.assertIn(f"alt-{digit}:become(printf number:{digit})", binds)

    def test_the_counter_is_found_of_total_and_nothing_else(self):
        self.assertEqual(self.after(self.argv(), "--info-command"), 'printf "%s/%s" "$FZF_MATCH_COUNT" "$FZF_TOTAL_COUNT"')

    def test_the_colors_come_from_the_palette(self):
        color = self.after(self.argv(), "--color")
        self.assertIn(f"bg+:{COLORS['selectionBg']}", color)
        self.assertIn(f"border:{COLORS['promptBorder']}", color)
        self.assertIn(f"label:{COLORS['claude']}:bold", color)

    def test_the_reload_the_window_is_sent_names_the_same_list_command(self):
        action = board_popup.reload_action(self.SCRIPT, self.opts(), 200)
        start = next(bind for bind in self.binds(self.argv()) if bind.startswith("start:"))
        self.assertEqual(action, start[len("start:"):] + "+refresh-preview")

    def test_the_popup_is_in_the_middle_without_a_border_of_its_own_and_runs_the_picker(self):
        argv = board_popup.popup_argv(self.SCRIPT, self.opts(result="/tmp/w/result.json"))
        self.assertEqual(argv[:8], ["tmux", "display-popup", "-B", "-E", "-w", "80%", "-h", "70%"])
        self.assertEqual(argv[8], sys.executable)
        self.assertEqual(argv[9:11], [self.SCRIPT, "pick"])
        for flag, value in (("--config", "/home/u/.claude"), ("--summaries", "/run/u/s board/summaries.json"),
                            ("--current", "here"), ("--stale-minutes", "10"), ("--order", "/tmp/w/order.json"),
                            ("--socket", "/tmp/w/fzf.sock"), ("--result", "/tmp/w/result.json")):
            self.assertEqual(self.after(argv, flag), value)


class PickTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.addCleanup(self._tmp.cleanup)
        self.launched = []

    def pick(self, fzf):
        def launch(argv, socket_path, action):
            self.launched.append((argv, socket_path, action))
            return fzf

        opts = {"config": self.root, "summaries": os.path.join(self.root, "s.json"), "current": "here", "stale_minutes": 10,
                "order": os.path.join(self.root, "order.json"), "socket": os.path.join(self.root, "fzf.sock"),
                "result": os.path.join(self.root, "result.json")}
        code = board_popup.pick(opts, launch=launch, columns=lambda: 160)
        with open(opts["result"], encoding="utf-8") as handle:
            return code, json.load(handle)

    def test_what_fzf_said_is_left_in_the_result_file_for_the_one_who_opened_the_popup(self):
        code, result = self.pick((0, "work\n", ""))
        self.assertEqual(code, 0)
        self.assertEqual(result, {"code": 0, "out": "work\n", "err": ""})
        argv, socket_path, action = self.launched[0]
        self.assertEqual(argv[0], "fzf")
        # A window of 160: the preview gets 88 columns
        self.assertEqual(argv[argv.index("--preview-window") + 1], "right,88")
        self.assertTrue(socket_path.endswith("fzf.sock"))
        self.assertTrue(action.startswith("reload-sync("))

    def test_an_fzf_that_fails_leaves_its_code_and_its_words(self):
        code, result = self.pick((2, "", "unknown option: --ghost\n"))
        self.assertEqual(code, 2)
        self.assertEqual(result, {"code": 2, "out": "", "err": "unknown option: --ghost\n"})


class GuardTest(unittest.TestCase):
    def test_a_run_without_its_own_launchers_uses_the_modules_which_the_tests_have_disarmed(self):
        opts = {"config": "/nowhere", "summaries": "/nowhere/s.json", "current": "x", "stale_minutes": 10}
        with self.assertRaises(AssertionError):
            board_popup.run(opts, env={"TMUX": "x"}, which=lambda name: "/usr/bin/fzf",
                            build=lambda config_dir: {"sessions": [], "skipped": 0})
        with tempfile.TemporaryDirectory() as root:
            pick_opts = dict(opts, order=f"{root}/o.json", socket=f"{root}/s.sock", result=f"{root}/r.json")
            with self.assertRaises(AssertionError):
                board_popup.pick(pick_opts, columns=lambda: 100)


class RunTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.addCleanup(self._tmp.cleanup)
        self.tmux_calls = []
        self.popups = []

    def run_popup(self, picked=(0, "work\n", ""), env=None, has_fzf=True, sessions=ALL, popup_code=0, version=(0, 74)):
        def tmux(argv):
            if argv[1] != "display-popup":
                self.tmux_calls.append(argv)
                return 0
            self.popups.append(argv)
            # The popup ran: the picker inside it left its answer in the file
            if picked is not None:
                with open(argv[argv.index("--result") + 1], "w", encoding="utf-8") as handle:
                    json.dump({"code": picked[0], "out": picked[1], "err": picked[2]}, handle)
            return popup_code

        opts = {"config": self.root, "summaries": os.path.join(self.root, "summaries.json"), "current": "here", "stale_minutes": 10}
        return board_popup.run(
            opts,
            env={"TMUX": "/tmp/tmux-1000/default,1,0"} if env is None else env,
            which=lambda name: "/usr/bin/fzf" if has_fzf else None,
            build=lambda config_dir: {"sessions": sessions, "skipped": 0},
            tmux=tmux,
            now_ms=lambda: NOW,
            version=lambda: version,
        )

    def test_an_fzf_older_than_the_window_needs_opens_no_popup_at_all(self):
        # A popup that opens only for fzf to refuse its options would flash on every opening
        self.assertEqual(self.run_popup(version=(0, 70)), board_popup.EXIT_NO_FZF)
        self.assertEqual(self.run_popup(version=(0, 44)), board_popup.EXIT_NO_FZF)
        self.assertEqual(self.popups, [])
        self.assertEqual(self.tmux_calls, [])

    def test_the_oldest_fzf_that_will_do_opens_the_window_and_so_does_one_that_does_not_say(self):
        self.assertEqual(self.run_popup(version=(0, 71)), 0)
        self.assertEqual(self.run_popup(version=(1, 0)), 0)
        self.assertEqual(self.run_popup(version=None), 0)
        self.assertEqual(len(self.popups), 3)

    def test_the_version_is_read_from_what_fzf_prints(self):
        self.assertEqual(board_popup.parse_fzf_version("0.74.4 (a140afeb)\n"), (0, 74))
        self.assertEqual(board_popup.parse_fzf_version("0.44.1 (debian)"), (0, 44))
        self.assertEqual(board_popup.parse_fzf_version("1.2"), (1, 2))
        self.assertIsNone(board_popup.parse_fzf_version("fzf: not a version"))
        self.assertIsNone(board_popup.parse_fzf_version(""))

    def test_a_chosen_session_is_gone_to(self):
        self.assertEqual(self.run_popup(), 0)
        self.assertEqual(self.tmux_calls, [["tmux", "switch-client", "-t", "%7"]])
        self.assertEqual(self.popups[0][:4], ["tmux", "display-popup", "-B", "-E"])

    def test_alt_and_a_digit_goes_to_the_session_under_that_number(self):
        self.assertEqual(self.run_popup(picked=(0, "number:1\n", "")), 0)
        self.assertEqual(self.tmux_calls, [["tmux", "switch-client", "-t", "%4"]])

    def test_escape_and_enter_on_an_empty_list_go_nowhere(self):
        self.assertEqual(self.run_popup(picked=(130, "", "")), 0)
        self.assertEqual(self.run_popup(picked=(1, "", "")), 0)
        self.assertEqual(self.tmux_calls, [])

    def test_this_session_is_not_gone_to_and_tmux_says_why(self):
        self.assertEqual(self.run_popup(picked=(0, "here\n", "")), 0)
        self.assertEqual(self.tmux_calls, [["tmux", "display-message", "session-board: You are already in this session"]])

    def test_outside_tmux_and_without_fzf_the_window_cannot_open(self):
        self.assertEqual(self.run_popup(env={}), board_popup.EXIT_NO_TMUX)
        self.assertEqual(self.run_popup(env={"TMUX": ""}), board_popup.EXIT_NO_TMUX)
        self.assertEqual(self.run_popup(has_fzf=False), board_popup.EXIT_NO_FZF)
        self.assertEqual(self.popups, [])

    def test_an_fzf_that_fails_is_a_window_that_did_not_open(self):
        self.assertEqual(self.run_popup(picked=(2, "", "unknown option: --ghost\n")), board_popup.EXIT_NO_POPUP)
        self.assertEqual(self.tmux_calls, [])

    def test_a_popup_that_left_no_answer_is_a_window_that_did_not_open(self):
        # tmux is too old for a popup, or there is no client: the picker never ran
        self.assertEqual(self.run_popup(picked=None, popup_code=1), board_popup.EXIT_NO_POPUP)
        self.assertEqual(self.tmux_calls, [])

    def test_the_files_of_the_window_are_gone_when_it_closes(self):
        self.run_popup()
        folder = os.path.dirname(self.popups[0][self.popups[0].index("--result") + 1])
        self.assertFalse(os.path.exists(folder))


if __name__ == "__main__":
    unittest.main()
