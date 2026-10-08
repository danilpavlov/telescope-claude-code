#!/usr/bin/env python3
"""The floating window of session-board: the live sessions in fzf inside a tmux popup.

Subcommands:
    run      open a tmux popup, wait for the choice and move the tmux client to the session
    pick     what runs inside the popup: fzf with the list and the preview
    list     print the list lines for fzf
    preview  print the preview of one session

fzf takes the list and the preview from this same script, so the window rereads the registry
by itself while it is open. The mod writes the summaries to a file; the script only reads them.
"""
import argparse
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import index_live  # noqa: E402

MINUTE = 60_000
HOUR = 60 * MINUTE
DAY = 24 * HOUR
# The status of a session whose agent is working, and the status of an ordinary wait
BUSY = "busy"
IDLE = "idle"
# How often an open window rereads the list, in seconds
REFRESH_S = 5
# The size of the popup as shares of the tmux client; tmux centers it
POPUP_WIDTH = "80%"
POPUP_HEIGHT = "70%"
# The share of the window the list frame takes, and its bounds in columns; the rest is the preview
LIST_SHARE = 45
LIST_MIN = 50
LIST_MAX = 90
# Columns of the list's share that do not reach a row's text: the borders of both frames, the
# paddings, the pointer, the scrollbar. Measured on fzf 0.74 in the full style: 9-10, plus one spare
LIST_CHROME = 11
# The width of the window and of the preview when the terminal does not tell
COLUMNS_DEFAULT = 160
PREVIEW_WIDTH_DEFAULT = 60
# The cells of a list row: the mark, the number and two spaces; the age; the project
LEAD = 5
AGE = 7
PROJECT = 20
# A list narrower than this shows no project
PROJECT_FROM = 64
# How many places get a number
NUMBERS = 9
# What stands in an empty search field
GHOST = "search · enter: go · alt+digit: by number"
# What follows the title of the session the window was opened from
HERE = " (this)"
# Preview lines for a prompt, a summary and a reply
PROMPT_LINES = 3
SUMMARY_LINES = 5
REPLY_LINES = 4
MARKS = {"waiting": "●", "working": "◐", "stale": "○"}
# The Claude Code theme key a state is painted with
PHASE_COLOR = {"waiting": "claude", "working": "success", "stale": "inactive"}
RANK = {"waiting": 0, "working": 1, "stale": 2}
# The colors until a custom theme says otherwise: close to Claude Code's dark theme
DEFAULT_PALETTE = {
    "text": "#E6E6E6",
    "inactive": "#999999",
    "subtle": "#6B6B6B",
    "claude": "#D97757",
    "success": "#4EBA65",
    "suggestion": "#B1B9F9",
    "promptBorder": "#888888",
    "selectionBg": "#3A3A3A",
}
# The oldest fzf the window can be drawn with: 0.71 brought --id-nth, which keeps the selection on
# its session while the list is reread
MIN_FZF = (0, 71)
# Exit codes of run by which the mod learns that the window did not open, and draws its pane
EXIT_NO_TMUX = 3
EXIT_NO_FZF = 4
EXIT_NO_POPUP = 5

_HEX = re.compile(r"^#[0-9A-Fa-f]{6}$")
_VERSION = re.compile(r"(\d+)\.(\d+)")
_THEME_NAME = re.compile(r"^[A-Za-z0-9_-]+$")
_CUSTOM = "custom:"


def _read_json(path):
    """The content of a JSON file, or None when it is missing or does not parse."""
    try:
        with open(path, "rb") as handle:
            return json.loads(handle.read())
    except (OSError, ValueError):
        return None


def palette(config_dir):
    """The window's colors: from the custom Claude Code theme when one is chosen, else the defaults."""
    colors = dict(DEFAULT_PALETTE)
    settings = _read_json(os.path.join(config_dir, "settings.json"))
    theme = settings.get("theme") if isinstance(settings, dict) else None
    if not isinstance(theme, str) or not theme.startswith(_CUSTOM):
        return colors
    name = theme[len(_CUSTOM):]
    # A theme name is a file name in the themes folder, and nothing more
    if not _THEME_NAME.match(name):
        return colors
    custom = _read_json(os.path.join(config_dir, "themes", f"{name}.json"))
    overrides = custom.get("overrides") if isinstance(custom, dict) else None
    if isinstance(overrides, dict):
        for key in colors:
            if isinstance(overrides.get(key), str) and _HEX.match(overrides[key]):
                colors[key] = overrides[key]
    return colors


