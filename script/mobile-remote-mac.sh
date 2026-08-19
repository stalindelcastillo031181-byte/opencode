#!/usr/bin/env bash

set -euo pipefail

repo_url="https://github.com/stalindelcastillo031181-byte/opencode.git"
branch="mac-mobile-remote"
install_dir="${OPENCODE_MOBILE_DIR:-$HOME/opencode-mobile-fixed}"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/opencode-mobile-remote"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
port="${OPENCODE_MOBILE_PORT:-4096}"
username="${OPENCODE_SERVER_USERNAME:-opencode}"
password_file="$config_dir/mobile-remote-password"
server_log="$state_dir/server.log"
tunnel_log="$state_dir/tunnel.log"
server_pid_file="$state_dir/server.pid"
tunnel_pid_file="$state_dir/tunnel.pid"
built_commit_file="$state_dir/built-commit"

if [ "$(uname -s)" != "Darwin" ]; then
  printf 'Este instalador es únicamente para macOS.\n' >&2
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  printf 'Falta Homebrew. Instálalo desde https://brew.sh y vuelve a ejecutar este comando.\n' >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  brew install bun
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  brew install cloudflared
fi

mkdir -p "$state_dir" "$config_dir"
chmod 700 "$state_dir" "$config_dir"

if [ ! -d "$install_dir/.git" ]; then
  git clone --branch "$branch" --single-branch "$repo_url" "$install_dir"
else
  if [ -n "$(git -C "$install_dir" status --porcelain)" ]; then
    printf 'Hay cambios locales en %s. Guárdalos antes de actualizar.\n' "$install_dir" >&2
    exit 1
  fi
  git -C "$install_dir" fetch origin "$branch"
  git -C "$install_dir" checkout "$branch"
  git -C "$install_dir" merge --ff-only "origin/$branch"
fi

commit="$(git -C "$install_dir" rev-parse HEAD)"
built_commit=""
if [ -f "$built_commit_file" ]; then
  built_commit="$(sed -n '1p' "$built_commit_file")"
fi

binary="$install_dir/packages/opencode/dist/opencode-darwin-x64/bin/opencode"
if [ ! -x "$binary" ] || [ "$built_commit" != "$commit" ]; then
  printf 'Preparando OpenCode móvil corregido (solo la primera vez puede tardar)...\n'
  bun install --cwd "$install_dir"
  bun run --cwd "$install_dir/packages/opencode" build --single --skip-install
  printf '%s\n' "$commit" > "$built_commit_file"
fi

if [ ! -s "$password_file" ]; then
  openssl rand -hex 18 > "$password_file"
  chmod 600 "$password_file"
fi
password="$(sed -n '1p' "$password_file")"

for pid_file in "$server_pid_file" "$tunnel_pid_file"; do
  if [ ! -f "$pid_file" ]; then
    continue
  fi
  old_pid="$(sed -n '1p' "$pid_file")"
  if kill -0 "$old_pid" 2>/dev/null; then
    kill "$old_pid" 2>/dev/null || true
  fi
done

: > "$server_log"
: > "$tunnel_log"

OPENCODE_SERVER_USERNAME="$username" \
OPENCODE_SERVER_PASSWORD="$password" \
  "$binary" web --hostname 127.0.0.1 --port "$port" > "$server_log" 2>&1 &
server_pid=$!
printf '%s\n' "$server_pid" > "$server_pid_file"

cleanup() {
  kill "$server_pid" 2>/dev/null || true
  if [ -n "${tunnel_pid:-}" ]; then
    kill "$tunnel_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 30); do
  if curl -fsS -u "$username:$password" "http://127.0.0.1:$port/global/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then
    printf 'OpenCode no pudo iniciar. Revisa %s\n' "$server_log" >&2
    exit 1
  fi
  sleep 1
done

cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$port" > "$tunnel_log" 2>&1 &
tunnel_pid=$!
printf '%s\n' "$tunnel_pid" > "$tunnel_pid_file"

tunnel_url=""
for _ in $(seq 1 60); do
  tunnel_url="$(sed -nE 's#.*(https://[-a-z0-9]+\.trycloudflare\.com).*#\1#p' "$tunnel_log" | tail -1)"
  if [ -n "$tunnel_url" ]; then
    break
  fi
  if ! kill -0 "$tunnel_pid" 2>/dev/null; then
    printf 'El túnel no pudo iniciar. Revisa %s\n' "$tunnel_log" >&2
    exit 1
  fi
  sleep 1
done

if [ -z "$tunnel_url" ]; then
  printf 'No se recibió una URL pública. Revisa %s\n' "$tunnel_log" >&2
  exit 1
fi

printf '\nOPENCode móvil corregido está activo.\n'
printf 'URL para el iPhone: %s\n' "$tunnel_url"
printf 'Usuario: %s\n' "$username"
printf 'Contraseña: %s\n' "$password"
printf '\nMantén esta terminal abierta. Pulsa Control+C para apagar el acceso remoto.\n'

wait "$tunnel_pid"
