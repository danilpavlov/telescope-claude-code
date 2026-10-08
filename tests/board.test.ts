import { expect, test } from 'claude-code/testing'

import {
  PANE_COLUMNS,
  SUMMARY_REFRESH_MS,
  ageCell,
  ageLabel,
  cleanSummary,
  clip,
  clipStart,
  directoryOf,
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
  stateLabel,
  summariesFileOf,
  switchArgv,
  titleCell,
  titleLabel,
  wrap,
} from '../hooks/board'
import type { Indexed, Summary } from '../types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOW = 1_800_000_000_000
const STALE = 10 * MINUTE

const session = (fields: Partial<Indexed>): Indexed => ({
  id: 'id',
  pid: 1,
  title: 'Some title',
  cwd: '/home/u/work/app',
  status: 'idle',
  statusSinceMs: NOW,
  lastPrompt: 'prompt',
  lastReply: 'A reply.',
  activity: null,
  tmuxPane: '%1',
  tmuxTarget: 'main:@1.%1',
  stamp: 's1',
  digest: 'digest',
  ...fields,
})

test('parseLive reads what the indexer printed', () => {
  const one = session({ id: 'a' })

  expect(parseLive(JSON.stringify({ sessions: [one], skipped: 2 }))).toEqual({ sessions: [one], skipped: 2 })
  expect(parseLive(JSON.stringify({ sessions: [] }))).toEqual({ sessions: [], skipped: 0 })
})

test('parseLive throws on what is not an index', () => {
  expect(() => parseLive('Traceback (most recent call last)')).toThrow()
  expect(() => parseLive('')).toThrow()
  expect(() => parseLive('null')).toThrow()
  expect(() => parseLive(JSON.stringify({ skipped: 0 }))).toThrow()
})

test('staleMsOf turns the setting into milliseconds, a bad one into ten minutes', () => {
  expect(staleMsOf(10)).toBe(10 * MINUTE)
  expect(staleMsOf(30)).toBe(30 * MINUTE)
  expect(staleMsOf(1.5)).toBe(90_000)
  expect(staleMsOf(0)).toBe(10 * MINUTE)
  expect(staleMsOf(-5)).toBe(10 * MINUTE)
  expect(staleMsOf(Number.NaN)).toBe(10 * MINUTE)
  expect(staleMsOf(Number.POSITIVE_INFINITY)).toBe(10 * MINUTE)
  expect(staleMsOf('30')).toBe(10 * MINUTE)
  expect(staleMsOf(undefined)).toBe(10 * MINUTE)
})

test('staleMinutesOf is the same threshold in minutes, for the floating window', () => {
  expect(staleMinutesOf(30)).toBe(30)
  expect(staleMinutesOf(1.5)).toBe(1.5)
  expect(staleMinutesOf(0)).toBe(10)
  expect(staleMinutesOf('30')).toBe(10)
})

test('isLeader: two spaces typed into an empty prompt, and nothing else', () => {
  // The second space, typed after the first
  expect(isLeader(' ', ' ')).toBe(true)
  // Both at once: a burst of keys the editor folded into one edit
  expect(isLeader('', '  ')).toBe(true)
  // The first space alone, a space after text, text after a space, three at once
  expect(isLeader('', ' ')).toBe(false)
  expect(isLeader('fix it ', ' ')).toBe(false)
  expect(isLeader(' ', 'a')).toBe(false)
  expect(isLeader('  ', ' ')).toBe(false)
  expect(isLeader('', '   ')).toBe(false)
  expect(isLeader(' ', '')).toBe(false)
})

test('summariesFileOf: the runtime folder of the person, else their cache', () => {
  expect(summariesFileOf('/run/user/1000', '/home/u')).toBe('/run/user/1000/session-board/summaries.json')
  expect(summariesFileOf('', '/home/u')).toBe('/home/u/.cache/session-board/summaries.json')
})

