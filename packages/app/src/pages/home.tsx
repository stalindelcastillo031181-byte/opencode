import { createEffect, createSignal } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { createHomeController } from "./home/home-controller"
import { createHomeProjectsController } from "./home/home-projects-controller"
import { HomeUtilityNav } from "./home/home-projects-view"
import { HomeProjects } from "./home/home-projects"
import { createHomeScrollController } from "./home/home-scroll-controller"
import { createHomeSessionSearchController } from "./home/home-session-search-controller"
import { createHomeSessionsController } from "./home/home-sessions-controller"
import { HomeSessions } from "./home/home-sessions"

const REMOTE_SESSION_KEY = "opencode.remote.direct.session"
const REMOTE_PROJECT_KEY = "opencode.remote.direct.project"
const REMOTE_PROJECT_ID_KEY = "opencode.remote.direct.projectID"
const HOME_OPENED_KEY = "opencode.remote.home.opened"

function homeOpened() {
  try {
    return sessionStorage.getItem(HOME_OPENED_KEY) === "1"
  } catch {
    return false
  }
}

function markHomeOpened() {
  try {
    sessionStorage.setItem(HOME_OPENED_KEY, "1")
  } catch {
    return
  }
}

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
  const projects = createHomeProjectsController(home)
  const sessions = createHomeSessionsController(home)
  const search = createHomeSessionSearchController(home, sessions)
  const scroll = createHomeScrollController(sessions.data.groups)
  const [opening, setOpening] = createSignal(false)

  createEffect(() => {
    const selection = home.selection.value()
    if (!selection.directory) return
    home.selection.set({ server: selection.server })
  })

  createEffect(() => {
    if (opening() || sessions.data.loading() || homeOpened()) return

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
      markHomeOpened()
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
    markHomeOpened()
    sessions.session.create()
  })

  return (
    <div class="m-2 min-h-0 flex-1 self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]">
      <ScrollView
        class="h-full [container-type:size]"
        thumbContainer={scroll.viewport.thumbTrack}
        thumbHoverTarget={scroll.viewport.hoverTarget}
        viewportRef={scroll.viewport.setViewport}
        onScroll={(event) => scroll.viewport.update(event.currentTarget.scrollTop)}
        onWheel={scroll.viewport.containOuterWheel}
      >
        <div class="mx-auto grid min-h-full w-full max-w-[1080px] grid-rows-[auto_minmax(0,1fr)_auto] gap-4 px-3 lg:grid-cols-[280px_minmax(0,720px)] lg:grid-rows-1 lg:gap-8 lg:px-6">
          <HomeProjects projects={projects} scroll={scroll} />
          <HomeSessions sessions={sessions} search={search} scroll={scroll} />
          <HomeUtilityNav
            class="flex lg:hidden"
            onOpenSettings={projects.utility.settings}
            onOpenHelp={projects.utility.help}
            language={projects.copy.language}
          />
        </div>
      </ScrollView>
    </div>
  )
}
