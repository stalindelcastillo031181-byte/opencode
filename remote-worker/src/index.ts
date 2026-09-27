interface Env {
  CONTROL_TOKEN: string
  REMOTE_STATE: KVNamespace
}

const CONTROL_PATH = "/__opencode_remote/origin"
const STATUS_PATH = "/__opencode_remote/status"
const ORIGIN_KEY = "origin"

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (url.pathname === CONTROL_PATH) return updateOrigin(request, env)
    if (url.pathname === STATUS_PATH) return status(env)

    const origin = await env.REMOTE_STATE.get(ORIGIN_KEY)
    if (!origin) return new Response("El control remoto de OpenCode está desconectado.", { status: 503 })

    const target = new URL(url.pathname + url.search, origin)
    const headers = new Headers(request.headers)
    headers.set("origin", target.origin)
    headers.delete("x-opencode-control-token")

    return fetch(
      new Request(target, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      }),
    )
  },
} satisfies ExportedHandler<Env>

async function updateOrigin(request: Request, env: Env) {
  if (request.method !== "PUT") return new Response("Method Not Allowed", { status: 405 })
  if (request.headers.get("x-opencode-control-token") !== env.CONTROL_TOKEN) {
    return new Response("Unauthorized", { status: 401 })
  }

  const value = (await request.text()).trim()
  const origin = validOrigin(value)
  if (!origin) return new Response("Invalid origin", { status: 400 })

  await env.REMOTE_STATE.put(ORIGIN_KEY, origin)
  return Response.json({ connected: true })
}

async function status(env: Env) {
  return Response.json(
    { connected: !!(await env.REMOTE_STATE.get(ORIGIN_KEY)) },
    { headers: { "cache-control": "no-store" } },
  )
}

function validOrigin(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "https:") return
    if (!url.hostname.endsWith(".trycloudflare.com")) return
    if (url.pathname !== "/" || url.search || url.hash) return
    return url.origin
  } catch {
    return
  }
}
