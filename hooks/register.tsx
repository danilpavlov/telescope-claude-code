import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import {
  PANE_COLUMNS,
  PREVIEW_PADDING,
  ageCell,
  cleanSummary,
  clip,
  filterLive,
  frameRows,
  hotkeyOf,
  isHeldBack,
  isLeader,
  isSummary,
  layoutOf,
  markOf,
  mergeOrder,
  needsSummary,
  orderOf,
  paneRows,
  parseLive,
  phaseOf,
  popupArgv,
  previewOf,
  previewWidth,
  rowKey,
  selectedOf,
  staleMinutesOf,
  staleMsOf,
  summariesFileOf,
  switchArgv,
  titleCell,
  titleLabel,
} from './board'
import type { Failure, PreviewLine } from './board'
import type { Indexed, LiveIndex, LiveSession, Phase, Summary } from '../types'

const COMMAND = 'board'
const PANE = 'board'
const TITLE = 'Active sessions'
// The indexer reads the registry and a megabyte of each live transcript
const INDEXER_TIMEOUT_MS = 10_000
// How often the list is collected again while the board is open
const REFRESH_MS = 5_000
// How long after the leader the board opens: the emptied prompt has to land first, since a pane
// that asks for the keyboard over a draft is refused it
const LEADER_DELAY_MS = 30
const SUMMARY_MODEL = 'haiku'
const SUMMARY_MAX_TOKENS = 200
const SUMMARY_TIMEOUT_MS = 20_000
// Summaries asked of the model at once; the rest wait for the next tick
const SUMMARY_PARALLEL = 3
const SUMMARY_SYSTEM =
  'You write one line for a status board of coding-agent sessions. From the digest, answer in one or two ' +
  'sentences of English, at most 200 characters: what has been done, and what is happening now or what ' +
  'the person is waited on for. No preamble, no lists, no quotes.'
// The mod's keys in $.store: one summary a session
const STORE_PREFIX = 'summary:'
const UNREADABLE = 'The indexer printed something unreadable'
const NO_HOME = 'HOME is not set: cannot tell where the session registry is'
// The search field's key, and what the focus ring names when it stands on it
const SEARCH = 'query'
// Theme keys, so the colors follow the person's theme. The pane is drawn as a picker: two
// rounded frames with their titles on them, a selection bar, a preview beside the list
const PHASE_COLOR: Record<Phase, string> = { waiting: 'claude', working: 'success', stale: 'inactive' }
const FRAME_COLOR = 'promptBorder'
const ACCENT_COLOR = 'claude'
const SELECTION_COLOR = 'selectionBg'
const QUIET_COLOR = 'subtle'
const AGE_COLOR = 'inactive'
// The preview's lines by kind; a state line takes its session's phase color instead
const LINE_COLOR: Record<PreviewLine['kind'], string | undefined> = {
  state: undefined,
  directory: 'suggestion',
  meta: QUIET_COLOR,
  label: QUIET_COLOR,
  text: undefined,
  note: QUIET_COLOR,
  gap: undefined,
}
// Cells from a frame's corner to its title, and what the title leaves of the frame's width:
// the corners, a dash each side, a space each side
const FRAME_TITLE_LEFT = 2
const FRAME_TITLE_CHROME = 6
// The preview's title while no session is selected
const NO_SESSION = 'Session'

const sessions = atom({ plugin: 'session-board', key: 'sessions' } as const, [])
const order = atom({ plugin: 'session-board', key: 'order' } as const, [])
const summaries = atom({ plugin: 'session-board', key: 'summaries' } as const, {})
const skipped = atom({ plugin: 'session-board', key: 'skipped' } as const, 0)
const error = atom({ plugin: 'session-board', key: 'error' } as const, null)
const currentId = atom({ plugin: 'session-board', key: 'currentId' } as const, '')
const home = atom({ plugin: 'session-board', key: 'home' } as const, '')
const nowMs = atom({ plugin: 'session-board', key: 'nowMs' } as const, 0)
const query = atom({ plugin: 'session-board', key: 'query' } as const, '')
const focused = atom({ plugin: 'session-board', key: 'focused' } as const, '')

