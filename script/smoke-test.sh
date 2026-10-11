#!/usr/bin/env bash
# Prueba de integración con SOCKETS REALES del selector de proyectos GitLab.
# Levanta un upstream falso (puerto 4196) y el proxy real (puerto 4198) con HOME, config y contraseña
# temporales, y comprueba por HTTP: auth, endpoint de estado, HTML inyectado y válido, pass-through.
# No toca el proxy vivo (4097), ni ~/.config, ni ~/.local/state, ni la red.
#
#   bash script/smoke-test.sh
#
# Salida: 0 = todo OK · 1 = alguna comprobación falló · 3 = NO EJECUTADA (no se pueden abrir puertos aquí)
#
# Modo solo-aserciones (sin sockets): SMOKE_ASSERT_ONLY=<dir> bash script/smoke-test.sh
#   revisa los archivos que deja `node script/test/make-fixtures.cjs <dir>` (el proxy real en proceso).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
NODE="${NODE:-$(command -v node || echo /usr/local/bin/node)}"
PROXY_PORT="${SMOKE_PROXY_PORT:-4198}"
UP_PORT="${SMOKE_UPSTREAM_PORT:-4196}"
WORK=""
PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  [ -n "$WORK" ] && rm -rf "$WORK"
}
trap cleanup EXIT
PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "OK     $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FALLA  $1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
summary() {
  echo "---"
  echo "RESULTADO: $PASS OK, $FAIL fallas"
  [ "$FAIL" -eq 0 ]
}

# Aserciones sobre los archivos recogidos (T, HOME y PW ya definidos)
assert_files() {
  check "estado: endpoint con credenciales -> 200" '[ "$(cat "$T/status.code")" = 200 ]'
  check "estado: demo presente, ausente no presente" '"$NODE" -e "const d=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));const m=Object.fromEntries(d.projects.map(p=>[p.name,p.present]));process.exit(m.demo===true&&m.ausente===false?0:1)" "$T/status.json"'
  check "estado: no contiene la contraseña ni tokens" '! grep -q -e "$PW" -e "glpat-" -e "authorization" "$T/status.json"'
  check "HTML: contiene la siembra con el proyecto presente" 'grep -q "id=\"gitlab-projects-seed\"" "$T/page.html" && grep -q "$HOME/GitLab/demo" "$T/page.html"'
  check "HTML: NO lista el proyecto sin carpeta" '! grep -q "$HOME/GitLab/ausente" "$T/page.html"'
  check "HTML: sigue válido (doctype, un head, título, cierra </html>)" '[ "$(head -c 15 "$T/page.html")" = "<!doctype html>" ] && [ "$(grep -o "<head>" "$T/page.html" | wc -l | tr -d " ")" = 1 ] && grep -q "<title>fake-opencode</title>" "$T/page.html" && tail -c 8 "$T/page.html" | grep -q "</html>"'
  check "HTML: scripts balanceados (siembra + módulo de la app)" '[ "$(grep -o "<script" "$T/page.html" | wc -l | tr -d " ")" = "$(grep -o "</script>" "$T/page.html" | wc -l | tr -d " ")" ]'
  check "HTML: la siembra va antes que el módulo de la app" '[ "$(grep -b -o "id=\"gitlab-projects-seed\"" "$T/page.html" | head -1 | cut -d: -f1)" -lt "$(grep -b -o "src=\"/app.js\"" "$T/page.html" | head -1 | cut -d: -f1)" ]'
  check "HTML: content-length coincide con el cuerpo" '[ "$(tr -d "\r" <"$T/page.headers" | awk -F": " "tolower(\$1)==\"content-length\"{print \$2}")" = "$(wc -c <"$T/page.html" | tr -d " ")" ]'
  check "HTML: no contiene la contraseña" '! grep -q "$PW" "$T/page.html"'
  check "no-HTML: pasa intacto, sin siembra" 'grep -q "\"fake\":true" "$T/json.out" && ! grep -q "gitlab-projects-seed" "$T/json.out"'
  check "pass-through de /global/health" 'grep -q "\"healthy\":true" "$T/health.out"'
}

