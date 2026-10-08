import type { Indexed, LiveIndex, LiveSession, Phase, Summary } from '../types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// How long a session waits before it goes dim, where the setting says nothing usable
const DEFAULT_STALE_MINUTES = 10
// A working session's summary is asked again no sooner than this, and so is one that failed
export const SUMMARY_REFRESH_MS = 3 * MINUTE
const SUMMARY_MAX = 200
// The status of a session whose agent is working
const BUSY = 'busy'
// The status of a session that waits for the person in the usual way
const IDLE = 'idle'
// Columns the pane asks its dock for: a list of 50 and a preview of 60
export const PANE_COLUMNS = 110
// A pane narrower than this puts the preview under the list
const STACK_UNDER = 72
// The list's share of a pane that holds both side by side, and its bounds
const LIST_SHARE = 0.45
const LIST_MIN = 40
const LIST_MAX = 54
// Cells a frame takes from its width: the two borders
const BORDERS = 2
// Cells of a row before its title: the selection bar, the mark, a space
const ROW_LEAD = 3
// Cells of a row's age: the label set right in 7, and a space before the border
const AGE_WIDTH = 7
const AGE_CELL = AGE_WIDTH + 1
// Cells the preview's text stands in from its frame, each side
export const PREVIEW_PADDING = 1
// Rows of the list's frame that are not sessions: two borders, the search field, the rule
const LIST_CHROME_ROWS = 4
// Rows the pane asks for where it is placed above the prompt: a preview with a prompt, a summary and a reply
const PANE_ROWS_MIN = 18
// Lines of the preview a prompt, a summary and a reply may take
const PROMPT_LINES = 3
const SUMMARY_LINES = 5
const REPLY_LINES = 4
// Lines every preview starts with: the state, the directory, the tmux address
const HEAD_LINES = 3
// Lines a section of the preview takes before its text: a gap and its label
const SECTION_LEAD = 2
// Rows of a frame that holds the fullest preview: a prompt, a summary, a running tool and a reply
const FRAME_ROWS =
  BORDERS +
  HEAD_LINES +
  (SECTION_LEAD + PROMPT_LINES) +
  (SECTION_LEAD + SUMMARY_LINES) +
  (SECTION_LEAD + 1) +
  (SECTION_LEAD + REPLY_LINES)
// Places that get a digit
const HOTKEYS = 9
// Cells a plain Button draws before its label: the digit, a colon, a space
const HOTKEY_WIDTH = 3
// What follows the title of the session the pane is open in
const HERE = ' (this)'

// One line of the preview, and what it is: the render colors it by kind
export type PreviewLine = {
  kind: 'state' | 'directory' | 'meta' | 'label' | 'text' | 'note' | 'gap'
  text: string
}
// How the pane splits its width: the list's frame, the preview's, and whether the preview is under the list
export type Layout = { isStacked: boolean; list: number; preview: number }
// A summary that was not got: the stamp it was asked at, and when
export type Failure = { stamp: string; atMs: number }

// Reads what the indexer printed; throws when it is not an index
export const parseLive = (stdout: string): LiveIndex => {
  const parsed: unknown = JSON.parse(stdout)

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('not an index')
  }

  const fields = parsed as Record<string, unknown>

  if (!Array.isArray(fields.sessions)) {
    throw new Error('no sessions list')
  }

  return {
    sessions: fields.sessions as Indexed[],
    skipped: typeof fields.skipped === 'number' ? fields.skipped : 0,
  }
}

// The setting as minutes; one that is no number of minutes from 1 up is ten minutes
export const staleMinutesOf = (staleMinutes: unknown): number =>
  typeof staleMinutes === 'number' && Number.isFinite(staleMinutes) && staleMinutes >= 1
    ? staleMinutes
    : DEFAULT_STALE_MINUTES

// The same in milliseconds
export const staleMsOf = (staleMinutes: unknown): number => staleMinutesOf(staleMinutes) * MINUTE

// Two spaces typed into an empty prompt: the leader that opens the board, as <space><space>
// opens a picker in nvim. `draft` is the prompt before the edit, `typed` what the edit puts in:
// the second space after the first, or both at once where the editor folded them into one edit
export const isLeader = (draft: string, typed: string): boolean =>
  (draft === ' ' && typed === ' ') || (draft === '' && typed === '  ')

// Where the summaries are left for the floating window to read: the person's runtime folder,
// else their cache
export const summariesFileOf = (runtimeDir: string, home: string): string =>
  runtimeDir !== ''
    ? `${runtimeDir}/session-board/summaries.json`
    : `${home}/.cache/session-board/summaries.json`