// What no drawing reads, so a reload may lose it: the refresh timer, the collection under way,
// whether the floating window is up, the sessions whose summary is being asked, and the
// summaries that were not got
let timer: Timer | undefined
let isCollecting = false
let isPopupOpen = false
const asking = new Set<string>()
const failures = new Map<string, Failure>()

const firstLine = (text: string): string => text.trim().split('\n')[0] ?? ''

const reasonOf = (failure: unknown): string =>
  failure instanceof Error ? failure.message : String(failure)

const withoutDigest = ({ digest, ...session }: Indexed): LiveSession => session

// Claude Code's configuration folder, or '' where nothing says where it is
const configDirOf = async ($: EngineInterface, homeDir: string): Promise<string> =>
  (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (homeDir === '' ? '' : `${homeDir}/.claude`)

// Runs the mod's indexer over the configuration folder: the live sessions, or why there are none
const loadLive = async ($: EngineInterface, homeDir: string): Promise<LiveIndex | string> => {
  const configDir = await configDirOf($, homeDir)

  if (configDir === '') {
    return NO_HOME
  }

  const ran = await $.process
    .run(['python3', `${$.plugin.root}/hooks/index_live.py`, configDir], { timeoutMs: INDEXER_TIMEOUT_MS })
    .catch((failure: unknown) => reasonOf(failure))

  if (typeof ran === 'string') {
    return `Could not start python3: ${ran}`
  }

  if (ran.exitCode !== 0) {
    return firstLine(ran.stderr) || `The indexer exited with code ${ran.exitCode}`
  }

  if (ran.isStdoutTruncated) {
    return UNREADABLE
  }

  try {
    return parseLive(ran.stdout)
  } catch {
    return UNREADABLE
  }
}

// The summaries kept for the live sessions. The keys of sessions that are gone are dropped
const loadSummaries = async (
  $: EngineInterface,
  live: readonly LiveSession[],
): Promise<Record<string, Summary>> => {
  const ids = new Set(live.map(session => session.id))
  const kept: Record<string, Summary> = {}

  for (const key of await $.store.keys()) {
    if (!key.startsWith(STORE_PREFIX)) {
      continue
    }

    const id = key.slice(STORE_PREFIX.length)

    if (!ids.has(id)) {
      await $.store.delete(key)
      continue
    }

    const value = await $.store.get(key)

    if (isSummary(value)) {
      kept[id] = value
    }
  }

  return kept
}

// Leaves the summaries where the floating window reads them. The window is another program:
// it cannot ask the mod, so the mod writes them out, whole, each time one changes
const handSummaries = async ($: EngineInterface): Promise<string> => {
  const file = summariesFileOf((await $.env.get('XDG_RUNTIME_DIR')) ?? '', (await $.env.get('HOME')) ?? '')

  await $.fs
    .write(file, JSON.stringify(await read($, summaries)))
    .catch((failure: unknown) => $.ui.log(`session-board: summaries not written: ${reasonOf(failure)}`, { to: 'debug' }))

  return file
}

// Asks the model about one session and keeps what it said; a failure is noted and said to the debug log
const askSummary = async ($: EngineInterface, session: Indexed): Promise<void> => {
  const { id, stamp, digest } = session

  if (stamp === null || digest === null) {
    return
  }

  const answer = await $.model
    .complete({
      model: SUMMARY_MODEL,
      system: SUMMARY_SYSTEM,
      prompt: digest,
      maxTokens: SUMMARY_MAX_TOKENS,
      timeoutMs: SUMMARY_TIMEOUT_MS,
    })
    .catch((failure: unknown) => reasonOf(failure))
  const atMs = await $.clock.now()
  const text = typeof answer !== 'string' && answer.isAnswered ? cleanSummary(answer.text) : ''

  if (text === '') {
    const reason = typeof answer === 'string' ? answer : answer.isAnswered ? 'empty-reply' : answer.reason
    failures.set(id, { stamp, atMs })
    $.ui.log(`session-board: no summary for session ${id}: ${reason}`, { to: 'debug' })

    return
  }

  const summary: Summary = { stamp, text, atMs }
  failures.delete(id)
  await $.store.set(`${STORE_PREFIX}${id}`, summary)
  await update($, summaries, all => ({ ...all, [id]: summary }))

  if (isPopupOpen) {
    await handSummaries($)
  }
}

// Starts the summaries that are due, SUMMARY_PARALLEL at once; it does not wait for them
const askSummaries = async (
  $: EngineInterface,
  live: readonly Indexed[],
  now: number,
  staleMs: number,
): Promise<void> => {
  const kept = await read($, summaries)

  for (const session of live) {
    if (asking.size >= SUMMARY_PARALLEL) {
      return
    }

    if (
      asking.has(session.id) ||
      session.stamp === null ||
      !needsSummary(session, phaseOf(session, now, staleMs), kept[session.id], now) ||
      isHeldBack(failures.get(session.id), session.stamp, now)
    ) {
      continue
    }

    asking.add(session.id)
    void askSummary($, session).finally(() => asking.delete(session.id))
  }
}

const stopTimer = (): void => {
  timer?.cancel()
  timer = undefined
}

const isPaneOpen = async ($: EngineInterface): Promise<boolean> =>
  (await $.ui.panes()).some(pane => pane.id === PANE)

// One refresh: the list again, the pinned order with the new sessions, the summaries that are due.
// It runs for as long as the board is up in either form, the floating window or the pane
const tick = async ($: EngineInterface, staleMs: number): Promise<void> => {
  if (!isPopupOpen && !(await isPaneOpen($))) {
    stopTimer()

    return
  }

  if (isCollecting) {
    return
  }

  isCollecting = true

  try {
    const homeDir = (await $.env.get('HOME')) ?? ''
    const loaded = await loadLive($, homeDir)

    if (typeof loaded === 'string') {
      $.ui.log(`session-board: list not refreshed: ${loaded}`, { to: 'debug' })

      return
    }

    const now = await $.clock.now()
    await update($, sessions, () => loaded.sessions.map(withoutDigest))
    await update($, order, pinned => mergeOrder(pinned, loaded.sessions))
    await update($, skipped, () => loaded.skipped)
    await update($, home, () => homeDir)
    await update($, nowMs, () => now)
    await askSummaries($, loaded.sessions, now, staleMs)
  } finally {
    isCollecting = false
  }
}

const startTimer = ($: EngineInterface, staleMs: number): void => {
  timer ??= $.clock.every(REFRESH_MS, () => {
    void tick($, staleMs)
  })
}

// Brings the person's tmux client to the session's pane, or says in one toast why it did not
const goTo = async ($: EngineInterface, session: LiveSession): Promise<void> => {
  if (session.id === (await read($, currentId))) {
    $.ui.toast('You are already in this session')

    return
  }

  if (session.tmuxPane === null) {
    $.ui.toast('This session is not in tmux: cannot go to it')

    return
  }

  if (((await $.env.get('TMUX')) ?? '') === '') {
    $.ui.toast(`Not in tmux. The session is at ${session.tmuxTarget ?? session.tmuxPane}`)

    return
  }

  const ran = await $.process
    .run(switchArgv(session.tmuxPane))
    .catch((failure: unknown) => reasonOf(failure))

  if (typeof ran === 'string') {
    $.ui.toast(`tmux: ${ran}`)

    return
  }

  if (ran.exitCode !== 0) {
    $.ui.toast(`tmux: ${firstLine(ran.stderr) || `code ${ran.exitCode}`}`)

    return
  }

  stopTimer()
  await $.ui.close({ id: PANE })
}

// The pane: the board inside Claude Code, where the floating window cannot open
const showPane = async ($: EngineInterface, count: number): Promise<void> => {
  await $.ui.open({
    id: PANE,
    title: TITLE,
    focus: true,
    closeOnEscape: true,
    columns: PANE_COLUMNS,
    rows: paneRows(count),
  })
}

// The floating window: a tmux popup with the same list and preview. Resolves once it has closed:
// true when it was up, false when it could not open, the reason said to the debug log
const showPopup = async (
  $: EngineInterface,
  configDir: string,
  current: string,
  staleMinutes: number,
): Promise<boolean> => {
  isPopupOpen = true

  try {
    const file = await handSummaries($)
    const pieces = $.process
      .spawn({ argv: popupArgv($.plugin.root, configDir, file, current, staleMinutes) })
      [Symbol.asyncIterator]()
    let said = ''
    let step = await pieces.next()

    while (!step.done) {
      said += step.value.stream === 'stderr' ? step.value.text : ''
      step = await pieces.next()
    }

    if (step.value.code === 0) {
      return true
    }

    $.ui.log(`session-board: the floating window did not open: ${firstLine(said) || `code ${step.value.code}`}`, {
      to: 'debug',
    })

    return false
  } catch (failure) {
    $.ui.log(`session-board: the floating window did not open: ${reasonOf(failure)}`, { to: 'debug' })

    return false
  } finally {
    isPopupOpen = false
  }
}

// Collects the sessions and shows the board: the floating window inside tmux, else the pane.
// Resolves with how many sessions there are, or with nothing when they could not be collected
const openBoard = async (
  $: EngineInterface,
  staleMs: number,
  staleMinutes: number,
): Promise<number | undefined> => {
  const homeDir = (await $.env.get('HOME')) ?? ''
  const loaded = await loadLive($, homeDir)
  const now = await $.clock.now()
  const id = await $.session.id()
  const isFailed = typeof loaded === 'string'
  const live = isFailed ? [] : loaded.sessions
  const kept = isFailed ? {} : await loadSummaries($, live)

  await update($, sessions, () => live.map(withoutDigest))
  // Every opening pins the order anew
  await update($, order, () => orderOf(live, now, staleMs))
  await update($, summaries, () => kept)
  await update($, skipped, () => (isFailed ? 0 : loaded.skipped))
  await update($, error, () => (isFailed ? loaded : null))
  await update($, currentId, () => id)
  await update($, home, () => homeDir)
  await update($, nowMs, () => now)
  // Every opening starts from the whole list, the selection on its first row
  await update($, query, () => '')
  await update($, focused, () => '')

  // A failure is said once, in the pane
  if (isFailed) {
    stopTimer()
    await showPane($, 0)

    return undefined
  }

  startTimer($, staleMs)
  await askSummaries($, live, now, staleMs)

  if (((await $.env.get('TMUX')) ?? '') === '') {
    await showPane($, live.length)

    return live.length
  }

  // The window stays up for as long as the person looks at it: nothing waits for it here.
  // Once it has closed, the next tick finds nothing to refresh for and stops the timer
  void showPopup($, await configDirOf($, homeDir), id, staleMinutes).then(async wasUp => {
    if (!wasUp) {
      await showPane($, live.length)
    }
  })

  return live.length
}

export const register: Register = (on, options) => {
  const staleMs = staleMsOf(options.staleMinutes)
  const staleMinutes = staleMinutesOf(options.staleMinutes)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show the running sessions and go to the tmux window of the chosen one',
    })
    const started = await next(e)

    // The module was reloaded under an open pane: its timer went with the old copy
    if (await isPaneOpen($)) {
      startTimer($, staleMs)
    }

    return started
  })

  on('command.run', { command: COMMAND }, async $ => {
    const count = await openBoard($, staleMs, staleMinutes)

    return count === undefined ? {} : { text: `Active sessions: ${count}` }
  })

  // The leader: two spaces on an empty prompt open the board, and the prompt stays empty
  on('prompt.edit', async ($, e, next) => {
    if (!isLeader(e.text, e.inputText)) {
      return next(e)
    }

    $.clock.after(LEADER_DELAY_MS, () => {
      void openBoard($, staleMs, staleMinutes)
    })

    return { text: '', cursor: 0 }
  })

  // The preview follows the pane's focus ring: the row it stands on is the session shown
  on('ui.focus', async ($, e, next) => {
    const moved = await next(e)

    if (e.component === 'Pane' && e.requestId === PANE && moved.deny === undefined) {
      await update($, focused, () => e.element ?? '')
    }

    return moved
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    // The mobile app draws no text field
    if (e.surface === 'mobile') {
      return next(e)
    }

    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const failed = await read($, error)

    if (failed !== null) {
      return <Text>{failed}</Text>
    }

    const all = await read($, sessions)

    if (all.length === 0) {
      return <Text>No active sessions</Text>
    }

    const pinned = await read($, order)
    const kept = await read($, summaries)
    const homeDir = await read($, home)
    const now = await read($, nowMs)
    const current = await read($, currentId)
    const dropped = await read($, skipped)
    const asked = await read($, query)
    const ring = await read($, focused)
    const found = new Set(filterLive(all, asked, homeDir).map(session => session.id))
    const byId = new Map(all.map(session => [session.id, session]))
    // A session that is gone keeps its place in the order and is not drawn; neither is one the
    // search does not let through, and its digit stays its own
    const rows = pinned.flatMap((id, place) => {
      const session = byId.get(id)

      return session === undefined || !found.has(id) ? [] : [{ session, place }]
    })
    const selected = selectedOf(
      rows.map(row => row.session),
      ring,
    )
    const layout = layoutOf(e.props.bodyColumns)
    const counter = `${rows.length}/${all.length}`
    const lines =
      selected === undefined
        ? [{ kind: 'note' as const, text: 'Nothing selected' }]
        : previewOf(
            selected,
            phaseOf(selected, now, staleMs),
            kept[selected.id],
            now,
            homeDir,
            previewWidth(layout.preview),
          )
    const selectedColor = selected === undefined ? undefined : PHASE_COLOR[phaseOf(selected, now, staleMs)]
    // A frame's title is drawn over its top border: an absolute Box after the frame, so it paints last
    const frameTitle = (title: string, width: number) => (
      <Box position="absolute" top={0} left={FRAME_TITLE_LEFT}>
        <Text color={ACCENT_COLOR} bold>{` ${clip(title, Math.max(1, width - FRAME_TITLE_CHROME))} `}</Text>
      </Box>
    )

    return (
      <Box
        flexDirection={layout.isStacked ? 'column' : 'row'}
        minHeight={layout.isStacked ? undefined : frameRows(e.props.scroll.bodyRows)}
      >
        <Box flexDirection="column" width={layout.list}>
          <Box borderStyle="round" borderColor={FRAME_COLOR} width={layout.list} flexDirection="column" flexGrow={1}>
            <Box>
              <Text color={ACCENT_COLOR}>{' > '}</Text>
              <Box flexGrow={1}>
                <Input
                  key={SEARCH}
                  value={asked}
                  placeholder="search"
                  submitLabel="go"
                  autoFocus
                  onInput={value => update($, query, () => value)}
                  onSubmit={() => (selected === undefined ? undefined : goTo($, selected))}
                />
              </Box>
              <Text color={QUIET_COLOR}>{dropped > 0 ? `${counter} · skipped ${dropped} ` : `${counter} `}</Text>
            </Box>
            <Text color={FRAME_COLOR}>{'─'.repeat(Math.max(1, layout.list - 2))}</Text>
            {rows.length === 0 && <Text color={QUIET_COLOR}>{' Nothing found'}</Text>}
            {rows.map(({ session, place }) => {
              const phase = phaseOf(session, now, staleMs)
              const isSelected = session.id === selected?.id
              const hotkey = hotkeyOf(place)

              return (
                <Box backgroundColor={isSelected ? SELECTION_COLOR : undefined}>
                  <Text color={ACCENT_COLOR}>{isSelected ? '▌' : ' '}</Text>
                  <Text color={PHASE_COLOR[phase]}>{`${markOf(phase)} `}</Text>
                  <Box flexGrow={1}>
                    <Button
                      key={rowKey(session.id)}
                      label={titleLabel(session.title, titleCell(layout.list), hotkey, session.id === current)}
                      hotkey={hotkey}
                      plain
                      dimColor={phase === 'stale'}
                      onPress={() => goTo($, session)}
                    />
                  </Box>
                  <Text color={AGE_COLOR}>{ageCell(now - session.statusSinceMs)}</Text>
                </Box>
              )
            })}
          </Box>
          {frameTitle(TITLE, layout.list)}
        </Box>
        <Box flexDirection="column" width={layout.preview}>
          <Box
            borderStyle="round"
            borderColor={FRAME_COLOR}
            width={layout.preview}
            flexDirection="column"
            flexGrow={1}
            paddingX={PREVIEW_PADDING}
          >
            {lines.map(line => (
              <Text color={line.kind === 'state' ? selectedColor : LINE_COLOR[line.kind]} bold={line.kind === 'state'}>
                {line.kind === 'gap' ? ' ' : line.text}
              </Text>
            ))}
          </Box>
          {frameTitle(selected?.title ?? NO_SESSION, layout.preview)}
        </Box>
      </Box>
    )
  })
}
