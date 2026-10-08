#!/usr/bin/env python3
"""Live Claude Code sessions.

Reads the registry <config dir>/sessions/*.json and the tail of each live
session's transcript, prints JSON: {"sessions": [...], "skipped": N}. Writes nothing.
"""
import glob
import json
import os
import re
import sys

# How many bytes of a transcript's tail are read
TAIL_BYTES = 1024 * 1024
# Length of a title made from the last prompt
TITLE_FALLBACK_CHARS = 60
# The title of a session in which nothing has been asked yet
NEW_SESSION_TITLE = "New session"
# Length of the prompt and of the reply shown on the board
PROMPT_CHARS = 200
REPLY_CHARS = 300
# Limits of the digest the model writes a summary from
DIGEST_CHARS = 6000
DIGEST_PROMPTS = 3
DIGEST_PROMPT_CHARS = 500
DIGEST_REPLIES = 3
DIGEST_REPLY_CHARS = 1500
DIGEST_FILES = 8
# The status of a session whose agent is working
BUSY = "busy"
# The status of a registry entry that has none yet
NO_STATUS = "idle"
# What the entrypoint of a run without a person starts with: `claude -p` (sdk-cli) and the SDK.
# In the registry such runs carry the same kind as a session in a terminal
HEADLESS_ENTRYPOINT = "sdk"
# A user record with one of these flags was not written by the person
SERVICE_FLAGS = ("isMeta", "isSidechain", "isCompactSummary", "isVisibleInTranscriptOnly")
# What the text of a user record starts with when the person did not write it: task notifications
# and command inserts start with "<", the mark of an interrupted turn with "[Request interrupted"
SERVICE_PREFIXES = ("<", "[Request interrupted")
# The tool input fields that hold a file path
PATH_FIELDS = ("file_path", "notebook_path")

_PANE = re.compile(r"%\d+$")
# Half of a surrogate pair: how a string cut in the middle of an emoji lies in the file.
# UTF-8 cannot encode it, so it leaves as the replacement character
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


def _record(line):
    """A transcript record, or None when the line does not parse."""
    try:
        record = json.loads(line)
    except ValueError:
        return None
    return record if isinstance(record, dict) else None


def _text(value):
    """A non-empty string on one line, or None."""
    if not isinstance(value, str):
        return None
    return " ".join(value.split()) or None


def _blocks(record):
    """The blocks of a record's message; a string counts as one text block."""
    message = record.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [block for block in content if isinstance(block, dict)]
    return []


def _joined(blocks):
    """The text blocks as one line, or None."""
    return _text(
        " ".join(block["text"] for block in blocks if block.get("type") == "text" and isinstance(block.get("text"), str))
    )


def _prompt(record, blocks):
    """The person's prompt, or None for a service record and a tool result."""
    if any(record.get(flag) for flag in SERVICE_FLAGS):
        return None
    if any(block.get("type") == "tool_result" for block in blocks):
        return None
    text = _joined(blocks)
    return None if text is None or text.startswith(SERVICE_PREFIXES) else text


def _file_name(tool_input):
    """The name of the file a tool call works on, or None."""
    if not isinstance(tool_input, dict):
        return None
    for field in PATH_FIELDS:
        if isinstance(tool_input.get(field), str) and tool_input[field]:
            return os.path.basename(tool_input[field])
    return None


def read_tail(path):
    """The records of a transcript's tail; empty when the file cannot be opened."""
    try:
        size = os.path.getsize(path)
        start = max(0, size - TAIL_BYTES)
        with open(path, "rb") as handle:
            handle.seek(start)
            lines = handle.read().splitlines()
    except OSError:
        return []
    if start > 0:
        # The first line of the tail may be cut
        lines = lines[1:]
    return [record for record in map(_record, lines) if record is not None]


