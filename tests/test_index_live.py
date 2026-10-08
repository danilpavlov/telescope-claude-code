"""Tests of the live sessions indexer: python3 -m unittest discover -s tests -p 'test_*.py'."""
import json
import os
import subprocess
import sys
import tempfile
import unittest

HOOKS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "hooks")
SCRIPT = os.path.join(HOOKS, "index_live.py")
sys.path.insert(0, HOOKS)

import index_live  # noqa: E402


def entry(pid, session_id, **fields):
    """A registry entry as Claude Code keeps it."""
    return {
        "pid": pid,
        "sessionId": session_id,
        "cwd": "/work/app",
        "kind": "interactive",
        "status": "idle",
        "statusUpdatedAt": 1_000,
        "startedAt": 500,
        "procStart": "100",
        "tmux": "main:@1.%1",
        **fields,
    }


def user(text, uuid=None, **extra):
    return {"type": "user", "uuid": uuid, "message": {"role": "user", "content": text}, **extra}


def assistant(content="ok", uuid=None, **extra):
    return {"type": "assistant", "uuid": uuid, "message": {"role": "assistant", "content": content}, **extra}


def text(value):
    return {"type": "text", "text": value}


def tool_use(use_id, name, **tool_input):
    return {"type": "tool_use", "id": use_id, "name": name, "input": tool_input}


def tool_result(use_id, output="tool output", uuid=None):
    block = {"type": "tool_result", "tool_use_id": use_id, "content": output}
    return {"type": "user", "uuid": uuid, "message": {"role": "user", "content": [block]}}


def title(value):
    return {"type": "ai-title", "aiTitle": value, "sessionId": "s"}


def last_prompt(value):
    return {"type": "last-prompt", "lastPrompt": value, "sessionId": "s"}


def everyone_alive(pid, proc_start):
    return True


class LiveIndexTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.addCleanup(self._tmp.cleanup)
        os.makedirs(os.path.join(self.root, "sessions"))
        os.makedirs(os.path.join(self.root, "projects"))

    def register(self, record, name=None):
        """Writes a registry file: a dict, or bytes ready-made."""
        pid = record["pid"] if isinstance(record, dict) else "broken"
        path = os.path.join(self.root, "sessions", name or f"{pid}.json")
        with open(path, "wb") as handle:
            handle.write(record if isinstance(record, bytes) else json.dumps(record, ensure_ascii=False).encode())
        return path

    def transcript(self, session_id, records, project="-work-app", mtime=None):
        """Writes a transcript: the records are dicts, or lines of bytes ready-made."""
        folder = os.path.join(self.root, "projects", project)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, f"{session_id}.jsonl")
        with open(path, "wb") as handle:
            for record in records:
                line = record if isinstance(record, bytes) else json.dumps(record, ensure_ascii=False).encode()
                handle.write(line + b"\n")
        if mtime is not None:
            os.utime(path, (mtime, mtime))
        return path

    def live(self, alive=everyone_alive):
        return index_live.build(self.root, alive)

    def only(self, alive=everyone_alive):
        index = self.live(alive)
        self.assertEqual(len(index["sessions"]), 1, index)
        return index["sessions"][0]

    def session(self, records, **fields):
        """One session with this transcript."""
        self.register(entry(7, "s1", **fields))
        self.transcript("s1", records)
        return self.only()

    def test_idle_and_busy_sessions_are_listed_with_their_fields(self):
        self.register(entry(7, "s1"))
        self.register(entry(9, "s2", status="busy", statusUpdatedAt=2_000, cwd="/work/api", tmux="api:@4.%12"))
        self.transcript("s1", [user("fix the tests", "u1"), assistant("Fixed it.", "a1"), title("Fixing the tests")])
        self.transcript("s2", [user("build the image", "u2"), assistant("Building.", "a2")], project="-work-api")
        index = self.live()
        self.assertEqual(index["skipped"], 0)
        first, second = index["sessions"]
        self.assertEqual(
            {key: first[key] for key in first if key != "digest"},
            {
                "id": "s1",
                "pid": 7,
                "title": "Fixing the tests",
                "cwd": "/work/app",
                "status": "idle",
                "statusSinceMs": 1_000,
                "lastPrompt": "fix the tests",
                "lastReply": "Fixed it.",
                "activity": None,
                "tmuxPane": "%1",
                "tmuxTarget": "main:@1.%1",
                "stamp": "a1",
            },
        )
        self.assertEqual(second["id"], "s2")
        self.assertEqual(second["status"], "busy")
        self.assertEqual(second["statusSinceMs"], 2_000)
        self.assertEqual(second["cwd"], "/work/api")
        self.assertEqual(second["tmuxPane"], "%12")

    def test_sessions_are_ordered_by_pid(self):
        for pid in (30, 4, 12):
            self.register(entry(pid, f"s{pid}"))
        self.assertEqual([session["pid"] for session in self.live()["sessions"]], [4, 12, 30])

    def test_dead_process_is_left_out_without_counting(self):
        self.register(entry(7, "s1"))
        self.register(entry(9, "s2", procStart="200"))
        asked = []

        def alive(pid, proc_start):
            asked.append((pid, proc_start))
            return pid == 9

        index = self.live(alive)
        self.assertEqual([session["id"] for session in index["sessions"]], ["s2"])
        self.assertEqual(index["skipped"], 0)
        self.assertEqual(sorted(asked), [(7, "100"), (9, "200")])

    @unittest.skipUnless(os.path.isdir("/proc/self"), "needs /proc")
    def test_is_alive_checks_the_pid_and_when_it_started(self):
        with open("/proc/self/stat", "rb") as handle:
            started = handle.read().decode().rsplit(")", 1)[1].split()[19]
        me = os.getpid()
        self.assertTrue(index_live.is_alive(me, started))
        self.assertTrue(index_live.is_alive(me, None))
        # The same pid, but started at another moment: the pid went to another process
        self.assertFalse(index_live.is_alive(me, "1"))
        self.assertFalse(index_live.is_alive(2**22 + 1, started))

    def test_only_interactive_sessions_are_listed(self):
        self.register(entry(7, "s1", kind="headless"))
        self.register(entry(8, "s2", kind=None))
        self.register(entry(9, "s3"))
        index = self.live()
        self.assertEqual([session["id"] for session in index["sessions"]], ["s3"])
        self.assertEqual(index["skipped"], 0)

    def test_headless_runs_are_not_listed(self):
        # `claude -p` and the SDK write the same kind as a session with a person: the entrypoint gives them away
        self.register(entry(7, "s1", entrypoint="sdk-cli"))
        self.register(entry(8, "s2", entrypoint="sdk-ts"))
        self.register(entry(9, "s3", entrypoint="cli"))
        self.register(entry(10, "s4"))
        index = self.live()
        self.assertEqual([session["id"] for session in index["sessions"]], ["s3", "s4"])
        self.assertEqual(index["skipped"], 0)

    def test_broken_registry_files_are_counted_as_skipped(self):
        self.register(b"{not json", name="1.json")
        self.register(b"[1, 2]", name="2.json")
        self.register(b"\xff\xfe", name="3.json")
        self.register({"pid": "7", "sessionId": "s"}, name="4.json")
        self.register({"pid": 7}, name="5.json")
        self.register(entry(9, "s9"))
        index = self.live()
        self.assertEqual([session["id"] for session in index["sessions"]], ["s9"])
        self.assertEqual(index["skipped"], 5)

    def test_files_that_are_not_json_by_name_are_not_read(self):
        self.register(b"secret", name="9.key")
        self.register(entry(9, "s9"))
        index = self.live()
        self.assertEqual(len(index["sessions"]), 1)
        self.assertEqual(index["skipped"], 0)

    def test_session_without_a_transcript_is_new(self):
        self.register(entry(7, "s1"))
        session = self.only()
        self.assertEqual(session["title"], "New session")
        self.assertIsNone(session["lastPrompt"])
        self.assertIsNone(session["lastReply"])
        self.assertIsNone(session["activity"])
        self.assertIsNone(session["stamp"])
        self.assertIsNone(session["digest"])

    def test_registry_entry_without_status_waits_since_it_started(self):
        record = entry(7, "s1")
        del record["status"]
        del record["statusUpdatedAt"]
        del record["cwd"]
        self.register(record)
        session = self.only()
        self.assertEqual(session["status"], "idle")
        self.assertEqual(session["statusSinceMs"], 500)
        self.assertEqual(session["cwd"], "")

    def test_unknown_status_is_passed_as_it_is(self):
        self.register(entry(7, "s1", status="blocked"))
        self.assertEqual(self.only()["status"], "blocked")

    def test_last_ai_title_wins(self):
        session = self.session([user("hello", "u1"), title("First"), assistant("ok", "a1"), title("Second")])
        self.assertEqual(session["title"], "Second")

    def test_title_falls_back_to_the_last_prompt_cut_to_60(self):
        session = self.session([user("the first prompt", "u1"), assistant("ok", "a1"), user("b" * 100, "u2")])
        self.assertEqual(session["title"], "b" * 60)

    def test_service_user_records_are_not_prompts(self):
        session = self.session(
            [
                user("a real prompt", "u1"),
                assistant("ok", "a1"),
                user("a service one", "u2", isMeta=True),
                user("a subagent", "u3", isSidechain=True),
                user("This session is being continued", "u4", isCompactSummary=True),
                user("for display only", "u5", isVisibleInTranscriptOnly=True),
                user("<task-notification><task-id>t1</task-id></task-notification>", "u6"),
                user("<command-name>/config</command-name>", "u7"),
                tool_result("t1", uuid="u8"),
            ]
        )
        self.assertEqual(session["lastPrompt"], "a real prompt")

    def test_an_interruption_is_not_a_prompt(self):
        session = self.session(
            [
                user("a real prompt", "u1"),
                assistant("Started.", "a1"),
                user("[Request interrupted by user]", "u2"),
                user([text("[Request interrupted by user for tool use]")], "u3"),
            ]
        )
        self.assertEqual(session["lastPrompt"], "a real prompt")
        self.assertNotIn("Request interrupted", session["digest"])

    def test_noted_prompt_that_is_an_interruption_is_not_shown(self):
        session = self.session([assistant("Going on.", "a1"), last_prompt("[Request interrupted by user]")])
        self.assertIsNone(session["lastPrompt"])

    def test_half_an_emoji_does_not_break_the_output(self):
        # How Node writes a string cut in the middle of an emoji: half of a surrogate pair
        half = b'{"type":"user","uuid":"u1","message":{"role":"user","content":"half \\ud83d emoji"}}'
        # json.dumps without ensure_ascii=False writes the half as \ud83d, which is how it lies in the files
        self.register(json.dumps(entry(os.getpid(), "s1", procStart=None, cwd="/work/\ud83d")).encode(), name="1.json")
        running = json.dumps(assistant([tool_use("t1", "Tool\ud83d", file_path="/a/\ud83d.py")], "a1")).encode()
        self.transcript("s1", [half, running])
        ran = subprocess.run([sys.executable, SCRIPT, self.root], capture_output=True, check=False)
        self.assertEqual(ran.returncode, 0, ran.stderr.decode("utf-8", "replace"))
        session = json.loads(ran.stdout.decode("utf-8"))["sessions"][0]
        self.assertEqual(session["lastPrompt"], "half � emoji")
        self.assertEqual(session["cwd"], "/work/�")
        self.assertEqual(session["activity"], "Tool�")
        self.assertIn("Tool� ×1 (�.py)", session["digest"])

    def test_a_session_that_cannot_be_indexed_does_not_hide_the_others(self):
        self.register(entry(7, "s1"))
        self.register(entry(9, "s2"))
        self.transcript("s1", [user("the broken one", "u1")])
        self.transcript("s2", [user("the whole one", "u2")])
        whole = index_live.walk

        def walk(records):
            if any(record.get("uuid") == "u1" for record in records):
                raise RuntimeError("the format changed")
            return whole(records)

        index_live.walk = walk
        self.addCleanup(setattr, index_live, "walk", whole)
        index = self.live()
        self.assertEqual([session["id"] for session in index["sessions"]], ["s2"])
        self.assertEqual(index["skipped"], 1)

    def test_prompt_in_blocks_is_read_too(self):
        session = self.session([user([text("the first part"), text("the second part")], "u1")])
        self.assertEqual(session["lastPrompt"], "the first part the second part")

    def test_prompt_and_reply_are_one_line_and_cut(self):
        session = self.session([user("a\n\tb   c " + "d" * 300, "u1"), assistant("e\n\nf " + "g" * 400, "a1")])
        self.assertEqual(session["lastPrompt"], ("a b c " + "d" * 300)[:200])
        self.assertEqual(session["lastReply"], ("e f " + "g" * 400)[:300])

    def test_prompt_outside_the_tail_comes_from_the_last_prompt_record(self):
        session = self.session([assistant("Going on.", "a1"), last_prompt("fix all of the list")])
        self.assertEqual(session["lastPrompt"], "fix all of the list")
        self.assertEqual(session["title"], "fix all of the list")
        self.assertIn("Prompts from the person, oldest first:\n- fix all of the list\n", session["digest"])

    def test_noted_prompt_that_is_a_service_text_is_not_shown(self):
        session = self.session([assistant("Going on.", "a1"), last_prompt("<command-name>/clear</command-name>")])
        self.assertIsNone(session["lastPrompt"])
        self.assertEqual(session["title"], "New session")

    def test_last_reply_is_the_last_text_of_the_main_conversation(self):
        session = self.session(
            [
                user("prompt", "u1"),
                assistant([{"type": "thinking", "thinking": "thinking"}, text("The first reply.")], "a1"),
                assistant([text("The second reply."), tool_use("t1", "Bash", command="ls")], "a2"),
                tool_result("t1", uuid="u2"),
                assistant("A reply of a subagent.", "a3", isSidechain=True),
                assistant([tool_use("t2", "Read", file_path="/work/app/a.py")], "a4"),
            ]
        )
        self.assertEqual(session["lastReply"], "The second reply.")

    def test_activity_is_the_tool_still_running(self):
        session = self.session(
            [
                user("prompt", "u1"),
                assistant([tool_use("t1", "Read", file_path="/a.py"), tool_use("t2", "Bash", command="make")], "a1"),
                tool_result("t1", uuid="u2"),
            ]
        )
        self.assertEqual(session["activity"], "Bash")

    def test_no_activity_once_every_tool_answered(self):
        session = self.session(
            [
                user("prompt", "u1"),
                assistant([tool_use("t1", "Bash", command="make")], "a1"),
                tool_result("t1", uuid="u2"),
                assistant("Done.", "a2"),
            ]
        )
        self.assertIsNone(session["activity"])

    def test_stamp_is_the_last_user_or_assistant_record_of_the_main_conversation(self):
        session = self.session(
            [
                user("prompt", "u1"),
                assistant("Done.", "a1"),
                assistant("A subagent.", "a2", isSidechain=True),
                last_prompt("prompt"),
                title("Some title"),
                {"type": "mode", "mode": "normal", "uuid": "m1"},
                {"type": "system", "subtype": "turn_duration", "uuid": "d1"},
            ]
        )
        self.assertEqual(session["stamp"], "a1")

    def test_stamp_ignores_what_does_not_move_the_conversation(self):
        session = self.session(
            [
                user("prompt", "u1"),
                assistant("Done.", "a1"),
                user("<command-name>/config</command-name>", "u2"),
                user("<local-command-stdout>Set model to opus</local-command-stdout>", "u3"),
                user("a system reminder", "u4", isMeta=True),
                user("[Request interrupted by user]", "u5"),
            ]
        )
        self.assertEqual(session["stamp"], "a1")

    def test_session_with_only_slash_commands_has_nothing_to_summarize(self):
        session = self.session(
            [
                user("<command-name>/board</command-name>", "u1"),
                user("<local-command-stdout>Active sessions: 4</local-command-stdout>", "u2"),
            ]
        )
        self.assertEqual(session["title"], "New session")
        self.assertIsNone(session["stamp"])
        self.assertIsNone(session["digest"])

    def test_stamp_moves_with_a_tool_result(self):
        session = self.session(
            [user("prompt", "u1"), assistant([tool_use("t1", "Bash", command="ls")], "a1"), tool_result("t1", uuid="u2")]
        )
        self.assertEqual(session["stamp"], "u2")

    def test_digest_holds_the_last_prompts_replies_and_tools_and_no_tool_output(self):
        session = self.session(
            [
                user("the oldest prompt", "u0"),
                assistant("The oldest reply.", "a0"),
                user("prompt one", "u1"),
                assistant("Reply one.", "a1"),
                user("prompt two", "u2"),
                assistant([text("Reply two."), tool_use("t0", "Grep", pattern="x")], "a2"),
                tool_result("t0", "a match from the last turn", uuid="u3"),
                user("prompt three", "u4"),
                assistant(
                    [
                        text("Reply three."),
                        tool_use("t1", "Edit", file_path="/work/app/src/a.py"),
                        tool_use("t2", "Edit", file_path="/work/app/src/b.py"),
                        tool_use("t3", "Edit", file_path="/work/app/src/a.py"),
                        tool_use("t4", "Bash", command="make test"),
                    ],
                    "a3",
                ),
                tool_result("t1", "secret tool output", uuid="u5"),
                title("Fixing the tests"),
            ],
            status="busy",
        )
        self.assertEqual(
            session["digest"],
            "\n".join(
                [
                    "Title: Fixing the tests",
                    "State: working",
                    "Prompts from the person, oldest first:",
                    "- prompt one",
                    "- prompt two",
                    "- prompt three",
                    "Replies from the agent, oldest first:",
                    "- Reply one.",
                    "- Reply two.",
                    "- Reply three.",
                    "Tools of the current turn: Edit ×3 (a.py, b.py), Bash ×1",
                ]
            ),
        )

    def test_digest_of_a_waiting_session_says_so_and_skips_empty_parts(self):
        session = self.session([user("prompt", "u1")])
        self.assertEqual(
            session["digest"],
            "Title: prompt\nState: stopped, waiting for the person\nPrompts from the person, oldest first:\n- prompt",
        )

    def test_digest_names_at_most_eight_files(self):
        uses = [tool_use(f"t{n}", "Read", file_path=f"/work/f{n}.py") for n in range(12)]
        session = self.session([user("prompt", "u1"), assistant(uses, "a1")])
        self.assertIn("Read ×12 (f0.py, f1.py, f2.py, f3.py, f4.py, f5.py, f6.py, f7.py)", session["digest"])
        self.assertNotIn("f8.py", session["digest"])

    def test_digest_is_cut_from_the_oldest_replies(self):
        session = self.session(
            [
                user("a" * 900, "u1"),
                assistant("OLDEST " + "b" * 2000, "a1"),
                user("c" * 900, "u2"),
                assistant("MIDDLE " + "d" * 2000, "a2"),
                user("e" * 900, "u3"),
                assistant("FRESH " + "f" * 2000, "a3"),
            ]
        )
        digest = session["digest"]
        self.assertLessEqual(len(digest), index_live.DIGEST_CHARS)
        self.assertNotIn("OLDEST", digest)
        self.assertIn("MIDDLE", digest)
        self.assertIn("FRESH", digest)
        # A prompt is cut to 500 characters, a reply to 1500
        self.assertIn("- " + "a" * 500 + "\n", digest)
        self.assertIn("- FRESH " + "f" * 1494, digest)
        self.assertNotIn("f" * 1495, digest)

    def test_tmux_pane_is_read_from_the_registry(self):
        self.register(entry(7, "s1", tmux="HOME:@5.%5"))
        session = self.only()
        self.assertEqual(session["tmuxPane"], "%5")
        self.assertEqual(session["tmuxTarget"], "HOME:@5.%5")

    def test_session_outside_tmux_has_no_pane(self):
        record = entry(7, "s1")
        del record["tmux"]
        self.register(record)
        session = self.only()
        self.assertIsNone(session["tmuxPane"])
        self.assertIsNone(session["tmuxTarget"])

    def test_tmux_field_without_a_pane_id_gives_no_pane(self):
        self.register(entry(7, "s1", tmux="main:1.0"))
        session = self.only()
        self.assertIsNone(session["tmuxPane"])
        self.assertEqual(session["tmuxTarget"], "main:1.0")

    def test_only_the_tail_is_read_and_its_cut_first_line_is_dropped(self):
        padding = assistant("x" * index_live.TAIL_BYTES, "big")
        session = self.session(
            [user("a prompt from the head", "u0"), padding, user("a prompt from the tail", "u1"), assistant("Done.", "a1")]
        )
        self.assertEqual(session["lastPrompt"], "a prompt from the tail")
        self.assertEqual(session["lastReply"], "Done.")
        self.assertNotIn("a prompt from the head", session["digest"])

    def test_broken_lines_are_skipped(self):
        session = self.session([b"\xff\xfe not utf-8", b"{broken", b"[1, 2]", b'"text"', user("prompt", "u1")])
        self.assertEqual(session["lastPrompt"], "prompt")

    def test_newest_transcript_wins_when_two_projects_hold_the_session(self):
        self.register(entry(7, "s1"))
        self.transcript("s1", [user("the old one", "u1")], project="-work-old", mtime=1_000_000)
        self.transcript("s1", [user("the new one", "u2")], project="-work-new", mtime=2_000_000)
        self.assertEqual(self.only()["lastPrompt"], "the new one")

    def test_transcripts_of_subagents_are_not_read(self):
        self.register(entry(7, "s1"))
        folder = os.path.join(self.root, "projects", "-work-app", "s1", "subagents")
        os.makedirs(folder)
        with open(os.path.join(folder, "s1.jsonl"), "wb") as handle:
            handle.write(json.dumps(user("a subagent's prompt", "u1"), ensure_ascii=False).encode() + b"\n")
        self.assertIsNone(self.only()["lastPrompt"])

    def test_cli_prints_utf8_json(self):
        self.register(entry(os.getpid(), "s1", procStart=None))
        self.transcript("s1", [user("hello", "u1"), title("Some title")])
        ran = subprocess.run([sys.executable, SCRIPT, self.root], capture_output=True, check=False)
        self.assertEqual(ran.returncode, 0, ran.stderr)
        index = json.loads(ran.stdout.decode("utf-8"))
        self.assertEqual(index["sessions"][0]["title"], "Some title")
        self.assertEqual(index["skipped"], 0)

    def test_cli_fails_with_code_2_without_the_registry(self):
        ran = subprocess.run([sys.executable, SCRIPT, os.path.join(self.root, "missing")], capture_output=True, check=False)
        self.assertEqual(ran.returncode, 2)
        self.assertIn("No session registry", ran.stderr.decode("utf-8"))
        self.assertEqual(ran.stdout, b"")

    def test_cli_wants_one_argument(self):
        ran = subprocess.run([sys.executable, SCRIPT], capture_output=True, check=False)
        self.assertEqual(ran.returncode, 2)
        self.assertIn("usage", ran.stderr.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
