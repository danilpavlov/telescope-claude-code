import { expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteResult, ProcessRunResult } from 'claude-code'
import type { MockClock, TestBody } from 'claude-code/testing'

import type { Indexed } from '../types'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const NOW = 1_800_000_000_000
const TICK = 5_000

const WAIT: Indexed = {
  id: 'wait',
  pid: 10,
  title: 'PROJ-1532 collision spec draft',
  cwd: '/home/u/work/billing-api',
  status: 'idle',
  statusSinceMs: NOW - 3 * MINUTE,
  lastPrompt: 'remove the traces and fix the list',
  lastReply: 'Done: 14 edits, the tests are green.',
  activity: null,
  tmuxPane: '%4',
  tmuxTarget: 'memory:@4.%4',
  stamp: 'w1',
  digest: 'digest wait',
}
const WORK: Indexed = {
  id: 'work',
  pid: 20,
  title: 'Save the Claude sessions',
  cwd: '/home/u/github/claude-mods',
  status: 'busy',
  statusSinceMs: NOW - 42 * MINUTE,
  lastPrompt: 'make a mod for the active sessions',
  lastReply: 'Writing the indexer.',
  activity: 'Bash',
  tmuxPane: '%7',
  tmuxTarget: 'HOME:@7.%7',
  stamp: 'k1',
  digest: 'digest work',
}
const OLD: Indexed = {
  id: 'old',
  pid: 30,
  title: 'ETL v1->v2: spec review',
  cwd: '/home/u/work/billing-api',
  status: 'idle',
  statusSinceMs: NOW - 2 * HOUR,
  lastPrompt: 'look at the spec',
  lastReply: 'The spec is fine.',
  activity: null,
  tmuxPane: '%2',
  tmuxTarget: 'memory:@2.%2',
  stamp: 'o1',
  digest: 'digest old',
}
const HERE: Indexed = {
  id: 'here',
  pid: 40,
  title: 'VPN autostart',
  cwd: '/home/u',
  status: 'idle',
  statusSinceMs: NOW - 5 * HOUR,
  lastPrompt: 'fix the vpn',
  lastReply: 'Fixed it.',
  activity: null,
  tmuxPane: '%5',
  tmuxTarget: 'HOME:@5.%5',
  stamp: 'h1',
  digest: 'digest here',
}
// As the indexer lists them: by pid
const ALL = [WAIT, WORK, OLD, HERE]

// /board as the person types it at the prompt
const run = {
  command: 'board',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 100 },
} as const

// The pane as the engine asks for it, `bodyColumns` across (110, what the mod asks its dock for:
// a list frame of 50 and a preview frame of 60)
const pane = (bodyColumns = 110, bodyRows = 43) =>
  ({
    plugin: 'session-board',
    component: 'Pane',
    requestId: 'board',
    surface: 'terminal',
    viewport: { columns: bodyColumns, rows: 56 },
    props: {
      title: 'Active sessions',
      isFocused: true,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
      view: {},
    },
  }) as const

const ran = (fields: Partial<ProcessRunResult>): ProcessRunResult => ({
  exitCode: 0,
  stdout: '',
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
  ...fields,
})

const USAGE = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }

const said = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: USAGE })

const unanswered: ModelCompleteResult = { isAnswered: false, reason: 'empty-reply', usage: USAGE }

type World = {
  env?: Readonly<Record<string, string>>
  // What the indexer lists; a test changes it between ticks
  sessions?: readonly Indexed[]
  skipped?: number
  // What the indexer answers in place of the list; a function stands for a python3 that cannot start
  indexer?: ProcessRunResult | (() => never)
  tmux?: ProcessRunResult | (() => never)
  // What the model answers to a digest; by default `Summary: <digest>`. A `deny` is a call the
  // engine refuses to send: `$.model.complete` rejects with it
  model?: (digest: string) => ModelCompleteResult | { deny: string } | Promise<ModelCompleteResult>
  // How long the indexer takes, on the mocked clock
  indexerMs?: number
  // What $.store holds at the start
  store?: Readonly<Record<string, unknown>>
  // How the floating window ends: its exit code, what it wrote to stderr, how long it stayed open
  // on the mocked clock; `deny` stands for a python3 that cannot start. By default it ends at
  // once with the code of «no fzf», so the mod falls back to its pane: what most tests look at
  popup?: { code: number; says?: string; ms?: number } | { deny: string }
}

// The engine's side of every test: the environment, the clock, the host's commands, the model, the
// store, the surface. The hooks are registered once, before the test's first `$` call; a test that
// changes what a command answers midway changes `world`, which is read at each call
const stubEngine = (on: Parameters<TestBody>[1], world: World = {}) => {
  const seen = {
    argv: [] as string[][],
    toasts: [] as string[],
    logs: [] as { text: string; to?: string }[],
    closed: [] as string[],
    opened: [] as unknown[],
    asked: [] as { model: string; system?: string; prompt: string; maxTokens?: number; timeoutMs?: number }[],
    store: new Map<string, unknown>(Object.entries(world.store ?? {})),
    isOpen: false,
    // Indexers running now, and the most that ran at once
    running: 0,
    mostRunning: 0,
    // How many times the mod asked which panes are open: once a tick while its timer runs
    panesAsked: 0,
    // The floating windows started, by their argument vectors, and the files written for them
    spawned: [] as string[][],
    files: [] as { path: string; text: string }[],
  }

  mock.env(on, world.env ?? { HOME: '/home/u', TMUX: '/tmp/tmux-1000/default,1,0', XDG_RUNTIME_DIR: '/run/user/1000' })
  const clock = mock.clock(on, { now: NOW })
  on('session.id', () => ({ value: 'here' }))
  on('ui.open', ($, e) => {
    seen.opened.push(e)
    seen.isOpen = true

    return { value: { isPlaced: true } }
  })
  on('ui.close', ($, e) => {
    seen.closed.push(e.id)
    seen.isOpen = false

    return { value: undefined }
  })
  on('ui.panes', () => {
    seen.panesAsked += 1

    return {
      value: seen.isOpen
        ? [{ id: 'board', title: 'Active sessions', isShown: true, isFocused: true, isPlaced: true }]
        : [],
    }
  })
  // The ring moves where it is asked to: nothing beneath the mod keeps it
  on('ui.focus', () => ({}))
  on('ui.toast', ($, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.log', ($, e) => {
    seen.logs.push({ text: e.text, to: e.to })

    return { value: undefined }
  })
  on('process.run', async ($, e) => {
    seen.argv.push([...e.argv])

    if (e.argv[0] !== 'python3') {
      const answer = world.tmux ?? ran({})

      return { value: typeof answer === 'function' ? answer() : answer }
    }

    if (world.indexerMs !== undefined) {
      seen.running += 1
      seen.mostRunning = Math.max(seen.mostRunning, seen.running)
      await clock.sleep(world.indexerMs)
      seen.running -= 1
    }

    const answer =
      world.indexer ??
      ran({ stdout: JSON.stringify({ sessions: world.sessions ?? ALL, skipped: world.skipped ?? 0 }) })

    return { value: typeof answer === 'function' ? answer() : answer }
  })
  on('process.spawn', async function* ($, e) {
    seen.spawned.push([...e.argv])
    const popup = world.popup ?? { code: 4, says: 'No fzf: the floating window is drawn by it\n' }

    if ('deny' in popup) {
      return popup
    }

    if (popup.says !== undefined) {
      yield { stream: 'stderr', text: popup.says } as const
    }

    if (popup.ms !== undefined) {
      await clock.sleep(popup.ms)
    }

    return { value: { code: popup.code, signal: null } }
  })
  on('fs.write', ($, e) => {
    seen.files.push({ path: e.path, text: e.text })

    return { value: undefined }
  })
  // The editor beneath the mod: it applies the edit to the draft
  on('prompt.edit', ($, e) => ({
    text: e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end),
    cursor: e.start + e.inputText.length,
  }))
  on('model.complete', async ($, e) => {
    seen.asked.push({ ...e })
    const answer = await (world.model ?? (digest => said(`Summary: ${digest}`)))(e.prompt)

    return 'deny' in answer ? answer : { value: answer }
  })
  on('store.keys', () => ({ value: [...seen.store.keys()] }))
  on('store.get', ($, e) => ({ value: seen.store.get(e.key) }))
  on('store.set', ($, e) => {
    seen.store.set(e.key, e.value)

    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    seen.store.delete(e.key)

    return { value: undefined }
  })

  return { seen, clock }
}