test('popupArgv runs the floating window of the mod over the configuration folder', () => {
  expect(popupArgv('/mods/session-board', '/home/u/.claude', '/run/user/1000/session-board/summaries.json', 'here', 10)).toEqual([
    'python3',
    '/mods/session-board/hooks/board_popup.py',
    'run',
    '--config',
    '/home/u/.claude',
    '--summaries',
    '/run/user/1000/session-board/summaries.json',
    '--current',
    'here',
    '--stale-minutes',
    '10',
  ])
})

test('phaseOf: a session waits up to the threshold and is stale past it', () => {
  expect(phaseOf(session({ statusSinceMs: NOW }), NOW, STALE)).toBe('waiting')
  expect(phaseOf(session({ statusSinceMs: NOW - STALE }), NOW, STALE)).toBe('waiting')
  expect(phaseOf(session({ statusSinceMs: NOW - STALE - 1 }), NOW, STALE)).toBe('stale')
})

test('phaseOf: a busy session works however long it has', () => {
  expect(phaseOf(session({ status: 'busy', statusSinceMs: NOW - 3 * HOUR }), NOW, STALE)).toBe('working')
})

test('phaseOf: a status this mod does not know waits like an idle one', () => {
  expect(phaseOf(session({ status: 'blocked', statusSinceMs: NOW - MINUTE }), NOW, STALE)).toBe('waiting')
  expect(phaseOf(session({ status: 'blocked', statusSinceMs: NOW - HOUR }), NOW, STALE)).toBe('stale')
})

test('ageLabel counts minutes, then hours, then days', () => {
  expect(ageLabel(0)).toBe('<1 min')
  expect(ageLabel(MINUTE - 1)).toBe('<1 min')
  expect(ageLabel(MINUTE)).toBe('1 min')
  expect(ageLabel(HOUR - 1)).toBe('59 min')
  expect(ageLabel(HOUR)).toBe('1 h')
  expect(ageLabel(DAY - 1)).toBe('23 h')
  expect(ageLabel(DAY)).toBe('1 d')
  expect(ageLabel(3 * DAY + HOUR)).toBe('3 d')
})

test('ageLabel takes a clock that ran backwards as just now', () => {
  expect(ageLabel(-5 * MINUTE)).toBe('<1 min')
})

test('stateLabel says who waits for whom and for how long', () => {
  const idle = session({ statusSinceMs: NOW - 3 * MINUTE })
  const busy = session({ status: 'busy', statusSinceMs: NOW - 42 * MINUTE })
  const old = session({ statusSinceMs: NOW - 2 * HOUR })

  expect(stateLabel(idle, 'waiting', NOW)).toBe('waiting for you 3 min')
  expect(stateLabel(busy, 'working', NOW)).toBe('working 42 min')
  expect(stateLabel(old, 'stale', NOW)).toBe('waiting 2 h')
})

test('stateLabel shows a status it does not know as the word itself', () => {
  const asking = session({ status: 'blocked', statusSinceMs: NOW - 3 * MINUTE })

  expect(stateLabel(asking, 'waiting', NOW)).toBe('blocked 3 min')
  expect(stateLabel({ ...asking, statusSinceMs: NOW - 2 * HOUR }, 'stale', NOW)).toBe('blocked 2 h')
})

test('orderOf puts the waiting first, then the working, then the stale, the latest change on top', () => {
  const all = [
    session({ id: 'stale-old', pid: 1, statusSinceMs: NOW - 5 * HOUR }),
    session({ id: 'work-old', pid: 2, status: 'busy', statusSinceMs: NOW - 40 * MINUTE }),
    session({ id: 'wait-old', pid: 3, statusSinceMs: NOW - 8 * MINUTE }),
    session({ id: 'stale-new', pid: 4, statusSinceMs: NOW - 2 * HOUR }),
    session({ id: 'wait-new', pid: 5, statusSinceMs: NOW - MINUTE }),
    session({ id: 'work-new', pid: 6, status: 'busy', statusSinceMs: NOW - 2 * MINUTE }),
  ]

  expect(orderOf(all, NOW, STALE)).toEqual(['wait-new', 'wait-old', 'work-new', 'work-old', 'stale-new', 'stale-old'])
})

