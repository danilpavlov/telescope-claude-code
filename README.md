# session-board

A mod for [Claude Code](https://claude.com/claude-code): a floating window with the sessions that are
running right now - who works, who waits for you, what each has done - and a jump to the tmux window
of the one you pick.

For people who run Claude Code in many tmux windows at once and lose track of which agent has
finished and is waiting.

```
╭───────────── Active sessions ──────────────╮╭────────────────── Publish the session board ───────────────────╮
│ > search · enter: go · alt+digit: by numbe ││ ◐ working 8 min                                                │
╰────────────────────────────────────────────╯│ ~/github/claude-session-board                                  │
╭────────────────────────────────────────────╮│ tmux mods:@1.%2                                                │
│   ● 1  Fix the flaky checkout te…   3 min  ││                                                                │
│ ▌ ◐ 2  Publish the sessio… (this)   8 min  ││ you                                                            │
│   ◐ 3  Move billing to Postgres …  42 min  ││ make a repository so that other people can use this mod        │
│   ○ 4  Draft the release notes        2 h  ││                                                                │
│   ○ 5  New session                    6 h  ││ summary                                                        │
│                                            ││ Translating the mod to English and writing the README before   │
│                                            ││ the repository goes public.                                    │
│                                            ││                                                                │
│                                            ││ now                                                            │
│                                            ││ Edit                                                           │
│                                            ││                                                                │
│                                            ││ agent                                                          │
╰────────────────────────────────────────────╯╰────────────────────────────────────────────────────────────────╯
```

## What it shows

Every live interactive session from Claude Code's own registry (`~/.claude/sessions`), including
the ones started before the mod was installed. `claude -p` and SDK runs are left out.

| Mark | Meaning |
|---|---|
| `●` | the agent stopped and waits for you, for no longer than the threshold |
| `◐` | the agent is working; such a session never goes dim, however long it works |
| `○` | no answer for longer than the threshold (10 minutes): the session went stale, its row is dim |

- A row: the mark, a number, the title, the project folder, how long the session has been in that state.
- The preview: the state, the folder, the tmux address, your last prompt (`you`), a summary written
  by a model (`summary`), the tool that is running (`now`) and the agent's last reply (`agent`).
  A part with nothing to show is left out.
- `(this)` marks the session the window was opened from.
- The colors follow your custom Claude Code theme, if you use one.

## Install

In a Claude Code session:

```
/plugin install session-board --marketplace danilpavlov/claude-session-board
```

Answer `y` to add the marketplace, then pick a scope (the user scope makes the mod load in every
session). Sessions that were already running pick it up after `/reload-plugins`.

You need:

- a Claude Code build with mods (function hooks). The mod was written against 2.1.294; that API is
  early access and may change between releases;
- `python3` in `PATH`;
- tmux 3.3 or newer and [`fzf`](https://github.com/junegunn/fzf) for the floating window (tested with
  fzf 0.74). Without them the board opens as a pane inside Claude Code instead.

Developed and tested on Linux. macOS should work but is untested.

## Open it

- Two spaces in a row on an empty prompt, the way `<space><space>` opens a picker in Neovim. The
  prompt stays empty; in a prompt that holds text, spaces are typed as usual.
- `/board`.

The window rereads the sessions every 5 seconds while it is open.

## Keys in the window

| Key | What happens |
|---|---|
| letters and digits | typed into the search; the search is fuzzy, over the title and the project folder |
| `↑` `↓` | move the selection without leaving the search; the preview follows |
| `Enter` | go to the selected session |
| `alt+1` ... `alt+9` | go to the session under that number |
| `Esc` | close the window and go nowhere |

Order: the waiting sessions first, then the working ones, then the stale ones; within a group the
one whose state changed last is on top. While the window is open the order and the numbers stay
put, even when a session changes state or the search narrows the list: a number never takes you to
another session. The number of a session that ended stays unused, a new session goes last. The
next opening orders everything anew.

Going to a session is `tmux switch-client -t %<pane>`: it changes the tmux session, the window and
the pane at once. The session you are in, and a session that runs outside tmux, are not gone to:
tmux says why in its status line.

## Summaries

One or two sentences about what the agent has done and what it waits for, written by `haiku`.

| Session | When it is asked about |
|---|---|
| waiting | once per stop |
| working | at once, then no sooner than every 3 minutes and only if the transcript moved |
| stale | never |

- The model is asked only while the board is open, about three sessions at a time at most.
- **What is sent:** a digest of up to 6,000 characters - the last three prompts, the last three
  replies of the agent, and the names of the tools and files of the current turn. Tool output is
  never included.
- **Who pays:** the session the board was opened from. The prompts and replies of your other
  sessions go to the model on its behalf, the same way their own requests do.
- Summaries are cached, so opening the board again costs nothing until a session moves on.
- If the model does not answer, the preview simply has no `summary` part; the next try is no
  sooner than 3 minutes later and only once the transcript has moved.

## The fallback pane

The floating window is drawn by tmux and fzf. When Claude Code runs outside tmux, or fzf is missing
or too old, the mod opens the same list as a Claude Code pane: two frames docked beside the
conversation, or a block above the prompt.

| Focus | Key | What happens |
|---|---|---|
| search field | letters and digits | typed into the search, the list narrows |
| search field | `Enter` | go to the selected session, the first of the list |
| search field | `↓` or `Tab` | the focus moves into the list |
| a row | `↑` `↓` | the selection moves, the preview follows |
| a row | `Enter` or a digit `1`-`9` | go |
| anywhere | `Esc` | close the pane and go nowhere |

## Setting

`staleMinutes`: after how many minutes of waiting a session goes dim. 10 by default. Change it in
`/config`, in the mod's row.

## What it reads and writes

The mod writes nothing into Claude Code's own files. It reads:

- `~/.claude/sessions/<pid>.json`: the registry of live processes - session id, folder, status,
  tmux address;
- the last megabyte of each live session's transcript in `~/.claude/projects/`: the title, your
  prompts, the agent's replies, its tool calls.

It keeps two things of its own: the cache of summaries in the mod's store, and a copy of them for
the floating window in `$XDG_RUNTIME_DIR/session-board/summaries.json` (or
`~/.cache/session-board/summaries.json`).

## Limitations

- The registry and the transcript format are undocumented and may change. All the reading is in
  `hooks/index_live.py`: if Claude Code changes them, that is the one file to fix.
- A transcript is read from its end, a megabyte at most. A prompt asked earlier than that is taken
  from a separate note Claude Code keeps; earlier ones do not reach the digest.
- The summary of a working session lags by up to three minutes, and a new one reaches the window's
  preview up to 5 seconds later.
- A session in another tmux server (another socket) cannot be gone to.
- In the window the search looks at the title and the project folder; the pane also looks at the
  last prompt.
- Two spaces pasted into an empty prompt open the board too.
- The interface and the summaries are in English.

## Development

```bash
python3 -m unittest discover -s tests -p 'test_*.py'   # the indexer and the floating window
claude plugin validate .
claude plugin test .                                     # the pure functions and the pane
npx -y -p typescript@5 tsc -p .
```

`tsconfig.json` extends the type declarations Claude Code lays into `.claude-plugin/types/` when it
loads the mod, so run the mod once before the type check: `claude --plugin-dir .`.

No test starts fzf or tmux: the launchers are replaced, and the real ones are disarmed in the test
module.

| File | What it does |
|---|---|
| `hooks/index_live.py` | reads the registry and the transcripts, prints the live sessions as JSON |
| `hooks/board_popup.py` | the floating window: the tmux popup, fzf, its list and its preview |
| `hooks/board.ts` | pure functions: states, order, layout, the summary policy |
| `hooks/register.tsx` | the hooks module: the command, the leader, the pane, the timer, the summaries |
| `types/index.d.ts` | the state contract |

## License

[MIT](LICENSE)