// The floating window: the mod's own program, which opens a tmux popup and runs fzf in it
export const popupArgv = (
  root: string,
  configDir: string,
  summariesFile: string,
  current: string,
  staleMinutes: number,
): string[] => [
  'python3',
  `${root}/hooks/board_popup.py`,
  'run',
  '--config',
  configDir,
  '--summaries',
  summariesFile,
  '--current',
  current,
  '--stale-minutes',
  String(staleMinutes),
]

// A busy session works. Any other waits for the person, and past the threshold it is stale
export const phaseOf = (session: LiveSession, nowMs: number, staleMs: number): Phase => {
  if (session.status === BUSY) {
    return 'working'
  }

  return nowMs - session.statusSinceMs > staleMs ? 'stale' : 'waiting'
}

export const ageLabel = (elapsedMs: number): string => {
  if (elapsedMs < MINUTE) {
    return '<1 min'
  }

  if (elapsedMs < HOUR) {
    return `${Math.floor(elapsedMs / MINUTE)} min`
  }

  return elapsedMs < DAY ? `${Math.floor(elapsedMs / HOUR)} h` : `${Math.floor(elapsedMs / DAY)} d`
}

// What the session does and for how long. A status this mod does not know is shown as the word itself
export const stateLabel = (session: LiveSession, phase: Phase, nowMs: number): string => {
  const age = ageLabel(nowMs - session.statusSinceMs)

  if (phase === 'working') {
    return `working ${age}`
  }

  if (session.status !== IDLE) {
    return `${session.status} ${age}`
  }

  return phase === 'waiting' ? `waiting for you ${age}` : `waiting ${age}`
}

const RANK: Record<Phase, number> = { waiting: 0, working: 1, stale: 2 }

// The ids as the pane first shows them: the waiting, the working, the stale, the latest change on top
export const orderOf = (sessions: readonly LiveSession[], nowMs: number, staleMs: number): string[] =>
  [...sessions]
    .sort(
      (a, b) =>
        RANK[phaseOf(a, nowMs, staleMs)] - RANK[phaseOf(b, nowMs, staleMs)] ||
        b.statusSinceMs - a.statusSinceMs ||
        a.pid - b.pid,
    )
    .map(session => session.id)

// The pinned order with the new sessions at its end. A session that is gone keeps its place,
// so no other session moves under a digit the person is about to press
export const mergeOrder = (pinned: readonly string[], sessions: readonly LiveSession[]): string[] => [
  ...pinned,
  ...sessions.map(session => session.id).filter(id => !pinned.includes(id)),
]

export const hotkeyOf = (place: number): string | undefined =>
  place < HOTKEYS ? String(place + 1) : undefined

// Whether the model is asked about the session now. A waiting one is asked once per stop,
// a working one at once and then no sooner than SUMMARY_REFRESH_MS, a stale one never
export const needsSummary = (
  session: Indexed,
  phase: Phase,
  cached: Summary | undefined,
  nowMs: number,
): boolean => {
  if (phase === 'stale' || session.stamp === null || session.digest === null) {
    return false
  }

  if (cached === undefined) {
    return true
  }

  if (cached.stamp === session.stamp) {
    return false
  }

  return phase === 'waiting' || nowMs - cached.atMs >= SUMMARY_REFRESH_MS
}

// After a failure a session is asked again only at a new stamp and SUMMARY_REFRESH_MS later:
// a working session's stamp moves every few seconds, and the failure would repeat at each
export const isHeldBack = (failure: Failure | undefined, stamp: string, nowMs: number): boolean =>
  failure !== undefined && (failure.stamp === stamp || nowMs - failure.atMs < SUMMARY_REFRESH_MS)

export const isSummary = (value: unknown): value is Summary => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const fields = value as Record<string, unknown>

  return typeof fields.stamp === 'string' && typeof fields.text === 'string' && typeof fields.atMs === 'number'
}