const cannotStart = (): never => {
  throw new Error('spawn ENOENT')
}

// How many times the indexer ran
const indexed = (seen: { argv: string[][] }): number => seen.argv.filter(argv => argv[0] === 'python3').length

// What the mod said to the debug log about summaries; the floating window's own lines aside
const summaryLogs = (seen: { logs: { text: string; to?: string }[] }) =>
  seen.logs.filter(log => log.text.startsWith('session-board: no summary'))

// The digests the model was asked over, in the order asked
const digests = (seen: { asked: { prompt: string }[] }): string[] => seen.asked.map(one => one.prompt)

// What the helpers below read of a mounted pane
type Drawn = {
  drawn: () => Promise<unknown>
  find: (query: {
    type?: string
    key?: string
    text?: string | RegExp
  }) => Promise<{ props: Record<string, unknown> } | undefined>
}

// The ids of the session rows on screen, top to bottom
const rowsOf = async (ui: Drawn): Promise<string[]> =>
  [...JSON.stringify(await ui.drawn()).matchAll(/"key":"go-([^"]+)"/g)].map(match => match[1] ?? '')

const textOf = async (ui: Drawn, text: string | RegExp) => ui.find({ type: 'Text', text })

// A whole line of the preview, or a label in it: `you` alone, not a word that holds it
const lineOf = async (ui: Drawn, text: string) =>
  ui.find({ type: 'Text', text: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })

// The id of the row drawn under the selection bar
const selectedRow = async (ui: Drawn): Promise<string | undefined> =>
  /"backgroundColor":"selectionBg".*?"key":"go-([^"]+)"/.exec(JSON.stringify(await ui.drawn()))?.[1]

// The title drawn on the preview's frame: the last accented bold text, drawn after the frame
const previewTitle = async (ui: Drawn): Promise<string | undefined> =>
  [...JSON.stringify(await ui.drawn()).matchAll(/"color":"claude","bold":true\},"children":\["([^"]*)"\]/g)].pop()?.[1]

// The person moves a pane's focus ring onto a row, or onto the search field. The event as the
// engine raises it for a move by Tab or the arrows: the kit hands a `$.ui.focus` argument to the
// hooks as it is, so the test gives it the engine's shape
const ring = async ($: Parameters<TestBody>[0], key: string, pane = 'board') =>
  $.ui.focus({
    component: 'Pane',
    requestId: pane,
    plugin: 'session-board',
    element: key,
    origin: { kind: 'person' },
  } as never)

const buttonOf = async (ui: Drawn, id: string) => (await ui.find({ key: `go-${id}` }))?.props

// The prompt box of the test's engine: `prompt.edit` is the engine's own event, which the kit lets
// a test raise though the noun's type does not list it
type Composer = { edit: (edit: Record<string, unknown>) => Promise<{ text: string; cursor: number }> }

// One key typed into the prompt, as the engine raises it for the person at the composer
const typed = async ($: Parameters<TestBody>[0], draft: string, inputText: string) =>
  ($.prompt as unknown as Composer).edit({
    origin: { kind: 'composer' },
    key: { key: inputText === ' ' ? 'space' : inputText },
    text: draft,
    cursor: draft.length,
    start: draft.length,
    end: draft.length,
    inputText,
  })

// The floating window as the mod starts it for a session `here` with the default threshold
const POPUP_ARGV = [
  'python3',
  expect.stringMatching(/\/hooks\/board_popup\.py$/),
  'run',
  '--config',
  '/home/u/.claude',
  '--summaries',
  '/run/user/1000/session-board/summaries.json',
  '--current',
  'here',
  '--stale-minutes',
  '10',
]

// /board, with the summaries it started let to arrive
const open = async ($: Parameters<TestBody>[0], clock: MockClock) => {
  const answer = await $.command.run(run)
  await clock.settle()

  return answer
}