def walk(records):
    """What the tail tells of a session: title, prompts, replies, the turn's tools, the position.

    The position (stamp) is the last record that changes what the digest says: a prompt from the
    person, a tool result or a record of the model.
    """
    seen = {"title": None, "noted": None, "prompts": [], "replies": [], "tools": {}, "pending": {}, "stamp": None}
    for record in records:
        kind = record.get("type")
        if kind == "ai-title":
            seen["title"] = _text(record.get("aiTitle")) or seen["title"]
        elif kind == "last-prompt":
            seen["noted"] = _text(record.get("lastPrompt")) or seen["noted"]
        # From here on only the main conversation: a subagent's records do not move it
        if kind not in ("user", "assistant") or record.get("isSidechain"):
            continue
        blocks = _blocks(record)
        if kind == "user":
            is_answer = False
            for block in blocks:
                if block.get("type") == "tool_result":
                    seen["pending"].pop(block.get("tool_use_id"), None)
                    is_answer = True
            prompt = _prompt(record, blocks)
            if prompt is not None:
                seen["prompts"].append(prompt)
                # A prompt from the person starts a new turn
                seen["tools"] = {}
            # A command, a notification, a reminder and the mark of an interruption do not move the
            # conversation: a summary of them would say the same
            if (is_answer or prompt is not None) and isinstance(record.get("uuid"), str):
                seen["stamp"] = record["uuid"]
            continue
        if isinstance(record.get("uuid"), str):
            seen["stamp"] = record["uuid"]
        reply = _joined(blocks)
        if reply is not None:
            seen["replies"].append(reply)
        for block in blocks:
            if block.get("type") != "tool_use" or not isinstance(block.get("name"), str):
                continue
            seen["pending"][block.get("id")] = block["name"]
            used = seen["tools"].setdefault(block["name"], {"count": 0, "files": []})
            used["count"] += 1
            name = _file_name(block.get("input"))
            if name is not None and name not in used["files"]:
                used["files"].append(name)
    return seen


def _tools_line(tools):
    """The turn's tools on one line: name, number of calls, file names."""
    parts = []
    room = DIGEST_FILES
    for name, used in tools.items():
        files = used["files"][:room]
        room -= len(files)
        parts.append(f"{name} ×{used['count']}" + (f" ({', '.join(files)})" if files else ""))
    return ", ".join(parts)


def build_digest(title, is_working, prompts, replies, tools):
    """The digest of a session for the model: at most DIGEST_CHARS, no tool output."""
    prompts = [prompt[:DIGEST_PROMPT_CHARS] for prompt in prompts[-DIGEST_PROMPTS:]]
    replies = [reply[:DIGEST_REPLY_CHARS] for reply in replies[-DIGEST_REPLIES:]]
    while True:
        lines = [f"Title: {title}", "State: " + ("working" if is_working else "stopped, waiting for the person")]
        if prompts:
            lines.append("Prompts from the person, oldest first:")
            lines.extend(f"- {prompt}" for prompt in prompts)
        if replies:
            lines.append("Replies from the agent, oldest first:")
            lines.extend(f"- {reply}" for reply in replies)
        if tools:
            lines.append("Tools of the current turn: " + _tools_line(tools))
        digest = "\n".join(lines)
        if len(digest) <= DIGEST_CHARS or not replies:
            return digest[:DIGEST_CHARS]
        # It does not fit: the oldest reply goes first
        replies = replies[1:]


def find_transcript(config_dir, session_id):
    """The path of a session's transcript, or None; of several, the one changed last."""
    pattern = os.path.join(glob.escape(os.path.join(config_dir, "projects")), "*", glob.escape(session_id) + ".jsonl")
    found = []
    for path in glob.glob(pattern):
        try:
            found.append((os.path.getmtime(path), path))
        except OSError:
            continue
    return max(found)[1] if found else None


def is_alive(pid, proc_start):
    """Whether the session's process is alive: the pid exists and started when the registry says."""
    if os.path.isdir("/proc/self"):
        try:
            with open(f"/proc/{pid}/stat", "rb") as handle:
                # The process name stands in brackets and may hold spaces: the fields count after it
                fields = handle.read().decode("utf-8", "replace").rsplit(")", 1)[-1].split()
        except OSError:
            return False
        # The start time is field 22 of stat, the 20th after the name
        return proc_start is None or (len(fields) > 19 and fields[19] == str(proc_start))
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        # The process is there, but it is someone else's
        return True
    return True