def paint(text, color, bold=False):
    """Text in the color #RRGGBB; with no color, as it is."""
    if color is None:
        return text
    red, green, blue = (int(color[index:index + 2], 16) for index in (1, 3, 5))
    return f"\x1b[{'1;' if bold else ''}38;2;{red};{green};{blue}m{text}\x1b[0m"


def phase_of(session, now_ms, stale_ms):
    """Working, waiting for the person, or waiting longer than the threshold."""
    if session["status"] == BUSY:
        return "working"
    return "stale" if now_ms - session["statusSinceMs"] > stale_ms else "waiting"


def age_label(elapsed_ms):
    if elapsed_ms < MINUTE:
        return "<1 min"
    if elapsed_ms < HOUR:
        return f"{elapsed_ms // MINUTE} min"
    return f"{elapsed_ms // HOUR} h" if elapsed_ms < DAY else f"{elapsed_ms // DAY} d"


def state_label(session, phase, now_ms):
    """What the session does and for how long; an unknown status is shown as the word itself."""
    age = age_label(now_ms - session["statusSinceMs"])
    if phase == "working":
        return f"working {age}"
    if session["status"] != IDLE:
        return f"{session['status']} {age}"
    return f"waiting for you {age}" if phase == "waiting" else f"waiting {age}"


def order_of(sessions, now_ms, stale_ms):
    """The ids in display order: waiting, working, stale; the latest change of state on top."""
    ranked = sorted(
        sessions,
        key=lambda session: (RANK[phase_of(session, now_ms, stale_ms)], -session["statusSinceMs"], session["pid"]),
    )
    return [session["id"] for session in ranked]


def merge_order(pinned, sessions):
    """The pinned order with the new sessions at its end; one that ended keeps its place."""
    return list(pinned) + [session["id"] for session in sessions if session["id"] not in pinned]


def pinned_order(path, sessions, now_ms, stale_ms):
    """The order pinned for the window's life: the first call computes it, later ones add to it."""
    kept = _read_json(path)
    if isinstance(kept, list) and all(isinstance(item, str) for item in kept):
        order = merge_order(kept, sessions)
    else:
        order = order_of(sessions, now_ms, stale_ms)
    try:
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(order, handle)
    except OSError:
        pass
    return order


def clip(text, width):
    """Text cut at its end to a width."""
    return text if len(text) <= width else text[: max(0, width - 1)] + "…"


def clip_start(text, width):
    """Text cut at its start to a width: a path keeps its last parts."""
    return text if len(text) <= width else "…" + (text[1 - width:] if width > 1 else "")


def wrap(text, width, max_lines):
    """Text wrapped at spaces to a width; what does not fit the lines is cut."""
    room = max(1, width)
    lines = []
    rest = text.strip()
    while rest and len(lines) < max_lines:
        if len(rest) <= room:
            lines.append(rest)
            break
        if len(lines) == max_lines - 1:
            lines.append(clip(rest, room))
            break
        space = rest.rfind(" ", 0, room + 1)
        at = space if space > 0 else room
        lines.append(rest[:at])
        rest = rest[at:].lstrip()
    return lines


def directory_of(cwd, home):
    """The session's folder as a person writes it: from ~ inside the home directory."""
    if home and cwd == home:
        return "~"
    return "~" + cwd[len(home):] if home and cwd.startswith(home + "/") else cwd


def _one_line(text):
    return " ".join(text.split())


def list_lines(sessions, order, now_ms, stale_ms, current, home, colors, width):
    """The list lines for fzf: the id, the title and what is shown, tab-separated."""
    by_id = {session["id"]: session for session in sessions}
    project_cell = PROJECT if width >= PROJECT_FROM else 0
    title_cell = max(8, width - LEAD - (project_cell + 1 if project_cell else 0) - 1 - AGE)
    lines = []
    for place, session_id in enumerate(order):
        session = by_id.get(session_id)
        # A session that ended keeps its place but is not drawn
        if session is None:
            continue
        phase = phase_of(session, now_ms, stale_ms)
        quiet = colors["inactive"] if phase == "stale" else None
        title = _one_line(session["title"])
        suffix = HERE if session_id == current else ""
        shown_title = (clip(title, max(1, title_cell - len(suffix))) + suffix).ljust(title_cell)
        number = str(place + 1) if place < NUMBERS else " "
        shown = f"{paint(MARKS[phase], colors[PHASE_COLOR[phase]])} {paint(number, colors['subtle'])}  {paint(shown_title, quiet)}"
        if project_cell:
            project = os.path.basename(directory_of(session["cwd"], home)) or "/"
            shown += " " + paint(clip(project, project_cell).ljust(project_cell), quiet or colors["suggestion"])
        shown += " " + paint(age_label(now_ms - session["statusSinceMs"]).rjust(AGE), colors["inactive"])
        lines.append(f"{session_id}\t{title}\t{shown}")
    return lines