test('orderOf breaks a tie by pid, so the order never depends on the input', () => {
  const a = session({ id: 'a', pid: 9 })
  const b = session({ id: 'b', pid: 3 })

  expect(orderOf([a, b], NOW, STALE)).toEqual(['b', 'a'])
  expect(orderOf([b, a], NOW, STALE)).toEqual(['b', 'a'])
})

test('mergeOrder keeps every pinned place and appends the new sessions', () => {
  const live = [session({ id: 'new', pid: 1 }), session({ id: 'b', pid: 2 }), session({ id: 'newer', pid: 3 })]

  // `a` is gone, and nobody takes its place
  expect(mergeOrder(['a', 'b'], live)).toEqual(['a', 'b', 'new', 'newer'])
  expect(mergeOrder([], live)).toEqual(['new', 'b', 'newer'])
  expect(mergeOrder(['a', 'b'], [])).toEqual(['a', 'b'])
})

test('hotkeyOf gives the first nine places a digit', () => {
  expect(hotkeyOf(0)).toBe('1')
  expect(hotkeyOf(8)).toBe('9')
  expect(hotkeyOf(9)).toBeUndefined()
  expect(hotkeyOf(40)).toBeUndefined()
})

test('needsSummary: a waiting session is asked once per stop', () => {
  const waiting = session({ stamp: 's2' })
  const said: Summary = { stamp: 's2', text: 'summary', atMs: NOW - HOUR }

  expect(needsSummary(waiting, 'waiting', undefined, NOW)).toBe(true)
  expect(needsSummary(waiting, 'waiting', said, NOW)).toBe(false)
  // The transcript moved: asked again at once, however fresh the last summary is
  expect(needsSummary(waiting, 'waiting', { ...said, stamp: 's1', atMs: NOW - 1 }, NOW)).toBe(true)
})

test('needsSummary: a working session is asked at once, then no sooner than every three minutes', () => {
  const working = session({ status: 'busy', stamp: 's2' })
  const earlier: Summary = { stamp: 's1', text: 'summary', atMs: NOW - SUMMARY_REFRESH_MS + 1 }

  expect(SUMMARY_REFRESH_MS).toBe(3 * MINUTE)
  expect(needsSummary(working, 'working', undefined, NOW)).toBe(true)
  expect(needsSummary(working, 'working', earlier, NOW)).toBe(false)
  expect(needsSummary(working, 'working', { ...earlier, atMs: NOW - SUMMARY_REFRESH_MS }, NOW)).toBe(true)
  // Nothing moved since: not asked, however old the summary
  expect(needsSummary(working, 'working', { ...earlier, stamp: 's2', atMs: NOW - DAY }, NOW)).toBe(false)
})

test('needsSummary: a stale session, and one with nothing said in it, are never asked', () => {
  expect(needsSummary(session({}), 'stale', undefined, NOW)).toBe(false)
  expect(needsSummary(session({ stamp: null, digest: null }), 'waiting', undefined, NOW)).toBe(false)
  expect(needsSummary(session({ digest: null }), 'working', undefined, NOW)).toBe(false)
})

test('isHeldBack: after a failure a session waits for a new stamp and for three minutes', () => {
  const failed = { stamp: 's1', atMs: NOW - SUMMARY_REFRESH_MS }

  expect(isHeldBack(undefined, 's1', NOW)).toBe(false)
  // The same stamp: held however long ago it failed
  expect(isHeldBack({ ...failed, atMs: NOW - DAY }, 's1', NOW)).toBe(true)
  // A new stamp, but too soon
  expect(isHeldBack({ ...failed, atMs: NOW - SUMMARY_REFRESH_MS + 1 }, 's2', NOW)).toBe(true)
  expect(isHeldBack(failed, 's2', NOW)).toBe(false)
})

test('isSummary tells a kept summary from anything else in the store', () => {
  expect(isSummary({ stamp: 's', text: 'summary', atMs: 1 })).toBe(true)
  expect(isSummary({ stamp: 's', text: 'summary' })).toBe(false)
  expect(isSummary({ stamp: 1, text: 'summary', atMs: 1 })).toBe(false)
  expect(isSummary('summary')).toBe(false)
  expect(isSummary(null)).toBe(false)
  expect(isSummary(undefined)).toBe(false)
})