def _since(entry):
    """When the session took its present status, in milliseconds."""
    for field in ("statusUpdatedAt", "updatedAt", "startedAt"):
        value = entry.get(field)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return int(value)
    return 0


def index_session(config_dir, entry):
    """The list entry of one live session."""
    path = find_transcript(config_dir, entry["sessionId"])
    seen = walk(read_tail(path) if path is not None else [])
    prompt = seen["prompts"][-1] if seen["prompts"] else seen["noted"]
    if prompt is not None and prompt.startswith(SERVICE_PREFIXES):
        prompt = None
    title = seen["title"] or (prompt[:TITLE_FALLBACK_CHARS] if prompt else NEW_SESSION_TITLE)
    # The prompt is not in the tail: the digest takes the one Claude Code noted apart
    prompts = seen["prompts"] or ([prompt] if prompt else [])
    status = entry["status"] if isinstance(entry.get("status"), str) and entry["status"] else NO_STATUS
    target = entry["tmux"] if isinstance(entry.get("tmux"), str) and entry["tmux"] else None
    pane = _PANE.search(target) if target is not None else None
    stamp = seen["stamp"]
    return {
        "id": entry["sessionId"],
        "pid": entry["pid"],
        "title": title,
        "cwd": entry["cwd"] if isinstance(entry.get("cwd"), str) else "",
        "status": status,
        "statusSinceMs": _since(entry),
        "lastPrompt": prompt[:PROMPT_CHARS] if prompt else None,
        "lastReply": seen["replies"][-1][:REPLY_CHARS] if seen["replies"] else None,
        "activity": next(reversed(seen["pending"].values()), None),
        "tmuxPane": pane.group(0) if pane is not None else None,
        "tmuxTarget": target,
        "stamp": stamp,
        "digest": None
        if stamp is None
        else build_digest(title, status == BUSY, prompts, seen["replies"], seen["tools"]),
    }


def _entry(path):
    """A registry entry, or None when the file does not parse."""
    try:
        with open(path, "rb") as handle:
            entry = json.loads(handle.read())
    except (OSError, ValueError):
        return None
    if not isinstance(entry, dict):
        return None
    pid = entry.get("pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or not isinstance(entry.get("sessionId"), str):
        return None
    return entry


def _printable(value):
    """The same value with the halves of surrogate pairs in its strings replaced."""
    if isinstance(value, str):
        return _LONE_SURROGATE.sub("\ufffd", value)
    if isinstance(value, dict):
        return {key: _printable(item) for key, item in value.items()}
    return value


def _is_interactive(entry):
    """A session a person sits in: not a background one and not a `claude -p` or SDK run."""
    entrypoint = entry.get("entrypoint")
    is_headless = isinstance(entrypoint, str) and entrypoint.startswith(HEADLESS_ENTRYPOINT)
    return entry.get("kind") == "interactive" and not is_headless


def build(config_dir, alive=is_alive):
    """The live interactive sessions, by pid."""
    sessions = []
    skipped = 0
    for path in glob.glob(os.path.join(glob.escape(os.path.join(config_dir, "sessions")), "*.json")):
        entry = _entry(path)
        if entry is None:
            skipped += 1
            continue
        if not _is_interactive(entry) or not alive(entry["pid"], entry.get("procStart")):
            continue
        try:
            sessions.append(_printable(index_session(config_dir, entry)))
        except Exception as failure:  # noqa: BLE001 - one session must not hide the others
            skipped += 1
            print(f"Session {_printable(entry['sessionId'])} skipped: {failure!r}", file=sys.stderr)
    sessions.sort(key=lambda session: session["pid"])
    return {"sessions": sessions, "skipped": skipped}


def main(argv):
    if len(argv) != 2:
        print("usage: index_live.py <Claude Code configuration directory>", file=sys.stderr)
        return 2
    config_dir = argv[1]
    registry = os.path.join(config_dir, "sessions")
    if not os.path.isdir(registry):
        print(f"No session registry: {registry}", file=sys.stderr)
        return 2
    sys.stdout.reconfigure(encoding="utf-8")
    json.dump(build(config_dir), sys.stdout, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
