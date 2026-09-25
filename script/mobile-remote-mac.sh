#!/usr/bin/env bash

set -euo pipefail
umask 077

script_path="${BASH_SOURCE[0]}"
case "$script_path" in
  /*) ;;
  *) script_path="$PWD/$script_path" ;;
esac
script_dir="$(cd -- "$(dirname -- "$script_path")" && pwd -P)"
repo_url="https://github.com/stalindelcastillo031181-byte/opencode.git"
branch="mac-mobile-remote"

if [ -n "${OPENCODE_MOBILE_DIR:-}" ]; then
  install_dir="$OPENCODE_MOBILE_DIR"
elif [ -f "$script_dir/../.git/HEAD" ] && [ -f "$script_dir/../packages/opencode/package.json" ]; then
  install_dir="$(cd -- "$script_dir/.." && pwd -P)"
else
  install_dir="$HOME/opencode-mobile-fixed"
fi

state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-mobile-remote"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
port="${OPENCODE_MOBILE_PORT:-4096}"
username="${OPENCODE_SERVER_USERNAME:-opencode}"
password_file="$config_dir/mobile-remote-password"
server_log="$state_dir/server.log"
build_log="$state_dir/build.log"
tunnel_log="$state_dir/tunnel.log"
server_pid_file="$state_dir/server.pid"
tunnel_pid_file="$state_dir/tunnel.pid"
built_fingerprint_file="$state_dir/built-fingerprint"
binary_version_file="$state_dir/binary-version"
url_file="$state_dir/current-url"
lock_dir="$state_dir/launcher.lock"
binary="$install_dir/packages/opencode/dist/opencode-darwin-x64/bin/opencode"
local_health="http://127.0.0.1:$port/global/health"
server_pid=""
tunnel_pid=""
verify_dir=""
lock_owned=0

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

valid_pid() {
  case "${1:-}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$1" -gt 0 ]
}

pid_from_file() {
  [ -s "$1" ] || return 1
  awk 'NR == 1 { print; exit }' "$1"
}

process_command() {
  ps -p "$1" -o command= 2>/dev/null || true
}

server_process_matches() {
  local command
  command="$(process_command "$1")"
  case "$command" in
    *"$binary serve --hostname 127.0.0.1 --port $port"*|*"$binary web --hostname 127.0.0.1 --port $port"*) return 0 ;;
    *) return 1 ;;
  esac
}

tunnel_process_matches() {
  local command
  command="$(process_command "$1")"
  case "$command" in
    *cloudflared*tunnel*--url*"http://127.0.0.1:$port"*) return 0 ;;
    *) return 1 ;;
  esac
}

stop_pid_file() {
  local file="$1"
  local kind="$2"
  local pid=""
  local command=""
  if [ ! -s "$file" ]; then
    rm -f "$file"
    return 0
  fi
  pid="$(pid_from_file "$file" || true)"
  if ! valid_pid "$pid" || ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$file"
    return 0
  fi
  command="$(process_command "$pid")"
  case "$kind" in
    server) server_process_matches "$pid" || return 2 ;;
    tunnel) tunnel_process_matches "$pid" || return 2 ;;
    *) return 2 ;;
  esac
  kill -TERM "$pid" 2>/dev/null || return 1
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$file"
      return 0
    fi
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$file"
}

terminate_child() {
  local pid="$1"
  local kind="$2"
  if ! valid_pid "$pid" || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  case "$kind" in
    server) server_process_matches "$pid" || return 0 ;;
    tunnel) tunnel_process_matches "$pid" || return 0 ;;
    *) return 0 ;;
  esac
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 30); do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

acquire_lock() {
  local old_pid=""
  local command=""
  if mkdir "$lock_dir" 2>/dev/null; then
    printf '%s\n' "$$" > "$lock_dir/pid"
    lock_owned=1
    return 0
  fi
  old_pid="$(pid_from_file "$lock_dir/pid" || true)"
  if valid_pid "$old_pid" && kill -0 "$old_pid" 2>/dev/null; then
    command="$(process_command "$old_pid")"
    case "$command" in
      *mobile-remote-mac.sh*|*opencode-mobile*) fail "Ya hay una ejecución activa del launcher (PID $old_pid)." ;;
    esac
  fi
  rm -rf "$lock_dir"
  mkdir "$lock_dir" 2>/dev/null || fail "No se pudo crear el lock del launcher: $lock_dir"
  printf '%s\n' "$$" > "$lock_dir/pid"
  lock_owned=1
}

release_lock() {
  rm -rf "$lock_dir"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  set +e
  if [ "$lock_owned" -eq 1 ]; then
    terminate_child "$tunnel_pid" tunnel
    terminate_child "$server_pid" server
    rm -f "$server_pid_file" "$tunnel_pid_file" "$url_file"
  fi
  if [ -n "$verify_dir" ]; then
    rm -rf "$verify_dir"
  fi
  if [ "$lock_owned" -eq 1 ]; then
    release_lock
  fi
  exit "$status"
}

wait_for_server() {
  local deadline=$((SECONDS + 45))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! kill -0 "$server_pid" 2>/dev/null; then
      fail "OpenCode terminó antes de quedar listo. Log: $server_log"
    fi
    if curl --fail --silent --show-error --max-time 5 -u "$username:$password" "$local_health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "Timeout esperando OpenCode en 127.0.0.1:$port. Log: $server_log"
}

verify_local_bind() {
  local addresses=""
  local address=""
  local found=0
  addresses="$(lsof -nP -a -iTCP:"$port" -sTCP:LISTEN -F n 2>/dev/null || true)"
  while IFS= read -r address; do
    case "$address" in
      n*)
        address="${address#n}"
        case "$address" in
          127.0.0.1:"$port")
            found=1
            ;;
          *)
            fail "El puerto $port no escucha únicamente en loopback. Log: $server_log"
            ;;
        esac
        ;;
    esac
  done <<EOF
$addresses
EOF
  [ "$found" -eq 1 ] || fail "No se detectó un listener loopback en 127.0.0.1:$port. Log: $server_log"
}

wait_for_tunnel_url() {
  local deadline=$((SECONDS + 90))
  tunnel_url=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    if ! kill -0 "$tunnel_pid" 2>/dev/null; then
      fail "cloudflared terminó antes de publicar el túnel. Log: $tunnel_log"
    fi
    tunnel_url="$(grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' "$tunnel_log" 2>/dev/null | tail -n 1 || true)"
    if [ -n "$tunnel_url" ]; then
      break
    fi
    sleep 1
  done
  if ! [[ "$tunnel_url" =~ ^https://[-a-z0-9]+\.trycloudflare\.com$ ]]; then
    fail "No se recibió una URL HTTPS válida de Cloudflare. Log: $tunnel_log"
  fi
}

wait_for_public_health() {
  local deadline=$((SECONDS + 120))
  local status=""
  while [ "$SECONDS" -lt "$deadline" ]; do
    status="$(curl --silent --show-error --retry 3 --retry-delay 2 --retry-all-errors --max-time 10 -u "$username:$password" -o /dev/null -w '%{http_code}' "$tunnel_url/global/health" || true)"
    if [ "$status" = "200" ]; then
      return 0
    fi
    sleep 1
  done
  fail "El health HTTPS no respondió 200. Log: $tunnel_log"
}

verify_public_auth() {
  local status=""
  status="$(curl --silent --show-error --max-time 10 -o /dev/null -w '%{http_code}' "$tunnel_url/global/health" || true)"
  [ "$status" = "401" ] || fail "El health HTTPS sin credenciales no está protegido (HTTP $status)."
}

verify_login() {
  local result=""
  local status=""
  local redirects=""
  local headers=""
  local body=""
  local cookies=""
  verify_dir="$(mktemp -d "$state_dir/verify.XXXXXX")"
  chmod 700 "$verify_dir"
  headers="$verify_dir/headers"
  body="$verify_dir/body"
  cookies="$verify_dir/cookies"
  result="$(curl --silent --show-error --max-time 20 --location --max-redirs 3 --proto '=https' -c "$cookies" -b "$cookies" -D "$headers" -o "$body" -w '%{http_code} %{num_redirects}' "$iphone_url" || true)"
  status="${result%% *}"
  redirects="${result##* }"
  [ "$status" = "200" ] || fail "La URL iPhone no cargó OpenCode (HTTP $status)."
  case "$redirects" in
    ''|*[!0-9]*) fail "No se pudo verificar el redireccionamiento de autenticación." ;;
  esac
  [ "$redirects" -le 3 ] || fail "La URL iPhone produjo un loop de redirección."
  grep -qi '^set-cookie:.*opencode_auth_token=' "$headers" || fail "La URL iPhone no creó la cookie de sesión."
  grep -Eqi '<html|opencode' "$body" || fail "La respuesta HTTPS no contiene la interfaz principal de OpenCode."
  status="$(curl --silent --show-error --max-time 10 -b "$cookies" -o "$body" -w '%{http_code}' "$tunnel_url/" || true)"
  [ "$status" = "200" ] || fail "La sesión autenticada no conservó el acceso a OpenCode (HTTP $status)."
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$(uname -s)" != "Darwin" ]; then
  fail "Este launcher es únicamente para macOS."
fi
case "$(uname -m)" in
  x86_64|amd64) ;;
  *) fail "Este launcher requiere un Mac Intel x86_64." ;;
esac
command -v brew >/dev/null 2>&1 || fail "Falta Homebrew."
command -v git >/dev/null 2>&1 || fail "Falta git."
command -v curl >/dev/null 2>&1 || fail "Falta curl."
command -v lsof >/dev/null 2>&1 || fail "Falta lsof."
command -v openssl >/dev/null 2>&1 || fail "Falta openssl."
command -v shasum >/dev/null 2>&1 || fail "Falta shasum."
command -v file >/dev/null 2>&1 || fail "Falta file."
if ! command -v bun >/dev/null 2>&1; then
  brew install bun
fi
if ! command -v cloudflared >/dev/null 2>&1; then
  brew install cloudflared
fi
command -v cloudflared >/dev/null 2>&1 || fail "cloudflared no está disponible después de la instalación."

case "$port" in
  ''|*[!0-9]*) fail "OPENCODE_MOBILE_PORT debe ser un número." ;;
esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail "OPENCODE_MOBILE_PORT está fuera de rango."
case "$username" in
  ''|*:*|*$'\n'*|*$'\r'*) fail "OPENCODE_SERVER_USERNAME no puede contener ':' ni saltos de línea." ;;
esac

mkdir -p "$state_dir" "$config_dir"
chmod 700 "$state_dir" "$config_dir"
acquire_lock

if [ ! -d "$install_dir/.git" ]; then
  git clone --branch "$branch" --single-branch "$repo_url" "$install_dir" || fail "No se pudo clonar $repo_url."
else
  current_branch="$(git -C "$install_dir" branch --show-current)"
  [ "$current_branch" = "$branch" ] || fail "El repositorio está en la rama $current_branch; se requiere $branch."
  if [ -n "$(git -C "$install_dir" status --porcelain)" ]; then
    printf 'Hay cambios locales en %s; se conservan y se omite la actualización remota.\n' "$install_dir"
  else
    git -C "$install_dir" fetch origin "$branch" || fail "No se pudo actualizar la referencia remota $branch."
    git -C "$install_dir" merge --ff-only "origin/$branch" || fail "La rama local divergió de origin/$branch; no se forzó ningún merge."
  fi
fi

commit="$(git -C "$install_dir" rev-parse HEAD)"
binary="$install_dir/packages/opencode/dist/opencode-darwin-x64/bin/opencode"
build_fingerprint="$({ git -C "$install_dir" rev-parse HEAD; git -C "$install_dir" diff --binary HEAD -- packages package.json bun.lock; } | shasum -a 256 | awk '{print $1}')"
recorded_fingerprint=""
if [ -f "$built_fingerprint_file" ]; then
  recorded_fingerprint="$(awk 'NR == 1 { print; exit }' "$built_fingerprint_file")"
fi
if [ ! -x "$binary" ] || [ "$recorded_fingerprint" != "$build_fingerprint" ]; then
  printf 'Construyendo OpenCode %s para Intel macOS; el primer build puede tardar...\n' "$commit"
  : > "$build_log"
  chmod 600 "$build_log"
  bun install --cwd "$install_dir" >> "$build_log" 2>&1 || fail "Falló bun install. Log: $build_log"
  bun run --cwd "$install_dir/packages/opencode" build --single --skip-install >> "$build_log" 2>&1 || fail "Falló el build de OpenCode. Log: $build_log"
  printf '%s\n' "$build_fingerprint" > "$built_fingerprint_file"
fi
[ -x "$binary" ] || fail "El binario Intel no existe: $binary"
file_result="$(file "$binary")"
case "$file_result" in
  *'x86_64'*) ;;
  *) fail "El binario no es compatible con Intel x86_64: $binary" ;;
esac
binary_version="$("$binary" --version 2>/dev/null || true)"
[ -n "$binary_version" ] || fail "El binario no responde a --version. Log: $build_log"
printf '%s\n' "$binary_version" > "$binary_version_file"
chmod 600 "$binary_version_file"

password=""
rotate_password=0
if [ -s "$password_file" ]; then
  password="$(awk 'NR == 1 { print; exit }' "$password_file")"
  case "$password" in
    ''|*[!0-9a-fA-F]*) rotate_password=1 ;;
  esac
  [ "${#password}" -eq 64 ] || rotate_password=1
else
  rotate_password=1
fi
if [ "$rotate_password" -eq 1 ]; then
  password="$(openssl rand -hex 32)"
  printf '%s\n' "$password" > "$password_file"
  chmod 600 "$password_file"
fi
auth_token="$(printf '%s' "$username:$password" | base64 | tr -d '\r\n')"
auth_token_url="${auth_token//+/%2B}"
auth_token_url="${auth_token_url//\//%2F}"
auth_token_url="${auth_token_url//=/%3D}"

if ! stop_pid_file "$server_pid_file" server; then
  fail "El PID guardado para OpenCode no coincide con el proceso esperado; no se detuvo ningún proceso ajeno."
fi
if ! stop_pid_file "$tunnel_pid_file" tunnel; then
  fail "El PID guardado para cloudflared no coincide con el proceso esperado; no se detuvo ningún proceso ajeno."
fi
if lsof -nP -a -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "El puerto $port está ocupado por un proceso no gestionado por este launcher. Revisa: lsof -nP -iTCP:$port -sTCP:LISTEN"
fi

: > "$server_log"
chmod 600 "$server_log"
OPENCODE_SERVER_USERNAME="$username" \
OPENCODE_SERVER_PASSWORD="$password" \
  "$binary" serve --hostname 127.0.0.1 --port "$port" > "$server_log" 2>&1 &
server_pid=$!
printf '%s\n' "$server_pid" > "$server_pid_file"
wait_for_server
unauth_status="$(curl --silent --show-error --max-time 5 -o /dev/null -w '%{http_code}' "$local_health" || true)"
[ "$unauth_status" = "401" ] || fail "El health local sin credenciales no está protegido (HTTP $unauth_status)."
verify_local_bind

: > "$tunnel_log"
chmod 600 "$tunnel_log"
cloudflared tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:$port" > "$tunnel_log" 2>&1 &
tunnel_pid=$!
printf '%s\n' "$tunnel_pid" > "$tunnel_pid_file"
wait_for_tunnel_url
wait_for_public_health
verify_public_auth
iphone_url="${tunnel_url}/?auth_token=${auth_token_url}"
verify_login
printf '%s\n' "$iphone_url" > "$url_file"
chmod 600 "$url_file"

printf '\nOpenCode móvil listo.\n'
printf 'URL para Safari: %s\n' "$iphone_url"
printf 'Mantén esta terminal abierta. Control+C detiene el acceso remoto.\n'
printf 'OpenCode: %s\n' "$binary_version"

wait_status=0
wait "$tunnel_pid" || wait_status=$?
if [ "$wait_status" -ne 0 ]; then
  fail "El túnel terminó con error. Log: $tunnel_log"
fi