def preview_lines(session, phase, summary, now_ms, home, width, colors):
    """The preview of a session, line by line: what it does, where it is, what was asked, what was done."""
    lines = [
        paint(clip(f"{MARKS[phase]} {state_label(session, phase, now_ms)}", width), colors[PHASE_COLOR[phase]], bold=True),
        paint(clip_start(directory_of(session["cwd"], home), width), colors["suggestion"]),
        paint(clip("not in tmux" if session["tmuxTarget"] is None else f"tmux {session['tmuxTarget']}", width), colors["subtle"]),
    ]
    head = len(lines)

    def section(label, text):
        lines.extend(["", paint(label, colors["subtle"])] + text)

    if session["lastPrompt"] is not None:
        section("you", wrap(session["lastPrompt"], width, PROMPT_LINES))
    if summary is not None:
        section("summary", wrap(summary["text"], width, SUMMARY_LINES))
    if phase == "working" and session["activity"] is not None:
        section("now", [clip(session["activity"], width)])
    if session["lastReply"] is not None:
        section("agent", wrap(session["lastReply"], width, REPLY_LINES))
    if len(lines) == head:
        lines.extend(["", paint("Nothing has been asked in this session yet", colors["subtle"])])
    return lines


def load_summaries(path):
    """The summaries the mod wrote, by session id. No file, or a half-written one: none."""
    kept = _read_json(path)
    if not isinstance(kept, dict):
        return {}
    return {
        session_id: summary
        for session_id, summary in kept.items()
        if isinstance(summary, dict) and isinstance(summary.get("text"), str)
    }


def _command(script, name, opts, keys):
    """A call of this script's subcommand as a line for fzf's shell."""
    parts = [shlex.quote(sys.executable), shlex.quote(script), name]
    for key in keys:
        parts += [f"--{key.replace('_', '-')}", shlex.quote(str(opts[key]))]
    return " ".join(parts)


