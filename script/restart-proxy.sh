#!/usr/bin/env bash
# Reinicia el proxy del remoto OpenCode y verifica que la versión nueva (selector de proyectos GitLab) quedó viva.
#
#   bash ~/opencode-mobile-fixed/script/restart-proxy.sh
#
# Qué hace (y por qué es seguro):
#   1. comprueba la sintaxis de proxy y módulo; si falla, NO toca nada;
#   2. envía SIGTERM al PID de proxy.pid: launchd mantiene vivo el supervisor (KeepAlive) y el supervisor
#      relanza el proxy a los pocos segundos (backoff mínimo de 5 s);
#   3. espera hasta 60 s a que proxy.pid cambie y GET /__opencode_remote/gitlab-projects responda 200;
#   4. si el proxy no vuelve, restaura el respaldo del original y lo reinicia otra vez.
# Salida: 0 = activo · 1 = falló (se restauró el original) · 2 = el proxy volvió pero sin el módulo GitLab.
set -u
STATE="$HOME/.local/state/opencode-mobile-remote"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROXY="$ROOT/script/mobile-remote-proxy.cjs"
MOD="$ROOT/script/gitlab-projects.cjs"
BACKUP="$STATE/mobile-remote-proxy.cjs.backup-before-gitlab-projects-20261011"
PWFILE="$HOME/.config/opencode/mobile-remote-password"
NODE="$(command -v node || echo /usr/local/bin/node)"
PORT="${OPENCODE_REMOTE_PORT:-4097}"

# código HTTP del proxy local; la contraseña viaja por stdin, no por argumentos
code() { printf 'user = "opencode:%s"\n' "$(cat "$PWFILE")" | curl -s -o /dev/null -w '%{http_code}' -m 5 -K - "http://127.0.0.1:$PORT$1" 2>/dev/null; }
wait_for_new_pid() { # $1 = pid viejo; espera hasta 60 s
  local i new
  for i in $(seq 1 60); do
    sleep 1
    new="$(cat "$STATE/proxy.pid" 2>/dev/null)"
    if [ -n "$new" ] && [ "$new" != "$1" ] && kill -0 "$new" 2>/dev/null; then echo "$new"; return 0; fi
  done
  return 1
}

echo "1/4 comprobando sintaxis…"
"$NODE" --check "$PROXY" && "$NODE" --check "$MOD" || { echo "ABORTO: sintaxis inválida; no toqué nada."; exit 1; }
old="$(cat "$STATE/proxy.pid" 2>/dev/null)"
[ -n "$old" ] || { echo "ABORTO: no existe $STATE/proxy.pid"; exit 1; }

echo "2/4 reiniciando el proxy (pid $old)…"
kill "$old" 2>/dev/null || { echo "ABORTO: no pude enviar la señal al PID $old."; exit 1; }

echo "3/4 esperando el relanzamiento del supervisor (máx. 60 s)…"
if new="$(wait_for_new_pid "$old")"; then
  for _ in $(seq 1 30); do
    [ "$(code /__opencode_remote/gitlab-projects)" = "200" ] && break
    sleep 1
  done
  g="$(code /__opencode_remote/gitlab-projects)"
  h="$(code /global/health)"
  echo "4/4 verificación: proxy $old -> $new | /__opencode_remote/gitlab-projects=$g | /global/health=$h"
  if [ "$g" = "200" ]; then
    echo "OK: selector GitLab activo. Recarga la página en el iPhone (los proyectos clonados aparecen al recargar)."
    exit 0
  fi
  echo "AVISO: el proxy volvió pero el módulo GitLab no responde (el proxy funciona como antes). Mira: tail -20 $STATE/proxy.log"
  exit 2
fi

echo "FALLO: el proxy no volvió en 60 s. Restaurando el original y reiniciando de nuevo…"
cp "$BACKUP" "$PROXY" && echo "original restaurado desde $BACKUP"
cur="$(cat "$STATE/proxy.pid" 2>/dev/null)"
[ -n "$cur" ] && kill "$cur" 2>/dev/null
if new="$(wait_for_new_pid "${cur:-$old}")"; then echo "proxy original relanzado (pid $new); /global/health=$(code /global/health)"; else echo "El supervisor no relanza el proxy. Revisa: tail -30 $STATE/supervisor.log"; fi
exit 1
