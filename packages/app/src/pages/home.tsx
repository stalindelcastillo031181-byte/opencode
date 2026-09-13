import { createEffect, createSignal } from "solid-js"
import { createHomeController } from "./home/home-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"

const REMOTE_SESSION_KEY = "opencode.remote.direct.session"
const REMOTE_PROJECT_KEY = "opencode.remote.direct.project"
const REMOTE_PROJECT_ID_KEY = "opencode.remote.direct.projectID"

function readStored(key: string) {
  if (typeof localStorage === "undefined") return undefined
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function writeStored(key: string, value?: string) {
  if (!value || typeof localStorage === "undefined") return
  try {
    localStorage.setItem(key, value)
  } catch {
    return
  }
}

/** Public remote root: never render Projects/Home. Resolve and open the real session. */
export function NewHome() {
  const home = createHomeController()
  const sessions = createHomeSessionsController(home)
  const [opening, setOpening] = createSignal(false)

  createEffect(() => {
    const selection = home.selection.value()
    if (!selection.directory) return
    home.selection.set({ server: selection.server })
  })

  createEffect(() => {
    if (opening() || sessions.data.loading()) return

    const records = sessions.data.records()
    const rememberedSession = readStored(REMOTE_SESSION_KEY)
    const rememberedProject = readStored(REMOTE_PROJECT_KEY)
    const rememberedProjectID = readStored(REMOTE_PROJECT_ID_KEY)

    const remembered = rememberedSession
      ? records.find(
          (record) =>
            record.session.id === rememberedSession &&
            (!rememberedProject || record.project.worktree === rememberedProject) &&
            (!rememberedProjectID || record.project.id === rememberedProjectID),
        )
      : undefined
    const target = remembered ?? records[0]

    if (target) {
      setOpening(true)
      writeStored(REMOTE_SESSION_KEY, target.session.id)
      writeStored(REMOTE_PROJECT_KEY, target.project.worktree)
      writeStored(REMOTE_PROJECT_ID_KEY, target.project.id)
      sessions.session.open(target.session)
      return
    }

    if (!sessions.session.canCreate()) return
    const project = home.project.newSession()
    writeStored(REMOTE_PROJECT_KEY, project?.worktree)
    writeStored(REMOTE_PROJECT_ID_KEY, project?.id)
    setOpening(true)
    sessions.session.create()
  })

  return (
    <div class="fixed inset-0 z-[9999] flex items-center justify-center bg-background-base">
      <span class="text-14-regular text-text-base">Conectando…</span>
    </div>
  )
}