// Text cut at its end to a width, the cut marked
export const clip = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`

// Text cut at its start to a width: a path keeps its last components
export const clipStart = (text: string, width: number): string =>
  text.length <= width ? text : `…${width > 1 ? text.slice(1 - width) : ''}`

// The title as its Button draws it: cut so the digit before it and the mark of the current session fit
export const titleLabel = (
  title: string,
  width: number,
  hotkey: string | undefined,
  isCurrent: boolean,
): string => {
  const room = width - (hotkey === undefined ? 0 : HOTKEY_WIDTH) - (isCurrent ? HERE.length : 0)

  return `${clip(title, Math.max(1, room))}${isCurrent ? HERE : ''}`
}

// The model's reply as the pane draws it: one line, cut
export const cleanSummary = (text: string): string => clip(text.split(/\s+/).filter(Boolean).join(' '), SUMMARY_MAX)

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

const MARK: Record<Phase, string> = { waiting: '●', working: '◐', stale: '○' }

export const markOf = (phase: Phase): string => MARK[phase]

// The key of a session's row: its Button's, and what the focus ring names when it stands on it
export const rowKey = (id: string): string => `go-${id}`

// How a pane of a width holds the two frames: side by side, or the preview under the list
export const layoutOf = (width: number): Layout => {
  if (width < STACK_UNDER) {
    return { isStacked: true, list: width, preview: width }
  }

  const list = clamp(Math.round(width * LIST_SHARE), LIST_MIN, LIST_MAX)

  return { isStacked: false, list, preview: width - list }
}

// Cells of a row's title in a list frame of a width
export const titleCell = (listWidth: number): number => Math.max(1, listWidth - BORDERS - ROW_LEAD - AGE_CELL)

// Cells of the preview's text in a frame of a width
export const previewWidth = (frame: number): number => Math.max(1, frame - BORDERS - 2 * PREVIEW_PADDING)

// A row's age, set right so the ages stand in a column
export const ageCell = (elapsedMs: number): string => `${ageLabel(elapsedMs).padStart(AGE_WIDTH)} `

// Rows the two frames stand at beside each other, so they do not change height as the selection
// moves between a session with much to show and one with little: the fullest preview's, or the pane's
export const frameRows = (bodyRows: number): number => (bodyRows > 0 ? Math.min(bodyRows, FRAME_ROWS) : FRAME_ROWS)

// Rows the pane asks for where it is placed above the prompt
export const paneRows = (sessions: number): number => Math.max(PANE_ROWS_MIN, sessions + LIST_CHROME_ROWS)

// The sessions the search field lets through: every word of the query is somewhere in the title,
// the directory or the last prompt, as text and whatever its case
export const filterLive = (sessions: readonly LiveSession[], query: string, home: string): LiveSession[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  return sessions.filter(session => {
    const text = `${session.title} ${directoryOf(session.cwd, home)} ${session.lastPrompt ?? ''}`.toLowerCase()

    return words.every(word => text.includes(word))
  })
}

// The session the preview shows and Enter in the search field goes to: the row that holds the
// focus ring, else the first one shown
export const selectedOf = (shown: readonly LiveSession[], focused: string): LiveSession | undefined =>
  shown.find(session => rowKey(session.id) === focused) ?? shown[0]

// The preview of a session, line by line: what it does, where it is, what was asked, what was done
export const previewOf = (
  session: LiveSession,
  phase: Phase,
  summary: Summary | undefined,
  nowMs: number,
  home: string,
  width: number,
): PreviewLine[] => {
  const lines: PreviewLine[] = [
    { kind: 'state', text: clip(`${markOf(phase)} ${stateLabel(session, phase, nowMs)}`, width) },
    { kind: 'directory', text: clipStart(directoryOf(session.cwd, home), width) },
    { kind: 'meta', text: clip(session.tmuxTarget === null ? 'not in tmux' : `tmux ${session.tmuxTarget}`, width) },
  ]
  const section = (label: string, text: readonly string[]): void => {
    lines.push({ kind: 'gap', text: '' }, { kind: 'label', text: label })
    lines.push(...text.map(line => ({ kind: 'text' as const, text: line })))
  }

  if (session.lastPrompt !== null) {
    section('you', wrap(session.lastPrompt, width, PROMPT_LINES))
  }

  if (summary !== undefined) {
    section('summary', wrap(summary.text, width, SUMMARY_LINES))
  }

  if (phase === 'working' && session.activity !== null) {
    section('now', [clip(session.activity, width)])
  }

  if (session.lastReply !== null) {
    section('agent', wrap(session.lastReply, width, REPLY_LINES))
  }

  // Only the lines every session has: nothing was asked in it yet
  if (lines.length === HEAD_LINES) {
    lines.push({ kind: 'gap', text: '' }, { kind: 'note', text: 'Nothing has been asked in this session yet' })
  }

  return lines
}

// The session's directory as a person writes it: from `~` inside the home directory
export const directoryOf = (cwd: string, home: string): string => {
  if (home !== '' && cwd === home) {
    return '~'
  }

  return home !== '' && cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd
}

// Text broken at spaces into lines of a width; what is past the last line is cut
export const wrap = (text: string, width: number, maxLines: number): string[] => {
  const room = Math.max(1, width)
  const lines: string[] = []
  let rest = text.trim()

  while (rest !== '' && lines.length < maxLines) {
    if (rest.length <= room) {
      lines.push(rest)
      break
    }

    if (lines.length === maxLines - 1) {
      lines.push(clip(rest, room))
      break
    }

    const space = rest.lastIndexOf(' ', room)
    const at = space > 0 ? space : room
    lines.push(rest.slice(0, at))
    rest = rest.slice(at).trimStart()
  }

  return lines
}

// tmux brings the person's client to the session's pane: its session, its window, the pane
export const switchArgv = (pane: string): string[] => ['tmux', 'switch-client', '-t', pane]