if [ -n "${SMOKE_ASSERT_ONLY:-}" ]; then
  T="$SMOKE_ASSERT_ONLY"
  HOME="$T/home"
  PW="$(cat "$T/pw")"
  assert_files
  summary
  exit $?
fi

# 0. ¿se pueden abrir puertos locales en este entorno?
if ! "$NODE" -e "require('net').createServer().on('error',()=>process.exit(1)).listen(0,'127.0.0.1',function(){this.close()})" >/dev/null 2>&1; then
  echo "NO EJECUTADA: este entorno no permite abrir puertos locales (sandbox o permisos). Córrela en tu Mac: bash script/smoke-test.sh"
  exit 3
fi

# 1. entorno aislado
WORK="$(mktemp -d "${TMPDIR:-/tmp}/gl-smoke.XXXXXX")"
T="$WORK"
export HOME="$T/home"
STATE="$HOME/.local/state/opencode-mobile-remote"
mkdir -p "$HOME/.config/opencode" "$STATE" "$HOME/GitLab/demo/.git"
printf 'ref: refs/heads/main\n' >"$HOME/GitLab/demo/.git/HEAD"
PW="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24)"
printf '%s' "$PW" >"$T/pw"
cat >"$HOME/.config/opencode/gitlab-projects.json" <<JSON
{"version":2,"root":"$HOME/GitLab","projects":[
 {"name":"demo","path":"g/demo","url":"https://gitlab.com/g/demo.git"},
 {"name":"ausente","path":"g/ausente","url":"https://gitlab.com/g/ausente.git"}]}
JSON

# 2. upstream falso + proxy real en puertos alternos
"$NODE" "$HERE/test/fake-upstream.cjs" "$UP_PORT" >"$T/upstream.log" 2>&1 &
PIDS+=($!)
OPENCODE_REMOTE_PASSWORD_FILE="$T/pw" OPENCODE_REMOTE_STATE_DIR="$STATE" OPENCODE_REMOTE_PORT="$PROXY_PORT" \
  OPENCODE_REMOTE_BIND=127.0.0.1 OPENCODE_REMOTE_UPSTREAM_PORT="$UP_PORT" \
  "$NODE" "$HERE/mobile-remote-proxy.cjs" >"$T/proxy.log" 2>&1 &
PIDS+=($!)
BASE="http://127.0.0.1:$PROXY_PORT"
for _ in $(seq 1 40); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$BASE/" 2>/dev/null)" = "401" ] && break
  sleep 0.25
done
if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "$BASE/" 2>/dev/null)" != "401" ]; then
  echo "NO EJECUTADA: el proxy no llegó a escuchar en $PROXY_PORT (¿puerto ocupado?). Log del proxy:"
  head -20 "$T/proxy.log"
  exit 3
fi

# credenciales por stdin: no aparecen en la lista de procesos
req() { printf 'user = "opencode:%s"\n' "$PW" | curl -sS -m 10 -K - "$@"; }

# 3. comprobaciones de acceso (necesitan el servidor vivo)
check "sin credenciales: HTML -> 401" '[ "$(curl -s -o /dev/null -w "%{http_code}" -H "Accept: text/html" "$BASE/")" = 401 ]'
check "sin credenciales: endpoint de estado -> 401" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$BASE/__opencode_remote/gitlab-projects")" = 401 ]'
check "contraseña incorrecta -> 401" '[ "$(printf "user = \"opencode:mala\"\n" | curl -s -o /dev/null -w "%{http_code}" -K - "$BASE/__opencode_remote/gitlab-projects")" = 401 ]'

# 4. recoger respuestas a archivos y comprobarlas
req -o "$T/status.json" -w '%{http_code}' "$BASE/__opencode_remote/gitlab-projects" >"$T/status.code"
req -H 'Accept: text/html,application/xhtml+xml' -D "$T/page.headers" -o "$T/page.html" "$BASE/"
req -H 'Accept: application/json' "$BASE/session/abc" >"$T/json.out"
req "$BASE/global/health" >"$T/health.out"
assert_files
summary