test('cleanSummary makes one line of at most 200 characters', () => {
  expect(cleanSummary('  Fixed the tests.\n\nWaits   for a call. ')).toBe('Fixed the tests. Waits for a call.')
  expect(cleanSummary('a'.repeat(300))).toBe(`${'a'.repeat(199)}…`)
  expect(cleanSummary(' \n ')).toBe('')
})

test('markOf: a dot that waits, a half that works, a ring that went dim', () => {
  expect(markOf('waiting')).toBe('●')
  expect(markOf('working')).toBe('◐')
  expect(markOf('stale')).toBe('○')
})

test('layoutOf: the list takes 45% beside the preview, within its bounds', () => {
  expect(PANE_COLUMNS).toBe(110)
  expect(layoutOf(110)).toEqual({ isStacked: false, list: 50, preview: 60 })
  expect(layoutOf(88)).toEqual({ isStacked: false, list: 40, preview: 48 })
  // 200 cells: 45% is 90, over the list's ceiling of 54
  expect(layoutOf(200)).toEqual({ isStacked: false, list: 54, preview: 146 })
  // 72 cells: 45% is 32, under the list's floor of 40
  expect(layoutOf(72)).toEqual({ isStacked: false, list: 40, preview: 32 })
})

test('layoutOf: a narrow pane puts the preview under the list, both as wide as the pane', () => {
  expect(layoutOf(71)).toEqual({ isStacked: true, list: 71, preview: 71 })
  expect(layoutOf(40)).toEqual({ isStacked: true, list: 40, preview: 40 })
})

test('titleCell and previewWidth: what the frames leave their text', () => {
  // A list of 50: 2 of borders, 3 before the title, 8 of age
  expect(titleCell(50)).toBe(37)
  expect(titleCell(5)).toBe(1)
  // A preview of 60: 2 of borders, 1 of padding each side
  expect(previewWidth(60)).toBe(56)
  expect(previewWidth(2)).toBe(1)
})

test('ageCell sets the age right in seven cells, a space after it', () => {
  expect(ageCell(3 * MINUTE)).toBe('  3 min ')
  expect(ageCell(0)).toBe(' <1 min ')
  expect(ageCell(2 * HOUR)).toBe('    2 h ')
  expect(ageCell(59 * MINUTE)).toBe(' 59 min ')
})

test('paneRows: the list with its frame, and never under what a preview needs', () => {
  expect(paneRows(0)).toBe(18)
  expect(paneRows(4)).toBe(18)
  expect(paneRows(14)).toBe(18)
  expect(paneRows(15)).toBe(19)
  expect(paneRows(30)).toBe(34)
})

test('frameRows: the frames stand as tall as the fullest preview, or as the pane lets them', () => {
  // Two borders, three lines every session has, a prompt of 3, a summary of 5, a tool, a reply of 4,
  // each under a gap and a label
  expect(frameRows(43)).toBe(26)
  expect(frameRows(26)).toBe(26)
  expect(frameRows(12)).toBe(12)
  // The surface has not measured the pane yet
  expect(frameRows(0)).toBe(26)
})

test('filterLive looks at the title, the directory and the last prompt, every word of the query', () => {
  const etl = session({ id: 'etl', title: 'ETL v1->v2: spec review', cwd: '/home/u/work/billing-api', lastPrompt: 'look at the spec' })
  const mods = session({ id: 'mods', title: 'Saving sessions', cwd: '/home/u/github/claude-mods', lastPrompt: 'make a mod with a workflow' })
  const fresh = session({ id: 'fresh', title: 'New session', cwd: '/home/u', lastPrompt: null })
  const all = [etl, mods, fresh]
  const ids = (query: string) => filterLive(all, query, '/home/u').map(one => one.id)

  expect(ids('')).toEqual(['etl', 'mods', 'fresh'])
  expect(ids('   ')).toEqual(['etl', 'mods', 'fresh'])
  expect(ids('SPEC review')).toEqual(['etl'])
  expect(ids('claude-mods')).toEqual(['mods'])
  expect(ids('~/work')).toEqual(['etl'])
  expect(ids('workflow')).toEqual(['mods'])
  expect(ids('session spec')).toEqual([])
})