def split(columns):
    """The window's columns split between the list frame and the preview frame."""
    list_frame = min(LIST_MAX, max(LIST_MIN, columns * LIST_SHARE // 100))
    return list_frame, max(10, columns - list_frame)


def _list_command(script, opts, columns):
    command = _command(script, "list", opts, ("config", "order", "current", "stale_minutes"))
    return f"{command} --width {split(columns)[0] - LIST_CHROME}"


def _reload(script, opts, columns):
    return f"reload-sync({_list_command(script, opts, columns)})"


def reload_action(script, opts, columns):
    """The action by which an open window rereads the list and the preview."""
    return f"{_reload(script, opts, columns)}+refresh-preview"


def popup_argv(script, opts):
    """A tmux popup in the middle with no border of its own: fzf draws the frames inside it."""
    argv = ["tmux", "display-popup", "-B", "-E", "-w", POPUP_WIDTH, "-h", POPUP_HEIGHT, sys.executable, script, "pick"]
    for key in ("config", "summaries", "current", "stale_minutes", "order", "socket", "result"):
        argv += [f"--{key.replace('_', '-')}", str(opts[key])]
    return argv


def fzf_argv(script, opts, colors, columns):
    """The fzf command line with the picker look, for a window of this width."""
    preview = _command(script, "preview", opts, ("config", "summaries", "stale_minutes")) + " --id {1}"
    color = ",".join(
        [
            f"fg:{colors['text']}",
            "bg:-1",
            f"hl:{colors['claude']}",
            f"fg+:{colors['text']}:bold",
            f"bg+:{colors['selectionBg']}",
            f"hl+:{colors['claude']}",
            f"border:{colors['promptBorder']}",
            f"label:{colors['claude']}:bold",
            f"prompt:{colors['claude']}",
            f"pointer:{colors['claude']}",
            f"info:{colors['inactive']}",
            f"query:{colors['text']}",
            f"ghost:{colors['subtle']}",
            "gutter:-1",
        ]
    )
    argv = [
        "fzf",
        "--ansi",
        "--delimiter", "\t",
        "--with-nth", "3",
        "--accept-nth", "1",
        "--id-nth", "1",
        "--track",
        "--no-sort",
        "--no-multi",
        "--highlight-line",
        "--style", "full:rounded",
        "--border", "none",
        "--layout", "reverse",
        "--info", "inline-right",
        # The counter "found/total" without fzf's own marks
        "--info-command", 'printf "%s/%s" "$FZF_MATCH_COUNT" "$FZF_TOTAL_COUNT"',
        "--prompt", "> ",
        # The hint in an empty search field: what to search and which keys there are
        "--ghost", GHOST,
        "--pointer", "▌",
        "--gutter", " ",
        "--input-label", " Active sessions ",
        "--preview", preview,
        "--preview-window", f"right,{split(columns)[1]}",
        "--listen", opts["socket"],
        "--color", color,
        "--bind", f"start:{_reload(script, opts, columns)}",
        # The session's title on the preview frame
        "--bind", 'focus:transform-preview-label:printf " %s " {2}',
    ]
    for digit in range(1, NUMBERS + 1):
        argv += ["--bind", f"alt-{digit}:become(printf number:{digit})"]
    return argv


def parse_choice(stdout):
    """What was chosen in the window: a session by id, a row number, or nothing."""
    line = next((line.strip() for line in stdout.splitlines() if line.strip()), "")
    if not line:
        return None
    if line.startswith("number:"):
        digits = line[len("number:"):]
        return ("number", int(digits)) if digits.isdigit() else None
    return ("session", line)


def target_of(choice, sessions, order, current):
    """The tmux pane to go to, or the reason there is nowhere to go."""
    if choice is None:
        return None, None
    by_id = {session["id"]: session for session in sessions}
    kind, value = choice
    if kind == "number":
        session = by_id.get(order[value - 1]) if 0 < value <= len(order) else None
        if session is None:
            return None, f"No session under number {value}"
    else:
        session = by_id.get(value)
        if session is None:
            return None, "The session has already ended"
    if session["id"] == current:
        return None, "You are already in this session"
    if session["tmuxPane"] is None:
        return None, "This session is not in tmux: cannot go to it"
    return session["tmuxPane"], None


def _post(socket_path, action):
    """Sends an open fzf an action through its socket; silently when the window is gone."""
    body = action.encode("utf-8")
    request = b"POST / HTTP/1.1\r\nHost: fzf\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2)
            client.connect(socket_path)
            client.sendall(request)
            client.recv(1024)
    except OSError:
        pass


def launch_fzf(argv, socket_path, action):
    """Starts fzf and, while it is open, tells it every REFRESH_S seconds to reread the list."""
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def refresh():
        while process.poll() is None:
            time.sleep(REFRESH_S)
            if process.poll() is None:
                _post(socket_path, action)

    threading.Thread(target=refresh, daemon=True).start()
    out, err = process.communicate()
    return process.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")


def parse_fzf_version(text):
    """The (major, minor) of what `fzf --version` printed, or None when it cannot be read."""
    found = _VERSION.search(text)
    return (int(found.group(1)), int(found.group(2))) if found else None


def fzf_version():
    """The version of the fzf in PATH, or None when it does not say."""
    try:
        said = subprocess.run(["fzf", "--version"], capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return parse_fzf_version(said.stdout)


def call_tmux(argv):
    return subprocess.run(argv, check=False).returncode


def _now_ms():
    return int(time.time() * 1000)


def pick(opts, launch=None, columns=None):
    """Runs inside the popup: shows fzf and leaves its answer in a file for whoever opened the popup."""
    launch = launch or launch_fzf
    width = (columns or _terminal_columns)()
    script = os.path.abspath(__file__)
    code, out, err = launch(fzf_argv(script, opts, palette(opts["config"]), width), opts["socket"], reload_action(script, opts, width))
    with open(opts["result"], "w", encoding="utf-8") as handle:
        json.dump({"code": code, "out": out, "err": err}, handle, ensure_ascii=False)
    return code


def _terminal_columns():
    return shutil.get_terminal_size((COLUMNS_DEFAULT, 40)).columns


def run(opts, env=None, which=shutil.which, build=None, tmux=None, now_ms=None, version=None):
    """Opens the popup and moves the tmux client to the chosen session. The exit code is for the mod."""
    env = os.environ if env is None else env
    build = build or index_live.build
    tmux = tmux or call_tmux
    now_ms = now_ms or _now_ms
    if not env.get("TMUX"):
        print("Not in tmux: nowhere to open the floating window", file=sys.stderr)
        return EXIT_NO_TMUX
    if which("fzf") is None:
        print("No fzf: the floating window is drawn by it", file=sys.stderr)
        return EXIT_NO_FZF
    # An fzf that would refuse the window's options is not even tried: a popup that opens only to
    # close at once would flash on every opening
    found = (version or fzf_version)()
    if found is not None and found < MIN_FZF:
        needed = ".".join(map(str, MIN_FZF))
        print(f"fzf {needed} or newer draws the floating window; this one is {found[0]}.{found[1]}", file=sys.stderr)
        return EXIT_NO_FZF
    work = tempfile.mkdtemp(prefix="session-board-")
    try:
        full = dict(
            opts,
            order=os.path.join(work, "order.json"),
            socket=os.path.join(work, "fzf.sock"),
            result=os.path.join(work, "result.json"),
        )
        tmux(popup_argv(os.path.abspath(__file__), full))
        # The picker's answer is in the file; no file means the popup did not open: an old tmux, or no client
        picked = _read_json(full["result"])
        if not isinstance(picked, dict):
            print("The tmux popup did not open", file=sys.stderr)
            return EXIT_NO_POPUP
        code = picked.get("code")
        # 0: chosen, 1: Enter on an empty list, 130: Esc
        if code not in (0, 1, 130):
            print(str(picked.get("err", "")).strip() or f"fzf exited with code {code}", file=sys.stderr)
            return EXIT_NO_POPUP
        choice = parse_choice(str(picked.get("out", ""))) if code == 0 else None
        sessions = build(opts["config"])["sessions"]
        order = pinned_order(full["order"], sessions, now_ms(), stale_ms_of(opts["stale_minutes"]))
        pane, message = target_of(choice, sessions, order, opts["current"])
        if pane is not None:
            tmux(["tmux", "switch-client", "-t", pane])
        elif message is not None:
            tmux(["tmux", "display-message", f"session-board: {message}"])
        return 0
    finally:
        shutil.rmtree(work, ignore_errors=True)


def stale_ms_of(stale_minutes):
    """The stale threshold in milliseconds; an unusable value is 10 minutes."""
    try:
        minutes = float(stale_minutes)
    except (TypeError, ValueError):
        minutes = 0
    return int(minutes * MINUTE) if minutes >= 1 and minutes != float("inf") else 10 * MINUTE


def _columns(name, fallback):
    value = os.environ.get(name, "")
    return int(value) if value.isdigit() and int(value) > 0 else fallback


def print_list(args):
    sessions = index_live.build(args.config)["sessions"]
    now = _now_ms()
    stale_ms = stale_ms_of(args.stale_minutes)
    order = pinned_order(args.order, sessions, now, stale_ms)
    home = os.path.expanduser("~")
    for line in list_lines(sessions, order, now, stale_ms, args.current, home, palette(args.config), args.width):
        print(line)
    return 0


def print_preview(args):
    colors = palette(args.config)
    session = next((one for one in index_live.build(args.config)["sessions"] if one["id"] == args.id), None)
    if session is None:
        print(paint("The session has already ended", colors["subtle"]))
        return 0
    now = _now_ms()
    width = _columns("FZF_PREVIEW_COLUMNS", PREVIEW_WIDTH_DEFAULT)
    phase = phase_of(session, now, stale_ms_of(args.stale_minutes))
    summary = load_summaries(args.summaries).get(session["id"])
    for line in preview_lines(session, phase, summary, now, os.path.expanduser("~"), width, colors):
        print(line)
    return 0


def main(argv):
    parser = argparse.ArgumentParser(prog="board_popup.py", description="The floating window of session-board")
    commands = parser.add_subparsers(dest="command", required=True)

    def command(name, *options):
        one = commands.add_parser(name)
        one.add_argument("--config", required=True)
        one.add_argument("--stale-minutes", default="10")
        for option in options:
            one.add_argument(option, required=True)
        return one

    command("run", "--summaries", "--current")
    command("pick", "--summaries", "--current", "--order", "--socket", "--result")
    command("list", "--order", "--current").add_argument("--width", type=int, default=COLUMNS_DEFAULT * LIST_SHARE // 100)
    command("preview", "--summaries", "--id")
    args = parser.parse_args(argv[1:])
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if args.command == "list":
        return print_list(args)
    if args.command == "preview":
        return print_preview(args)
    opts = {"config": args.config, "summaries": args.summaries, "current": args.current, "stale_minutes": args.stale_minutes}
    if args.command == "run":
        return run(opts)
    return pick(dict(opts, order=args.order, socket=args.socket, result=args.result))


if __name__ == "__main__":
    sys.exit(main(sys.argv))
