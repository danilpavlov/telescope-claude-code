// One running session, as hooks/index_live.py prints it, less the digest
export type LiveSession = {
  id: string
  pid: number
  title: string
  cwd: string
  // `busy` while the agent works; `idle`, or a word this mod does not know, while it waits
  status: string
  // When the session took that status
  statusSinceMs: number
  lastPrompt: string | null
  lastReply: string | null
  // The tool still running, by name
  activity: string | null
  // The tmux pane the session runs in (`%4`), and the registry's whole address of it
  tmuxPane: string | null
  tmuxTarget: string | null
  // Where the transcript stands: the uuid of its last user or assistant record
  stamp: string | null
}

// The same with the text a summary is asked over
export type Indexed = LiveSession & { digest: string | null }

export type LiveIndex = { sessions: Indexed[]; skipped: number }

// Waiting for the person, working, or waiting longer than the threshold
export type Phase = 'waiting' | 'working' | 'stale'

// What the model said of a session, and the transcript position it said it at
export type Summary = { stamp: string; text: string; atMs: number }

declare module 'claude-code' {
  interface PluginState {
    'session-board': {
      sessions: LiveSession[]
      order: string[]
      summaries: Record<string, Summary>
      skipped: number
      error: string | null
      currentId: string
      home: string
      nowMs: number
      // What the search field holds
      query: string
      // The key of the element that holds the pane's focus ring: the field, a row, or nothing
      focused: string
    }
  }
}