test('filterLive takes the query as text, not as a pattern', () => {
  const etl = session({ id: 'etl', title: 'ETL v1->v2: review (spec)', lastPrompt: null })

  expect(filterLive([etl], 'v1->v2', '/home/u').length).toBe(1)
  expect(filterLive([etl], '(spec)', '/home/u').length).toBe(1)
  expect(filterLive([etl], '.*', '/home/u').length).toBe(0)
})

test('selectedOf: the row that holds the ring, else the first one shown', () => {
  const a = session({ id: 'a' })
  const b = session({ id: 'b' })

  expect(rowKey('a')).toBe('go-a')
  expect(selectedOf([a, b], rowKey('b'))?.id).toBe('b')
  // The ring is on the search field, or nowhere
  expect(selectedOf([a, b], 'query')?.id).toBe('a')
  expect(selectedOf([a, b], '')?.id).toBe('a')
  // The row that held the ring was filtered out, or its session ended
  expect(selectedOf([a], rowKey('b'))?.id).toBe('a')
  expect(selectedOf([], rowKey('a'))).toBeUndefined()
})

test('previewOf: the state, where the session is, the prompt, the summary and the last reply', () => {
  const said: Summary = { stamp: 's0', text: 'Fixed the tests, waits for a call on the commits.', atMs: NOW }
  const waiting = session({ statusSinceMs: NOW - 3 * MINUTE, lastPrompt: 'fix the tests', lastReply: 'Done.' })

  expect(previewOf(waiting, 'waiting', said, NOW, '/home/u', 60)).toEqual([
    { kind: 'state', text: '● waiting for you 3 min' },
    { kind: 'directory', text: '~/work/app' },
    { kind: 'meta', text: 'tmux main:@1.%1' },
    { kind: 'gap', text: '' },
    { kind: 'label', text: 'you' },
    { kind: 'text', text: 'fix the tests' },
    { kind: 'gap', text: '' },
    { kind: 'label', text: 'summary' },
    { kind: 'text', text: 'Fixed the tests, waits for a call on the commits.' },
    { kind: 'gap', text: '' },
    { kind: 'label', text: 'agent' },
    { kind: 'text', text: 'Done.' },
  ])
})

test('previewOf: a working session names the tool it runs; a waiting one does not', () => {
  const busy = session({ status: 'busy', statusSinceMs: NOW - 42 * MINUTE, activity: 'Bash', lastPrompt: null, lastReply: null })
  const running = [
    { kind: 'gap', text: '' },
    { kind: 'label', text: 'now' },
    { kind: 'text', text: 'Bash' },
  ]

  expect(previewOf(busy, 'working', undefined, NOW, '/home/u', 60).slice(3)).toEqual(running)
  expect(previewOf(busy, 'working', undefined, NOW, '/home/u', 60)[0]).toEqual({ kind: 'state', text: '◐ working 42 min' })
  // A tool left without an answer in a session that waits is not what it does now
  const idle = previewOf({ ...busy, status: 'idle' }, 'waiting', undefined, NOW, '/home/u', 60)
  expect(idle.some(line => line.text === 'now')).toBe(false)
})

test('previewOf: a session outside tmux says so, and one with nothing said in it says that', () => {
  const fresh = session({ tmuxPane: null, tmuxTarget: null, lastPrompt: null, lastReply: null, stamp: null, digest: null })

  expect(previewOf(fresh, 'waiting', undefined, NOW, '/home/u', 60)).toEqual([
    { kind: 'state', text: '● waiting for you <1 min' },
    { kind: 'directory', text: '~/work/app' },
    { kind: 'meta', text: 'not in tmux' },
    { kind: 'gap', text: '' },
    { kind: 'note', text: 'Nothing has been asked in this session yet' },
  ])
})

