import { createEffect, createSignal } from "solid-js"
import { createHomeController } from "./home/home-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"

const REMOTE_SESSION_KEY = "opencode.remote.direct.session"
const REMOTE_PROJECT_KEY = "opencode.remote.direct.project"

function readStored(key: string) {
  if (typeof localStorage === "undefined") return undefined
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function writeStored(key: string, value: string) {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(key, value)
  } catch {
    return
  }
}

/**
 * Remote-first home.
 *
 * The public iPhone remote is intentionally session-first: `/` never renders the
 * projects/session picker. It resolves the remembered real session when possible,
 * otherwise the newest real server session, and opens it immediately.
 */
export function NewHome() {
  const home = createHomeController()
  const sessions = createHomeSessionsController(home)
  const [opening, setOpening] = createSignal(false)

  // Root should search all projects. A project selection from an older browser
  // visit must not trap the remote on a stale subset of sessions.
  createEffect(() => {
    const selection = home.selection.value()
    if (!selection.directory) return
    home.selection.set({ server: selection.server })
  })

  createEffect(() => {
    if (opening()) return
    if (sessions.data.loading()) return

    const records = sessions.data.records()
    const rememberedSession = readStored(REMOTE_SESSION_KEY)
    const rememberedProject = readStored(REMOTE_PROJECT_KEY)

    const remembered = rememberedSession
      ? records.find(
          (record) =>
            record.session.id === rememberedSession &&
            (!rememberedProject || record.project.worktree === rememberedProject),
        )
      : undefined
    const target = remembered ?? records[0]

    if (target) {
      setOpening(true)
      writeStored(REMOTE_SESSION_KEY, target.session.id)
      writeStored(REMOTE_PROJECT_KEY, target.project.worktree)
      sessions.session.open(target.session)
      return
    }

    // Fresh servers may have no session yet. Reuse the app's real new-session
    // flow instead of exposing the project/session browser.
    if (!sessions.session.canCreate()) return
    const project = home.project.newSession()
    if (project) writeStored(REMOTE_PROJECT_KEY, project.worktree)
    setOpening(true)
    sessions.session.create()
  })

  return (
    <div class="fixed inset-0 z-[9999] flex items-center justify-center bg-background-base">
      <span class="text-14-regular text-text-base">Conectando…</span>
    </div>
  )
}