test('session.start registers the /board command and starts no timer', async ($, on) => {
  const { seen, clock } = stubEngine(on)
  const registered: string[] = []
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($, e) => {
    registered.push(e.name)

    return { value: { command: e.name } }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(3 * TICK)

  expect(registered).toEqual(['board'])
  expect(seen.argv).toEqual([])
})

test('/board runs the indexer over the configuration folder and opens a focused pane, asking for its width', async ($, on) => {
  const { seen, clock } = stubEngine(on)

  const answer = await open($, clock)

  expect(answer.text).toBe('Active sessions: 4')
  expect(seen.argv.length).toBe(1)
  expect(seen.argv[0]?.[0]).toBe('python3')
  expect(seen.argv[0]?.[1]).toMatch(/\/hooks\/index_live\.py$/)
  expect(seen.argv[0]?.[2]).toBe('/home/u/.claude')
  expect(seen.opened).toEqual([{ id: 'board', title: 'Active sessions', focus: true, closeOnEscape: true, columns: 110, rows: 18 }])
})

test('a pane of many sessions asks for more rows', async ($, on) => {
  const many = Array.from({ length: 20 }, (unused, index) => ({ ...WAIT, id: `s${index}`, pid: index + 1 }))
  const { seen, clock } = stubEngine(on, { sessions: many, model: () => unanswered })

  await open($, clock)

  // Twenty rows, the search field, the rule and the two borders
  expect(seen.opened).toEqual([{ id: 'board', title: 'Active sessions', focus: true, closeOnEscape: true, columns: 110, rows: 24 }])
})

test('CLAUDE_CONFIG_DIR moves the configuration folder', async ($, on) => {
  const { seen, clock } = stubEngine(on, { env: { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/data/claude' } })

  await open($, clock)

  expect(seen.argv[0]?.[2]).toBe('/data/claude')
})

test('the list: the waiting first, then the working, then the stale, each row its mark and its age', async ($, on) => {
  const { clock } = stubEngine(on)
  await open($, clock)

  const ui = await $.ui.mount(pane())

  expect(await rowsOf(ui)).toEqual(['wait', 'work', 'old', 'here'])
  expect((await textOf(ui, '● '))?.props.color).toBe('claude')
  expect((await textOf(ui, '◐ '))?.props.color).toBe('success')
  expect((await textOf(ui, '○ '))?.props.color).toBe('inactive')
  expect((await lineOf(ui, '  3 min '))?.props.color).toBe('inactive')
  expect(await lineOf(ui, ' 42 min ')).toBeDefined()
  expect(await lineOf(ui, '    2 h ')).toBeDefined()
  expect(await lineOf(ui, '    5 h ')).toBeDefined()
})

test('the two frames: the list with the search field and the counter, the preview with the session on its title', async ($, on) => {
  const { clock } = stubEngine(on)
  await open($, clock)

  const ui = await $.ui.mount(pane())
  const drawn = JSON.stringify(await ui.drawn())

  // A list frame of 50 and a preview frame of 60, both rounded, side by side
  expect(drawn.match(/"borderStyle":"round","borderColor":"promptBorder","width":50/g)?.length).toBe(1)
  expect(drawn.match(/"borderStyle":"round","borderColor":"promptBorder","width":60/g)?.length).toBe(1)
  // Side by side, and as tall as the fullest preview: the frames do not jump from session to session
  expect(drawn.startsWith('{"type":"Box","props":{"flexDirection":"row","minHeight":26}')).toBe(true)
  expect((await lineOf(ui, ' Active sessions '))?.props).toMatchObject({ color: 'claude', bold: true })
  expect(await previewTitle(ui)).toBe(' PROJ-1532 collision spec draft ')
  expect((await lineOf(ui, '4/4 '))?.props.color).toBe('subtle')
  expect((await lineOf(ui, ' > '))?.props.color).toBe('claude')
  expect((await ui.find({ key: 'query' }))?.props).toMatchObject({
    value: '',
    placeholder: 'search',
    submitLabel: 'go',
    autoFocus: true,
  })
  // The rule under the search field, as wide as the frame is inside
  expect((await lineOf(ui, '─'.repeat(48)))?.props.color).toBe('promptBorder')
})

test('a row is the selection bar, the mark, the title with its digit, the age', async ($, on) => {
  const { clock } = stubEngine(on)
  await open($, clock)

  const ui = await $.ui.mount(pane())

  expect(await buttonOf(ui, 'wait')).toMatchObject({ label: 'PROJ-1532 collision spec draft', hotkey: '1', plain: true })
  expect(await buttonOf(ui, 'work')).toMatchObject({ label: 'Save the Claude sessions', hotkey: '2', plain: true })
  // A stale row is dim, a highlighted one is not
  expect((await buttonOf(ui, 'old'))?.dimColor).toBe(true)
  expect((await buttonOf(ui, 'wait'))?.dimColor).toBe(false)
})

test('the first nine rows get a digit; the search field, not a row, takes the focus', async ($, on) => {
  const many = Array.from({ length: 11 }, (unused, index) => ({
    ...WAIT,
    id: `s${index}`,
    pid: index + 1,
    statusSinceMs: NOW - index * 1_000,
  }))
  const { clock } = stubEngine(on, { sessions: many, model: () => unanswered })
  await open($, clock)

  const ui = await $.ui.mount(pane())

  expect((await buttonOf(ui, 's0'))?.hotkey).toBe('1')
  expect((await buttonOf(ui, 's8'))?.hotkey).toBe('9')
  expect((await buttonOf(ui, 's9'))?.hotkey).toBeUndefined()
  expect((await buttonOf(ui, 's10'))?.hotkey).toBeUndefined()
  expect((await buttonOf(ui, 's0'))?.autoFocus).toBeUndefined()
  expect((await ui.find({ key: 'query' }))?.props.autoFocus).toBe(true)
})

test('the preview shows the first row while the ring is on the search field', async ($, on) => {
  const { clock } = stubEngine(on, { model: () => unanswered })
  await open($, clock)

  const ui = await $.ui.mount(pane())

  expect(await selectedRow(ui)).toBe('wait')
  expect(await previewTitle(ui)).toBe(' PROJ-1532 collision spec draft ')
  expect((await lineOf(ui, '● waiting for you 3 min'))?.props).toMatchObject({ color: 'claude', bold: true })
  expect((await lineOf(ui, '~/work/billing-api'))?.props.color).toBe('suggestion')
  expect((await lineOf(ui, 'tmux memory:@4.%4'))?.props.color).toBe('subtle')
  expect((await lineOf(ui, 'you'))?.props.color).toBe('subtle')
  expect(await lineOf(ui, 'remove the traces and fix the list')).toBeDefined()
  expect((await lineOf(ui, 'agent'))?.props.color).toBe('subtle')
  expect(await lineOf(ui, 'Done: 14 edits, the tests are green.')).toBeDefined()
  // Nothing of the other sessions
  expect(await lineOf(ui, 'make a mod for the active sessions')).toBeUndefined()
  expect(await lineOf(ui, 'now')).toBeUndefined()
})

test('the preview follows the ring from row to row, and the selection bar with it', async ($, on) => {
  const { clock } = stubEngine(on, { model: () => unanswered })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ring($, 'go-work')

  expect(await selectedRow(ui)).toBe('work')
  expect(await previewTitle(ui)).toBe(' Save the Claude sessions ')
  expect((await lineOf(ui, '◐ working 42 min'))?.props.color).toBe('success')
  expect(await lineOf(ui, '~/github/claude-mods')).toBeDefined()
  expect(await lineOf(ui, 'make a mod for the active sessions')).toBeDefined()
  // `work` runs a tool, and that is said above its last reply
  expect(await lineOf(ui, 'now')).toBeDefined()
  expect(await lineOf(ui, 'Bash')).toBeDefined()
  expect(await lineOf(ui, 'Writing the indexer.')).toBeDefined()
  expect(await lineOf(ui, 'remove the traces and fix the list')).toBeUndefined()

  // Back on the search field: the first row again
  await ring($, 'query')

  expect(await selectedRow(ui)).toBe('wait')
  expect(await previewTitle(ui)).toBe(' PROJ-1532 collision spec draft ')
})

test('exactly one row is under the selection bar', async ($, on) => {
  const { clock } = stubEngine(on, { model: () => unanswered })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ring($, 'go-old')
  const drawn = JSON.stringify(await ui.drawn())

  expect(drawn.match(/"backgroundColor":"selectionBg"/g)?.length).toBe(1)
  expect(drawn.match(/"children":\["▌"\]/g)?.length).toBe(1)
  expect(await selectedRow(ui)).toBe('old')
})

test('a stale session has a preview too: what was asked and what the agent last said', async ($, on) => {
  const { clock } = stubEngine(on, { model: () => unanswered })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ring($, 'go-old')

  expect(await previewTitle(ui)).toBe(' ETL v1->v2: spec review ')
  expect((await lineOf(ui, '○ waiting 2 h'))?.props.color).toBe('inactive')
  expect(await lineOf(ui, 'look at the spec')).toBeDefined()
  expect(await lineOf(ui, 'The spec is fine.')).toBeDefined()
})

test('a prompt and a reply wider than the preview are wrapped to it', async ($, on) => {
  const words = (word: string) => Array.from({ length: 12 }, () => word).join(' ')
  const wordy: Indexed = { ...WAIT, lastPrompt: words('prompt'), lastReply: words('reply') }
  const { clock } = stubEngine(on, { sessions: [wordy], model: () => unanswered })
  await open($, clock)

  // A preview frame of 60: 2 of borders and 2 of padding leave the text 56
  const ui = await $.ui.mount(pane())

  expect(await lineOf(ui, 'prompt prompt prompt prompt prompt prompt prompt prompt')).toBeDefined()
  expect(await lineOf(ui, 'prompt prompt prompt prompt')).toBeDefined()
  expect(await lineOf(ui, 'reply reply reply reply reply reply reply reply reply')).toBeDefined()
  expect(await lineOf(ui, 'reply reply reply')).toBeDefined()
})

test('a session with nothing said in it says so in the preview, and the model is not asked', async ($, on) => {
  const fresh: Indexed = { ...WAIT, id: 'fresh', title: 'New session', lastPrompt: null, lastReply: null, stamp: null, digest: null }
  const { seen, clock } = stubEngine(on, { sessions: [fresh] })
  await open($, clock)

  const ui = await $.ui.mount(pane())

  expect((await buttonOf(ui, 'fresh'))?.label).toBe('New session')
  expect((await lineOf(ui, 'Nothing has been asked in this session yet'))?.props.color).toBe('subtle')
  expect(await lineOf(ui, 'you')).toBeUndefined()
  expect(await lineOf(ui, 'agent')).toBeUndefined()
  expect(seen.asked).toEqual([])
})

test('the session the pane is open in is marked', async ($, on) => {
  const { clock } = stubEngine(on)
  await open($, clock)

  const ui = await $.ui.mount(pane())

  expect((await buttonOf(ui, 'here'))?.label).toBe('VPN autostart (this)')
  expect((await buttonOf(ui, 'old'))?.label).toBe('ETL v1->v2: spec review')
})

test('a status the mod does not know is shown as the word, and waits like an idle one', async ($, on) => {
  const asking: Indexed = { ...WAIT, id: 'asking', status: 'blocked', statusSinceMs: NOW - 2 * MINUTE }
  const { clock } = stubEngine(on, { sessions: [asking] })
  await open($, clock)

  const ui = await $.ui.mount(pane())

  expect((await lineOf(ui, '● blocked 2 min'))?.props.color).toBe('claude')
  expect((await textOf(ui, '● '))?.props.color).toBe('claude')
})

test('a title wider than its row and its frame is cut to each, a path from its start', async ($, on) => {
  const long: Indexed = {
    ...WAIT,
    id: 'long',
    title: 'A very long title of a session that fits neither a row of the list nor the frame of the preview',
    cwd: '/home/u/work/acme/platform/memory/billing-payments-importer/internal/storage/postgres',
  }
  const { clock } = stubEngine(on, { sessions: [long] })
  await open($, clock)

  const ui = await $.ui.mount(pane())

  // A row's title has 37 cells in a list frame of 50, 3 of them the digit
  expect((await buttonOf(ui, 'long'))?.label).toBe('A very long title of a session th…')
  // The frame's title: 60 cells less the corners, a dash and a space each side
  expect(await previewTitle(ui)).toBe(' A very long title of a session that fits neither a ro… ')
  // The path, 79 cells long, in the preview's 56
  expect(await lineOf(ui, '…ory/billing-payments-importer/internal/storage/postgres')).toBeDefined()
})

test('a pane shorter than the fullest preview gives the frames what it has', async ($, on) => {
  const { clock } = stubEngine(on)
  await open($, clock)

  const ui = await $.ui.mount(pane(110, 14))

  expect(JSON.stringify(await ui.drawn()).startsWith('{"type":"Box","props":{"flexDirection":"row","minHeight":14}')).toBe(true)
})

test('a narrow pane puts the preview under the list, each as wide as the pane', async ($, on) => {
  const { clock } = stubEngine(on)
  await open($, clock)

  const ui = await $.ui.mount(pane(60))
  const drawn = JSON.stringify(await ui.drawn())

  // Stacked frames are each as tall as what they hold
  expect(drawn.startsWith('{"type":"Box","props":{"flexDirection":"column"}')).toBe(true)
  expect(drawn.match(/"borderStyle":"round","borderColor":"promptBorder","width":60/g)?.length).toBe(2)
  expect(await rowsOf(ui)).toEqual(['wait', 'work', 'old', 'here'])
  // 60 cells: a row's title has 47, 3 of them the digit
  expect((await buttonOf(ui, 'wait'))?.label).toBe('PROJ-1532 collision spec draft')
  expect(await lineOf(ui, '● waiting for you 3 min')).toBeDefined()
})

test('registry files the indexer skipped are counted beside the counter', async ($, on) => {
  const { clock } = stubEngine(on, { skipped: 3 })
  await open($, clock)

  const ui = await $.ui.mount(pane())

  expect(await lineOf(ui, '4/4 · skipped 3 ')).toBeDefined()
})

test('no live sessions is said in one line', async ($, on) => {
  const { seen, clock } = stubEngine(on, { sessions: [] })
  await open($, clock)

  const ui = await $.ui.mount(pane())

  expect(await textOf(ui, 'No active sessions')).toBeDefined()
  expect(await ui.find({ key: 'query' })).toBeUndefined()
  expect(seen.opened).toEqual([{ id: 'board', title: 'Active sessions', focus: true, closeOnEscape: true, columns: 110, rows: 18 }])
})

test('typing in the search field narrows the list at once, by title, directory or prompt', async ($, on) => {
  const { clock } = stubEngine(on, { model: () => unanswered })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.input({ key: 'query', text: 'SPEC 1532', kind: 'change' })
  expect(await rowsOf(ui)).toEqual(['wait'])
  expect(await lineOf(ui, '1/4 ')).toBeDefined()
  expect((await ui.find({ key: 'query' }))?.props.value).toBe('SPEC 1532')

  await ui.input({ key: 'query', text: 'billing-api', kind: 'change' })
  expect(await rowsOf(ui)).toEqual(['wait', 'old'])

  await ui.input({ key: 'query', text: 'vpn', kind: 'change' })
  expect(await rowsOf(ui)).toEqual(['here'])

  await ui.input({ key: 'query', text: '', kind: 'change' })
  expect(await rowsOf(ui)).toEqual(['wait', 'work', 'old', 'here'])
  expect(await lineOf(ui, '4/4 ')).toBeDefined()
})

test('a row the search let through keeps its digit, and the preview shows the first of them', async ($, on) => {
  const { clock } = stubEngine(on, { model: () => unanswered })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.input({ key: 'query', text: 'spec', kind: 'change' })

  expect(await rowsOf(ui)).toEqual(['wait', 'old'])
  expect((await buttonOf(ui, 'old'))?.hotkey).toBe('3')
  expect(await selectedRow(ui)).toBe('wait')

  await ui.input({ key: 'query', text: 'etl', kind: 'change' })

  expect(await selectedRow(ui)).toBe('old')
  expect(await previewTitle(ui)).toBe(' ETL v1->v2: spec review ')
})

test('Enter in the search field goes to the first session found', async ($, on) => {
  const { seen, clock } = stubEngine(on, { model: () => unanswered })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.input({ key: 'query', text: 'claude', kind: 'change' })
  await ui.input({ key: 'query', text: 'claude' })

  expect(seen.argv[1]).toEqual(['tmux', 'switch-client', '-t', '%7'])
  expect(seen.closed).toEqual(['board'])
})

test('Enter in an empty search field goes to the first row', async ($, on) => {
  const { seen, clock } = stubEngine(on, { model: () => unanswered })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.input({ key: 'query', text: '' })

  expect(seen.argv[1]).toEqual(['tmux', 'switch-client', '-t', '%4'])
})

test('a search that finds nothing says so, shows no preview of a session, and Enter does nothing', async ($, on) => {
  const { seen, clock } = stubEngine(on, { model: () => unanswered })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.input({ key: 'query', text: 'no such thing', kind: 'change' })

  expect(await rowsOf(ui)).toEqual([])
  expect(await lineOf(ui, '0/4 ')).toBeDefined()
  expect((await lineOf(ui, ' Nothing found'))?.props.color).toBe('subtle')
  expect(await previewTitle(ui)).toBe(' Session ')
  expect(await lineOf(ui, '● waiting for you 3 min')).toBeUndefined()

  await ui.input({ key: 'query', text: 'no such thing' })

  expect(seen.argv.length).toBe(1)
  expect(seen.closed).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('a new /board clears the search and puts the selection back on the first row', async ($, on) => {
  const { clock } = stubEngine(on, { model: () => unanswered })
  await open($, clock)
  const first = await $.ui.mount(pane())
  await first.input({ key: 'query', text: 'vpn', kind: 'change' })
  await ring($, 'go-here')
  expect(await rowsOf(first)).toEqual(['here'])
  await first.unmount()

  await open($, clock)
  const ui = await $.ui.mount(pane())

  expect(await rowsOf(ui)).toEqual(['wait', 'work', 'old', 'here'])
  expect((await ui.find({ key: 'query' }))?.props.value).toBe('')
  expect(await selectedRow(ui)).toBe('wait')
})

test('the ring of another pane does not move the selection', async ($, on) => {
  const { clock } = stubEngine(on, { model: () => unanswered })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ring($, 'go-work', 'sessions')

  expect(await selectedRow(ui)).toBe('wait')
})

test('the mobile surface, which has no text field, is left to the engine', async ($, on) => {
  const { clock } = stubEngine(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  await open($, clock)

  const ui = await $.ui.mount({ ...pane(), surface: 'mobile' })

  expect(await textOf(ui, 'drawn by Claude Code')).toBeDefined()
  expect(await rowsOf(ui)).toEqual([])
})

test('a python3 that cannot start is said in the pane, not in the command output, and nothing is refreshed', async ($, on) => {
  const { seen, clock } = stubEngine(on, { indexer: cannotStart })

  const answer = await open($, clock)
  const ui = await $.ui.mount(pane())
  await clock.advance(3 * TICK)

  expect(answer.text).toBeUndefined()
  expect(await textOf(ui, /^Could not start python3: /)).toBeDefined()
  expect(await rowsOf(ui)).toEqual([])
  expect(seen.toasts).toEqual([])
  expect(indexed(seen)).toBe(1)
  expect(seen.asked).toEqual([])
})

test('an indexer that fails shows the first line of its stderr', async ($, on) => {
  const { clock } = stubEngine(on, {
    indexer: ran({ exitCode: 2, stderr: 'No session registry: /home/u/.claude/sessions\none more line\n' }),
  })
  await open($, clock)

  const ui = await $.ui.mount(pane())

  expect(await textOf(ui, 'No session registry: /home/u/.claude/sessions')).toBeDefined()
})

test('an indexer that fails silently still says something', async ($, on) => {
  const { clock } = stubEngine(on, { indexer: ran({ exitCode: 1 }) })
  await open($, clock)

  const ui = await $.ui.mount(pane())

  expect(await textOf(ui, 'The indexer exited with code 1')).toBeDefined()
})

test('output that is not a list, or is cut, is called unreadable', async ($, on) => {
  const world: World = {}
  const { clock } = stubEngine(on, world)

  for (const indexer of [
    ran({ stdout: 'Traceback (most recent call last)' }),
    ran({ stdout: '' }),
    ran({ stdout: JSON.stringify({ sessions: ALL, skipped: 0 }), isStdoutTruncated: true }),
  ]) {
    world.indexer = indexer
    await open($, clock)

    const ui = await $.ui.mount(pane())

    expect(await textOf(ui, 'The indexer printed something unreadable')).toBeDefined()
    await ui.unmount()
  }
})

test('without HOME the pane says where the trouble is and runs nothing', async ($, on) => {
  const { seen, clock } = stubEngine(on, { env: {} })
  await open($, clock)

  const ui = await $.ui.mount(pane())

  expect(await textOf(ui, /^HOME is not set/)).toBeDefined()
  expect(seen.argv).toEqual([])
})

test('a failure is gone after the next successful /board', async ($, on) => {
  const world: World = { indexer: ran({ exitCode: 1, stderr: 'broken' }) }
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)
  const broken = await $.ui.mount(pane())
  expect(await textOf(broken, 'broken')).toBeDefined()
  await broken.unmount()

  world.indexer = undefined
  await open($, clock)
  const ui = await $.ui.mount(pane())

  expect(await rowsOf(ui)).toEqual(['wait', 'work', 'old', 'here'])
  expect(seen.toasts).toEqual([])
})

test('picking a session brings the tmux client to its pane, closes the board and stops the refresh', async ($, on) => {
  const { seen, clock } = stubEngine(on)
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.press({ key: 'go-work' })
  const asked = seen.panesAsked
  await clock.advance(3 * TICK)

  expect(seen.argv[1]).toEqual(['tmux', 'switch-client', '-t', '%7'])
  expect(seen.closed).toEqual(['board'])
  expect(seen.toasts).toEqual([])
  expect(indexed(seen)).toBe(1)
  // The timer is cancelled at the press: not one tick more looks for the pane
  expect(seen.panesAsked).toBe(asked)
})

test('a stale session is picked like any other', async ($, on) => {
  const { seen, clock } = stubEngine(on)
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.press({ key: 'go-old' })

  expect(seen.argv[1]).toEqual(['tmux', 'switch-client', '-t', '%2'])
  expect(seen.closed).toEqual(['board'])
})

test('the current session is not gone to', async ($, on) => {
  const { seen, clock } = stubEngine(on)
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.press({ key: 'go-here' })

  expect(seen.argv.length).toBe(1)
  expect(seen.closed).toEqual([])
  expect(seen.toasts).toEqual(['You are already in this session'])
})

test('a session that runs outside tmux cannot be gone to', async ($, on) => {
  const { seen, clock } = stubEngine(on, { sessions: [{ ...WAIT, tmuxPane: null, tmuxTarget: null }, HERE] })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.press({ key: 'go-wait' })

  expect(seen.argv.length).toBe(1)
  expect(seen.closed).toEqual([])
  expect(seen.toasts).toEqual(['This session is not in tmux: cannot go to it'])
})

test('outside tmux the toast names the window, and the pane stays', async ($, on) => {
  const world: World = { env: { HOME: '/home/u' } }
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.press({ key: 'go-work' })

  expect(seen.argv.length).toBe(1)
  expect(seen.closed).toEqual([])
  expect(seen.toasts).toEqual(['Not in tmux. The session is at HOME:@7.%7'])
})

test('an empty TMUX is outside tmux too', async ($, on) => {
  const { seen, clock } = stubEngine(on, { env: { HOME: '/home/u', TMUX: '' } })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.press({ key: 'go-wait' })

  expect(seen.toasts).toEqual(['Not in tmux. The session is at memory:@4.%4'])
})

test('a tmux that fails leaves the pane open, says why, and the refresh goes on', async ($, on) => {
  const { seen, clock } = stubEngine(on, { tmux: ran({ exitCode: 1, stderr: "can't find pane: %7\n" }) })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.press({ key: 'go-work' })
  await clock.advance(TICK)

  expect(seen.closed).toEqual([])
  expect(seen.toasts).toEqual(["tmux: can't find pane: %7"])
  expect(indexed(seen)).toBe(2)
})

test('a tmux that fails silently, or cannot start, still says something', async ($, on) => {
  const world: World = { tmux: ran({ exitCode: 3 }) }
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await ui.press({ key: 'go-work' })
  world.tmux = cannotStart
  await ui.press({ key: 'go-work' })

  expect(seen.closed).toEqual([])
  expect(seen.toasts[0]).toBe('tmux: code 3')
  expect(seen.toasts[1]).toMatch(/^tmux: /)
  expect(seen.toasts.length).toBe(2)
})

test('while the pane is open the list is collected again every five seconds', async ($, on) => {
  const world: World = {}
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await clock.advance(TICK - 1)
  expect(indexed(seen)).toBe(1)
  expect(await textOf(ui, '◐ ')).toBeDefined()

  // The agent of `work` stopped a second ago; `wait` has waited five seconds more
  world.sessions = [WAIT, { ...WORK, status: 'idle', statusSinceMs: NOW + TICK - 1_000 }, OLD, HERE]
  await clock.advance(1)

  expect(indexed(seen)).toBe(2)
  expect(await textOf(ui, '◐ ')).toBeUndefined()
  expect(await lineOf(ui, ' <1 min ')).toBeDefined()
  expect(await lineOf(ui, '  3 min ')).toBeDefined()

  await clock.advance(2 * TICK)
  expect(indexed(seen)).toBe(4)
})

test('a session keeps its place and its digit when its state changes', async ($, on) => {
  const world: World = {}
  const { clock } = stubEngine(on, world)
  await open($, clock)
  const ui = await $.ui.mount(pane())

  // `old` came back to work, `wait` went stale: by the first order they would swap ends
  world.sessions = [{ ...WAIT, statusSinceMs: NOW - HOUR }, WORK, { ...OLD, status: 'busy', statusSinceMs: NOW }, HERE]
  await clock.advance(TICK)

  expect(await rowsOf(ui)).toEqual(['wait', 'work', 'old', 'here'])
  expect((await buttonOf(ui, 'wait'))?.hotkey).toBe('1')
  expect((await buttonOf(ui, 'old'))?.hotkey).toBe('3')
  expect((await buttonOf(ui, 'wait'))?.dimColor).toBe(true)
  expect((await buttonOf(ui, 'old'))?.dimColor).toBe(false)
  // The preview of `wait`, still the first row, says what it is now
  expect(await lineOf(ui, '○ waiting 1 h')).toBeDefined()
})

test('a session that ended leaves its digit unused, and a new one goes last', async ($, on) => {
  const world: World = {}
  const { clock } = stubEngine(on, world)
  await open($, clock)
  const ui = await $.ui.mount(pane())
  const fresh: Indexed = { ...WAIT, id: 'fresh', pid: 5, statusSinceMs: NOW }

  // By pid the new session is listed first
  world.sessions = [fresh, WORK, OLD, HERE]
  await clock.advance(TICK)

  expect(await rowsOf(ui)).toEqual(['work', 'old', 'here', 'fresh'])
  expect((await buttonOf(ui, 'work'))?.hotkey).toBe('2')
  expect((await buttonOf(ui, 'old'))?.hotkey).toBe('3')
  expect((await buttonOf(ui, 'here'))?.hotkey).toBe('4')
  expect((await buttonOf(ui, 'fresh'))?.hotkey).toBe('5')
  // The first row drawn is the one selected, whatever its digit
  expect(await selectedRow(ui)).toBe('work')
})

test('a new /board pins the order anew, and the refresh is not doubled', async ($, on) => {
  const world: World = {}
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)

  world.sessions = [{ ...WAIT, statusSinceMs: NOW - HOUR }, WORK, OLD, HERE]
  await open($, clock)
  const ui = await $.ui.mount(pane())

  expect(await rowsOf(ui)).toEqual(['work', 'wait', 'old', 'here'])
  expect((await buttonOf(ui, 'work'))?.hotkey).toBe('1')

  await clock.advance(TICK)
  expect(indexed(seen)).toBe(3)
})

test('the refresh stops once the person has closed the pane', async ($, on) => {
  const { seen, clock } = stubEngine(on)
  await open($, clock)
  await clock.advance(TICK)
  expect(indexed(seen)).toBe(2)

  // Esc: the engine closes the pane, and no hook of the mod hears of it
  seen.isOpen = false
  await clock.advance(TICK)
  const asked = seen.panesAsked
  await clock.advance(4 * TICK)

  expect(indexed(seen)).toBe(2)
  // The tick that found the pane gone cancelled the timer: no tick after it looks again
  expect(seen.panesAsked).toBe(asked)
})

test('a refresh that fails leaves the pane as it was and says why to the debug log', async ($, on) => {
  const world: World = { model: () => unanswered }
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)
  const ui = await $.ui.mount(pane())
  seen.logs.length = 0

  world.indexer = ran({ exitCode: 1, stderr: 'broken' })
  await clock.advance(TICK)

  expect(await rowsOf(ui)).toEqual(['wait', 'work', 'old', 'here'])
  expect(await textOf(ui, 'broken')).toBeUndefined()
  expect(seen.logs).toEqual([{ text: 'session-board: list not refreshed: broken', to: 'debug' }])
  expect(seen.toasts).toEqual([])

  world.indexer = undefined
  world.sessions = [WAIT]
  await clock.advance(TICK)

  expect(await rowsOf(ui)).toEqual(['wait'])
})

test('a module reloaded under an open pane picks the refresh up again', async ($, on) => {
  const { seen, clock } = stubEngine(on)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // The pane stayed up while the module was replaced
  seen.isOpen = true

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.advance(TICK)

  expect(indexed(seen)).toBe(1)
})

test('a slow indexer is not started a second time over itself', async ($, on) => {
  const world: World = {}
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)

  // From now on the indexer takes twelve seconds: two ticks pass while it runs
  world.indexerMs = 12_000
  await clock.advance(6 * TICK)

  expect(seen.mostRunning).toBe(1)
  // Started at 5 s and, once that one ended at 17 s, at 20 s
  expect(indexed(seen)).toBe(3)
})

test('staleMinutes moves the threshold', { options: { staleMinutes: 180 } }, async ($, on) => {
  const { clock } = stubEngine(on)
  await open($, clock)
  const ui = await $.ui.mount(pane())

  // `old` has waited two hours: under three it is still highlighted
  expect((await buttonOf(ui, 'old'))?.dimColor).toBe(false)
  expect((await buttonOf(ui, 'here'))?.dimColor).toBe(true)

  await ring($, 'go-old')

  expect(await lineOf(ui, '● waiting for you 2 h')).toBeDefined()
})

test('a staleMinutes that is no threshold is ten minutes', { options: { staleMinutes: 0 } }, async ($, on) => {
  const { clock } = stubEngine(on, { sessions: [{ ...WAIT, statusSinceMs: NOW - 10 * MINUTE }, { ...OLD, statusSinceMs: NOW - 10 * MINUTE - 1 }] })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  expect(await lineOf(ui, '● waiting for you 10 min')).toBeDefined()

  await ring($, 'go-old')

  expect(await lineOf(ui, '○ waiting 10 min')).toBeDefined()
})

test('the desktop surface draws the same list', async ($, on) => {
  const { clock } = stubEngine(on)
  await open($, clock)

  const ui = await $.ui.mount({ ...pane(), surface: 'desktop' })

  expect(await rowsOf(ui)).toEqual(['wait', 'work', 'old', 'here'])
  expect((await buttonOf(ui, 'wait'))?.hotkey).toBe('1')
})

// The floating window: a tmux popup the mod starts in place of its pane

test('inside tmux /board opens the floating window, and no pane', async ($, on) => {
  const { seen, clock } = stubEngine(on, { popup: { code: 0 } })

  const answer = await open($, clock)

  expect(answer.text).toBe('Active sessions: 4')
  expect(seen.spawned).toEqual([POPUP_ARGV])
  expect(seen.opened).toEqual([])
  expect(seen.toasts).toEqual([])
})

test('outside tmux there is no floating window: the pane opens at once', async ($, on) => {
  const { seen, clock } = stubEngine(on, { env: { HOME: '/home/u' }, popup: { code: 0 } })

  await open($, clock)

  expect(seen.spawned).toEqual([])
  expect(seen.opened.length).toBe(1)
})

test('a floating window that cannot open gives way to the pane, and says why to the debug log', async ($, on) => {
  const world: World = { model: () => unanswered }
  const { seen, clock } = stubEngine(on, world)

  for (const popup of [
    { code: 3, says: 'Not in tmux: nowhere to open the floating window\n' },
    { code: 4, says: 'No fzf: the floating window is drawn by it\n' },
    { code: 5, says: 'The tmux popup did not open\none more line\n' },
    { code: 1 },
    { deny: 'spawn python3 ENOENT' },
  ]) {
    world.popup = popup
    seen.opened.length = 0
    seen.logs.length = 0
    await open($, clock)

    expect(seen.opened.length).toBe(1)
    expect(seen.logs.filter(log => log.text.startsWith('session-board: the floating window did not open')).length).toBe(1)
    expect(seen.toasts).toEqual([])
  }

  expect(seen.logs.at(-1)?.text).toMatch(/spawn python3 ENOENT/)
  world.popup = { code: 5, says: 'The tmux popup did not open\none more line\n' }
  seen.logs.length = 0
  await open($, clock)
  expect(seen.logs.map(log => log.text)).toContain('session-board: the floating window did not open: The tmux popup did not open')
})

test('the summaries are left in a file for the floating window, and again when one arrives', async ($, on) => {
  const kept = { stamp: 'w1', text: 'A summary from last time.', atMs: NOW - HOUR }
  const world: World = { popup: { code: 0, ms: 60_000 }, store: { 'summary:wait': kept } }
  const { seen, clock } = stubEngine(on, world)
  // The model takes three seconds over `work`: its summary arrives while the window is up
  world.model = async () => {
    await clock.sleep(3_000)

    return said('It writes the indexer.')
  }

  await open($, clock)

  const path = '/run/user/1000/session-board/summaries.json'
  expect(seen.files.map(file => file.path)).toEqual([path])
  expect(JSON.parse(seen.files[0]?.text ?? '')).toEqual({ wait: kept })

  await clock.advance(3_000)

  expect(seen.files.map(file => file.path)).toEqual([path, path])
  expect(JSON.parse(seen.files[1]?.text ?? '')).toEqual({
    wait: kept,
    work: { stamp: 'k1', text: 'It writes the indexer.', atMs: NOW + 3_000 },
  })
})

test('without a runtime folder the file goes to the cache of the person', async ($, on) => {
  const { seen, clock } = stubEngine(on, {
    env: { HOME: '/home/u', TMUX: '/tmp/tmux-1000/default,1,0' },
    popup: { code: 0 },
  })

  await open($, clock)

  expect(seen.files[0]?.path).toBe('/home/u/.cache/session-board/summaries.json')
  expect(seen.spawned[0]?.[6]).toBe('/home/u/.cache/session-board/summaries.json')
})

test('while the floating window is open the sessions are collected for their summaries, and no longer once it closed', async ($, on) => {
  const world: World = { popup: { code: 0, ms: 12_000 }, sessions: [WORK] }
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)
  expect(indexed(seen)).toBe(1)

  await clock.advance(2 * TICK)
  expect(indexed(seen)).toBe(3)

  // The window closes at 12 s; the ticks after it find nothing to refresh for
  await clock.advance(TICK)
  const collected = indexed(seen)
  const asked = seen.panesAsked
  await clock.advance(4 * TICK)

  expect(indexed(seen)).toBe(collected)
  expect(seen.panesAsked).toBe(asked)
  expect(seen.opened).toEqual([])
})

test('a summary that arrives after the floating window closed is not written for it', async ($, on) => {
  const world: World = { popup: { code: 0, ms: 1_000 }, sessions: [WAIT] }
  const { seen, clock } = stubEngine(on, world)
  // The model takes seven seconds; the window is gone after one
  world.model = async digest => {
    await clock.sleep(7_000)

    return said(`Summary: ${digest}`)
  }

  await open($, clock)
  const written = seen.files.length
  await clock.advance(8_000)

  expect(seen.store.has('summary:wait')).toBe(true)
  expect(seen.files.length).toBe(written)
})

test('the threshold reaches the floating window', { options: { staleMinutes: 180 } }, async ($, on) => {
  const { seen, clock } = stubEngine(on, { popup: { code: 0 } })

  await open($, clock)

  expect(seen.spawned[0]?.slice(-2)).toEqual(['--stale-minutes', '180'])
})

test('an indexer that fails is said in the pane, and no floating window is started', async ($, on) => {
  const { seen, clock } = stubEngine(on, { popup: { code: 0 }, indexer: ran({ exitCode: 1, stderr: 'broken' }) })

  await open($, clock)

  expect(seen.spawned).toEqual([])
  expect(seen.opened.length).toBe(1)
})

// The leader: two spaces on an empty prompt, as <space><space> in nvim

test('two spaces on an empty prompt open the board and leave the prompt empty', async ($, on) => {
  const { seen, clock } = stubEngine(on, { popup: { code: 0 } })

  const first = await typed($, '', ' ')
  expect(first).toEqual({ text: ' ', cursor: 1 })
  expect(seen.spawned).toEqual([])

  const second = await typed($, ' ', ' ')
  expect(second).toEqual({ text: '', cursor: 0 })

  await clock.advance(30)
  await clock.settle()

  expect(indexed(seen)).toBe(1)
  expect(seen.spawned).toEqual([POPUP_ARGV])
})

test('two spaces that arrive as one edit open the board too', async ($, on) => {
  const { seen, clock } = stubEngine(on, { popup: { code: 0 } })

  expect(await typed($, '', '  ')).toEqual({ text: '', cursor: 0 })
  await clock.advance(30)
  await clock.settle()

  expect(seen.spawned.length).toBe(1)
})

test('spaces in a prompt that holds text are typed as they are', async ($, on) => {
  const { seen, clock } = stubEngine(on, { popup: { code: 0 } })

  expect(await typed($, 'fix it ', ' ')).toEqual({ text: 'fix it  ', cursor: 8 })
  expect(await typed($, ' ', 'a')).toEqual({ text: ' a', cursor: 2 })
  expect(await typed($, '  ', ' ')).toEqual({ text: '   ', cursor: 3 })
  await clock.advance(1_000)

  expect(seen.spawned).toEqual([])
  expect(indexed(seen)).toBe(0)
})

test('outside tmux the two spaces open the pane', async ($, on) => {
  const { seen, clock } = stubEngine(on, { env: { HOME: '/home/u' }, model: () => unanswered })

  await typed($, ' ', ' ')
  await clock.advance(30)
  await clock.settle()

  expect(seen.opened.length).toBe(1)
  expect(seen.spawned).toEqual([])
})

// Summaries: what the model is asked, what is kept, and what a failure costs

test('the model is asked about the highlighted sessions only, over their digests', async ($, on) => {
  const { seen, clock } = stubEngine(on)

  await open($, clock)

  expect(digests(seen)).toEqual(['digest wait', 'digest work'])
  expect(seen.asked[0]).toMatchObject({ model: 'haiku', prompt: 'digest wait', maxTokens: 200, timeoutMs: 20_000 })
  expect(seen.asked[0]?.system).toMatch(/^You write one line for a status board of coding-agent sessions\./)
})

test('the preview shows the summary between the prompt and the last reply', async ($, on) => {
  const { clock } = stubEngine(on, {
    model: digest => said(digest === 'digest wait' ? 'Fixed 14 review notes, waits for a call on the commits.' : 'It writes the indexer.'),
  })
  await open($, clock)
  const ui = await $.ui.mount(pane())
  const drawn = JSON.stringify(await ui.drawn())

  expect((await lineOf(ui, 'summary'))?.props.color).toBe('subtle')
  expect(await lineOf(ui, 'Fixed 14 review notes, waits for a call on the commits.')).toBeDefined()
  expect(drawn.indexOf('remove the traces')).toBeLessThan(drawn.indexOf('Fixed 14 review notes'))
  expect(drawn.indexOf('Fixed 14 review notes')).toBeLessThan(drawn.indexOf('Done: 14 edits'))

  await ring($, 'go-work')

  expect(await lineOf(ui, 'It writes the indexer.')).toBeDefined()
})

test('a long summary is wrapped to the preview', async ($, on) => {
  const long = 'Cleaned up the debug logs, fixed five review notes, ran the tests and the linter, updated the spec and the README; left to decide: split the changes into separate commits or keep one.'
  const { clock } = stubEngine(on, { sessions: [WAIT], model: () => said(long) })
  await open($, clock)

  // A preview frame of 60 leaves the text 56
  const ui = await $.ui.mount(pane())

  expect(await lineOf(ui, 'Cleaned up the debug logs, fixed five review notes, ran')).toBeDefined()
  expect(await lineOf(ui, 'the tests and the linter, updated the spec and the')).toBeDefined()
  expect(await lineOf(ui, 'README; left to decide: split the changes into separate')).toBeDefined()
  expect(await lineOf(ui, 'commits or keep one.')).toBeDefined()
})

test('a summary is kept in the store under the session, with the stamp it was asked at', async ($, on) => {
  const { seen, clock } = stubEngine(on, { model: () => said('  Fixed\nthe tests.  ') })

  await open($, clock)

  expect(seen.store.get('summary:wait')).toEqual({ stamp: 'w1', text: 'Fixed the tests.', atMs: NOW })
  expect(seen.store.get('summary:work')).toEqual({ stamp: 'k1', text: 'Fixed the tests.', atMs: NOW })
  expect([...seen.store.keys()].sort()).toEqual(['summary:wait', 'summary:work'])
})

test('a kept summary is drawn without asking, and the keys of sessions that are gone are dropped', async ($, on) => {
  const kept = { stamp: 'w1', text: 'A summary from the last pane.', atMs: NOW - HOUR }
  const { seen, clock } = stubEngine(on, {
    store: {
      'summary:wait': kept,
      'summary:gone': { stamp: 'g1', text: 'That session is gone.', atMs: NOW - HOUR },
      'summary:old': 'not a summary',
      other: 1,
    },
  })

  await open($, clock)
  const ui = await $.ui.mount(pane())

  expect(digests(seen)).toEqual(['digest work'])
  expect(await textOf(ui, 'A summary from the last pane.')).toBeDefined()
  expect(seen.store.get('summary:wait')).toEqual(kept)
  expect(seen.store.has('summary:gone')).toBe(false)
  // A key of a live session and a key that is not the mod's are left alone
  expect(seen.store.get('summary:old')).toBe('not a summary')
  expect(seen.store.get('other')).toBe(1)
})

test('a waiting session is asked once per stop, a new stop is asked at once', async ($, on) => {
  const world: World = {}
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)
  await clock.advance(3 * TICK)
  expect(digests(seen).filter(digest => digest === 'digest wait')).toEqual(['digest wait'])

  world.sessions = [{ ...WAIT, stamp: 'w2', digest: 'digest wait 2' }, WORK, OLD, HERE]
  await clock.advance(TICK)

  expect(digests(seen)).toContain('digest wait 2')
  expect(seen.store.get('summary:wait')).toMatchObject({ stamp: 'w2', atMs: NOW + 4 * TICK })
})

test('a working session is asked again only three minutes after its last summary', async ($, on) => {
  const world: World = { sessions: [WORK] }
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)
  expect(digests(seen)).toEqual(['digest work'])

  // The transcript moves at every tick
  world.sessions = [{ ...WORK, stamp: 'k2', digest: 'digest work 2' }]
  await clock.advance(3 * MINUTE - TICK)
  expect(digests(seen)).toEqual(['digest work'])

  await clock.advance(TICK)
  expect(digests(seen)).toEqual(['digest work', 'digest work 2'])
})

