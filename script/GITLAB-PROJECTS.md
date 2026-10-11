# Selector de proyectos GitLab (OpenCode remoto · iPhone)

El selector del centro de la pantalla de OpenCode muestra los proyectos de GitLab que están en
`~/.config/opencode/gitlab-projects.json` y que ya tienen carpeta en el Mac. No toca Cloudflare ni el worker.

## Activar (un solo comando)

```
bash ~/opencode-mobile-fixed/script/restart-proxy.sh
```

Comprueba la sintaxis (si falla, no toca nada), reinicia el proxy, espera hasta 60 s a que `proxy.pid` cambie y a que
`GET /__opencode_remote/gitlab-projects` responda 200. Si el proxy no vuelve, restaura el original y lo reinicia otra vez.
Después, recarga la página en el iPhone.

### Quién relanza el proxy (evidencia)

- `~/Library/LaunchAgents/com.stalin.opencode-remote.plist`: ejecuta `mobile-remote-supervisor.py` con `KeepAlive=true`
  y `ThrottleInterval=5`.
- El supervisor revisa sus hijos (`server`, `proxy`, `tunnel`); si uno muere lo relanza (espera mínima de 5 s) y escribe
  el PID nuevo en `~/.local/state/opencode-mobile-remote/proxy.pid`.
- `supervisor.log` tiene 71 líneas «proxy started» con PIDs distintos, entre ellas las de recargas manuales del 28-sep y 1-oct.

## Qué hace el módulo (`script/gitlab-projects.cjs`)

1. **Selector**: el proxy inyecta en el HTML un script que *mezcla* los proyectos con carpeta en
   `localStorage["opencode.global.dat:server"].projects.local`. Los añade al final, una sola vez por proyecto, y no cambia
   nada más del almacén. Si cierras un proyecto en el selector queda una lápida (`stalin.gitlab-projects.v2`) y no vuelve.
   No crea el almacén si la app aún no lo ha creado.
2. **Sincronización** (a los 20 s de arrancar el proxy y cada 30 min; `POST /__opencode_remote/gitlab-sync` la fuerza):
   carpeta que no existe → `git clone`; carpeta que existe → solo `git fetch` (y solo si su `origin` es el del manifiesto).
   Nunca `pull`, `merge`, `reset` ni `checkout`; un árbol con cambios no se toca. Un solo sync a la vez (lock de archivo),
   timeout por operación (local 60 s · fetch 5 min · clone 20 min).
3. **Estado**: `GET /__opencode_remote/gitlab-projects` (detrás de la auth del proxy) devuelve, por proyecto, si está
   presente, rama, HEAD, cambios locales, `ahead/behind` y el motivo del último fallo.
4. **Log**: `~/.local/state/opencode-mobile-remote/gitlab-sync.log` (una línea por operación: fecha, proyecto, operación,
   resultado, motivo = `credenciales` | `red` | `timeout` | `ruta_ocupada` | `permisos` | `origin_distinto` | …).

## Manifiesto

`~/.config/opencode/gitlab-projects.json` (ejemplo en `script/gitlab-projects.example.json`):

| Campo | Significado |
| --- | --- |
| `name` | identificador (letras, números, `.`, `_`, `-`) |
| `url` | `https://gitlab.com/<grupo>/<proyecto>.git` (sin credenciales) |
| `dir` | opcional: clon existente que se usa tal cual (nunca se copia); debe estar bajo `$HOME`. Si falta, `<root>/<name>` |
| `selector` | `false` = sincroniza pero no lo muestra |
| `path`, `branch` | informativos |

El nombre visible en el selector es el nombre de la carpeta (`dir`), por eso el control remoto usa `CONTROL REMOTO IA`.

## Verificar

```
node --test script/test/gitlab-projects.test.cjs script/test/proxy-inprocess.test.cjs   # 39 pruebas, sin red ni puertos
bash script/smoke-test.sh                                                              # sockets reales en 4196/4198
```

`proxy-inprocess` ejecuta el archivo real `mobile-remote-proxy.cjs` con `node:http` sustituido por un doble.
`smoke-test.sh` necesita abrir puertos locales (sale con 3 = «no ejecutada» si no puede). Sus aserciones se pueden
comprobar sin sockets: `node script/test/make-fixtures.cjs <dir> && SMOKE_ASSERT_ONLY=<dir> bash script/smoke-test.sh`.

## Volver atrás

```
cp ~/.local/state/opencode-mobile-remote/mobile-remote-proxy.cjs.backup-before-gitlab-projects-20261011 ~/opencode-mobile-fixed/script/mobile-remote-proxy.cjs
kill $(cat ~/.local/state/opencode-mobile-remote/proxy.pid)
```

## Rama y lanzador

Este trabajo está en la rama `feat/gitlab-project-selector` (sin push). El supervisor ejecuta los archivos del árbol de
trabajo de `~/opencode-mobile-fixed`, así que ese árbol debe seguir en esa rama (o con el merge hecho) para que el proxy
conserve el selector. `script/mobile-remote-mac.sh` exige estar en `mac-mobile-remote`; para integrarlo:

```
cd ~/opencode-mobile-fixed && git switch mac-mobile-remote && git merge --ff-only feat/gitlab-project-selector
```

## Límites conocidos

- La carpeta `~/Documents/ODOMETRO/odometro` está en una ruta que macOS protege (privacidad de Documentos). Si el proceso
  del proxy no tiene permiso, el proyecto no aparece y el estado/log dicen `permisos`.
- `magenta-real` usa `~/magenta-real-gitlab-close`, que puede tener cambios sin commit: el sync no la toca, pero OpenCode
  sí podrá editarla desde el iPhone.
- Los clones nuevos usan las credenciales de git del Mac. Sin ellas el log dice `credenciales` y el proyecto no aparece.
- El selector depende de la clave `opencode.global.dat:server` de la app; si una versión nueva de la app la cambia, la
  siembra no hace nada (no rompe) y hay que actualizar `SEED_BODY`.