test('previewOf wraps to its width: three lines of prompt, five of summary, four of reply', () => {
  const words = (word: string) => Array.from({ length: 60 }, () => word).join(' ')
  const wordy = session({ lastPrompt: words('prompt'), lastReply: words('reply') })
  const said: Summary = { stamp: 's0', text: words('summary'), atMs: NOW }
  const lines = previewOf(wordy, 'waiting', said, NOW, '/home/u', 30)
  const under = (label: string) => {
    const from = lines.findIndex(line => line.kind === 'label' && line.text === label) + 1
    const rest = lines.slice(from)
    const to = rest.findIndex(line => line.kind !== 'text')

    return to < 0 ? rest : rest.slice(0, to)
  }

  expect(under('you').length).toBe(3)
  expect(under('summary').length).toBe(5)
  expect(under('agent').length).toBe(4)
  expect(lines.every(line => line.text.length <= 30)).toBe(true)
  expect(under('you')[2]?.text.endsWith('…')).toBe(true)
})

test('previewOf cuts a long state and a long path to its width, the path from its start', () => {
  const deep = session({ status: 'permission-prompt-open', cwd: '/home/u/work/acme/platform/memory/billing-payments-importer', tmuxTarget: 'billing-payments-importer:@4.%4' })
  const lines = previewOf(deep, 'waiting', undefined, NOW, '/home/u', 20)

  expect(lines[0]).toEqual({ kind: 'state', text: '● permission-prompt…' })
  expect(lines[1]).toEqual({ kind: 'directory', text: '…g-payments-importer' })
  expect(lines[2]).toEqual({ kind: 'meta', text: 'tmux billing-paymen…' })
})

test('directoryOf writes the path from the home directory', () => {
  expect(directoryOf('/home/u/work/app', '/home/u')).toBe('~/work/app')
  expect(directoryOf('/home/u', '/home/u')).toBe('~')
  expect(directoryOf('/home/user2/app', '/home/u')).toBe('/home/user2/app')
  expect(directoryOf('/srv/app', '')).toBe('/srv/app')
})

test('clip cuts the end, clipStart the start', () => {
  expect(clip('short', 20)).toBe('short')
  expect(clip('a very long title', 10)).toBe('a very lo…')
  expect(clip('abc', 0)).toBe('…')
  expect(clipStart('~/work/app', 20)).toBe('~/work/app')
  expect(clipStart('~/work/billing-api', 10)).toBe('…lling-api')
  expect(clipStart('abc', 1)).toBe('…')
})

test('titleLabel leaves room for the digit and for the mark of the current session', () => {
  expect(titleLabel('Short', 30, '1', false)).toBe('Short')
  expect(titleLabel('Short', 30, undefined, true)).toBe('Short (this)')
  // 20 cells: 3 go to `1: `, so the title has 17
  expect(titleLabel('A very long title of a session', 20, '1', false)).toBe('A very long titl…')
  expect(titleLabel('A very long title of a session', 20, undefined, false)).toBe('A very long title o…')
  // 6 more go to the mark, which is never cut
  expect(titleLabel('A very long title of a session', 20, '1', true)).toBe('A very lo… (this)')
  expect(titleLabel('Some title', 4, '1', true)).toBe('… (this)')
})

test('wrap breaks at spaces and cuts what is past the last line', () => {
  expect(wrap('Fixed the tests.', 40, 2)).toEqual(['Fixed the tests.'])
  expect(wrap('Cleaned the logs, fixed five review notes, tests are green', 30, 2)).toEqual([
    'Cleaned the logs, fixed five',
    'review notes, tests are green',
  ])
  expect(wrap('one two three four five six seven eight', 10, 2)).toEqual(['one two', 'three fou…'])
  expect(wrap('', 10, 2)).toEqual([])
})

test('wrap cuts a word wider than the line', () => {
  expect(wrap('aaaaaaaaaaaaaaaaaaaa bb', 8, 3)).toEqual(['aaaaaaaa', 'aaaaaaaa', 'aaaa bb'])
  expect(wrap('abc', 0, 2)).toEqual(['a', '…'])
})

test('switchArgv asks tmux to bring the client to the pane', () => {
  expect(switchArgv('%4')).toEqual(['tmux', 'switch-client', '-t', '%4'])
})