test('the old summary of a working session stays on screen until the new one arrives', async ($, on) => {
  const world: World = { sessions: [WORK], model: () => said('The first summary.') }
  const { clock } = stubEngine(on, world)
  await open($, clock)
  const ui = await $.ui.mount(pane())

  world.sessions = [{ ...WORK, stamp: 'k2', digest: 'digest work 2' }]
  world.model = () => said('The second summary.')
  await clock.advance(TICK)
  expect(await textOf(ui, 'The first summary.')).toBeDefined()

  await clock.advance(3 * MINUTE)
  expect(await textOf(ui, 'The second summary.')).toBeDefined()
  expect(await textOf(ui, 'The first summary.')).toBeUndefined()
})

test('a stale session is never asked, even when its transcript moves', async ($, on) => {
  const world: World = { sessions: [OLD] }
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)

  world.sessions = [{ ...OLD, stamp: 'o2', digest: 'digest old 2' }]
  await clock.advance(4 * MINUTE)

  expect(seen.asked).toEqual([])
})

test('a session that went stale while the pane was open is asked no more', async ($, on) => {
  // Two seconds short of the threshold: the first tick finds it stale
  const almost: Indexed = { ...WAIT, statusSinceMs: NOW - 10 * MINUTE + 2_000 }
  const world: World = { sessions: [almost] }
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)
  expect(digests(seen)).toEqual(['digest wait'])

  world.sessions = [{ ...almost, stamp: 'w2', digest: 'digest wait 2' }]
  await clock.advance(5 * MINUTE)

  expect(digests(seen)).toEqual(['digest wait'])
})

test('the threshold decides who is asked about', { options: { staleMinutes: 180 } }, async ($, on) => {
  const { seen, clock } = stubEngine(on)

  await open($, clock)

  // `old` has waited two hours: under three it is highlighted, so it is asked about
  expect(digests(seen)).toEqual(['digest wait', 'digest work', 'digest old'])
})

test('a summary the model did not give is not kept, is said to the debug log, and is not asked again at the same stamp', async ($, on) => {
  const { seen, clock } = stubEngine(on, { sessions: [WAIT], model: () => unanswered })
  await open($, clock)
  const ui = await $.ui.mount(pane())

  await clock.advance(5 * MINUTE)

  expect(seen.asked.length).toBe(1)
  expect(seen.store.size).toBe(0)
  expect(seen.toasts).toEqual([])
  expect(summaryLogs(seen)).toEqual([{ text: 'session-board: no summary for session wait: empty-reply', to: 'debug' }])
  expect(await lineOf(ui, 'agent')).toBeDefined()
  expect(await lineOf(ui, 'summary')).toBeUndefined()
})

test('after a failure a session waits for a new stamp and for three minutes', async ($, on) => {
  const world: World = { sessions: [WORK], model: () => unanswered }
  const { seen, clock } = stubEngine(on, world)
  await open($, clock)
  expect(seen.asked.length).toBe(1)

  world.sessions = [{ ...WORK, stamp: 'k2', digest: 'digest work 2' }]
  world.model = undefined
  await clock.advance(3 * MINUTE - TICK)
  expect(seen.asked.length).toBe(1)

  await clock.advance(TICK)
  expect(digests(seen)).toEqual(['digest work', 'digest work 2'])
  expect(seen.store.get('summary:work')).toMatchObject({ stamp: 'k2' })
})

test('a call the engine refuses, and a reply of blanks, are failures like any other', async ($, on) => {
  const world: World = {
    sessions: [WAIT, WORK],
    model: digest => (digest === 'digest wait' ? { deny: 'model blocked by policy' } : said(' \n ')),
  }
  const { seen, clock } = stubEngine(on, world)

  await open($, clock)
  const ui = await $.ui.mount(pane())

  expect(seen.store.size).toBe(0)
  expect(summaryLogs(seen).map(log => log.text).sort()).toEqual([
    expect.stringMatching(/^session-board: no summary for session wait: .*model blocked by policy/),
    'session-board: no summary for session work: empty-reply',
  ])
  expect(await lineOf(ui, 'summary')).toBeUndefined()
})

test('no more than three summaries are asked at once, the rest at the ticks after', async ($, on) => {
  const five = Array.from({ length: 5 }, (unused, index) => ({
    ...WAIT,
    id: `s${index}`,
    pid: index + 1,
    stamp: `stamp${index}`,
    digest: `digest ${index}`,
  }))
  const world: World = { sessions: five }
  const { seen, clock } = stubEngine(on, world)
  // The model takes seven seconds over each
  world.model = async digest => {
    await clock.sleep(7_000)

    return said(`Summary: ${digest}`)
  }

  await open($, clock)
  expect(digests(seen)).toEqual(['digest 0', 'digest 1', 'digest 2'])

  // At 5 s all three are still asked
  await clock.advance(TICK)
  expect(seen.asked.length).toBe(3)

  // At 7 s they are answered; the tick at 10 s asks the other two
  await clock.advance(TICK)
  expect(digests(seen)).toEqual(['digest 0', 'digest 1', 'digest 2', 'digest 3', 'digest 4'])

  await clock.advance(2 * TICK)
  expect(seen.asked.length).toBe(5)
  expect(seen.store.size).toBe(5)
})
