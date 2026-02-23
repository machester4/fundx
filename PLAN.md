# Plan de Implementación — FundX v0.1.0 (Primera Versión Funcional)

## Estado Actual

El scaffolding del proyecto está completo: 11 archivos fuente (~1,100 líneas de TypeScript), CLI con 8 comandos, esquemas Zod, manejo de estado con escrituras atómicas, generación de templates, y daemon con cron. Sin embargo, **nunca se ha compilado ni ejecutado** — las dependencias no están instaladas y faltan archivos de configuración de herramientas.

### Lo que existe (✓) y lo que falta (✗)

| Componente | Estado |
|---|---|
| Esquemas Zod + tipos (`types.ts`) | ✓ Completo |
| Path helpers (`paths.ts`) | ✓ Completo |
| Config global (`config.ts`) | ✓ Completo |
| State CRUD atómico (`state.ts`) | ✓ Completo |
| Template CLAUDE.md (`template.ts`) | ✓ Completo |
| `fundx init` (`init.ts`) | ✓ Completo |
| `fundx fund create/list/info/delete` (`fund.ts`) | ✓ Completo |
| `fundx status` (`status.ts`) | ✓ Completo |
| `fundx session run` (`session.ts`) | ✓ Completo |
| `fundx start/stop` (`daemon.ts`) | ✓ Completo |
| Dependencias instaladas | ✗ Pendiente |
| Build verificado | ✗ Pendiente |
| Type-check sin errores | ✗ Pendiente |
| Configuración ESLint | ✗ Pendiente |
| Configuración Prettier | ✗ Pendiente |
| Configuración Vitest | ✗ Pendiente |
| Comando `fundx logs` | ✗ Pendiente |
| Tests unitarios | ✗ Pendiente |
| Test E2E | ✗ Pendiente |

---

## Fases de Implementación

### Fase 1: Build & Verificación Básica

**Objetivo:** Lograr que el proyecto compile sin errores y sea ejecutable.

#### 1.1 — Instalar dependencias
```bash
pnpm install
```

#### 1.2 — Ejecutar type-check y corregir errores
```bash
pnpm typecheck   # tsc --noEmit
```
- Corregir cualquier error de tipos que surja (posibles issues con imports ESM `.js`, tipos de node-cron, etc.)

#### 1.3 — Build de producción
```bash
pnpm build        # tsup → dist/index.js
```
- Verificar que `dist/index.js` se genera correctamente con shebang `#!/usr/bin/env node`

#### 1.4 — Smoke test del CLI
```bash
pnpm dev -- --help
pnpm dev -- fund --help
pnpm dev -- session --help
```
- Verificar que todos los comandos se registran y muestran ayuda correctamente

---

### Fase 2: Configuración de Herramientas de Desarrollo

**Objetivo:** Configurar linting, formatting, y testing framework.

#### 2.1 — ESLint flat config (`eslint.config.js`)
- Configurar ESLint 9 con flat config
- Incluir `@eslint/js` recommended + `typescript-eslint` strict
- Excluir `dist/`, `node_modules/`
- Ejecutar `pnpm lint` y corregir errores

#### 2.2 — Prettier config (`.prettierrc`)
- Configurar: sin semicolons al final (o con, consistente con el código existente — el código actual usa semicolons)
- Tab width 2, trailing commas, double quotes (consistente con lo existente)
- Ejecutar `pnpm format` y verificar

#### 2.3 — Vitest config (`vitest.config.ts`)
- Configurar Vitest para ESM con TypeScript
- Resolver paths, coverage básico
- Crear directorio `tests/`

---

### Fase 3: Comando `fundx logs`

**Objetivo:** Implementar el comando faltante para ver logs del daemon y de sesiones.

#### 3.1 — Crear `src/logs.ts`

El comando necesita soportar:
```bash
fundx logs                    # Mostrar log del daemon
fundx logs <fund>             # Mostrar session logs de un fund específico
fundx logs --tail             # Seguir logs en tiempo real (tail -f)
fundx logs --lines <n>        # Últimas N líneas
```

**Implementación:**
- Leer `~/.fundx/daemon.log` para logs del daemon
- Leer `~/.fundx/funds/<name>/state/session_log.json` para logs de sesiones
- Agregar log append-only para el daemon (actualmente `DAEMON_LOG` se define en `paths.ts` pero nunca se escribe)

#### 3.2 — Agregar escritura de logs al daemon
- Modificar `daemon.ts` para escribir eventos a `daemon.log` (inicio, parada, sesiones lanzadas, errores)
- Función helper `appendDaemonLog(message: string)` que escribe timestamps + mensajes

#### 3.3 — Registrar comando en `index.ts`
- Importar y agregar `logsCommand` al programa principal

---

### Fase 4: Bugs y Mejoras Detectadas

**Objetivo:** Corregir issues encontrados durante la revisión de código.

#### 4.1 — Daemon no escribe a `daemon.log`
- `paths.ts` define `DAEMON_LOG` pero `daemon.ts` nunca escribe a él
- Agregar logging append-only con timestamps

#### 4.2 — Session history
- `state.ts` solo guarda la **última** sesión en `session_log.json` (sobrescribe)
- Agregar `session_history.json` como array append-only, manteniendo `session_log.json` como último registro
- Alternativa: mantener el diseño actual (solo última sesión) ya que el trade journal en SQLite cubrirá el historial completo en Phase 2

#### 4.3 — Error handling en session runner
- `session.ts` no valida que el comando `claude` exista antes de ejecutarlo
- Agregar verificación con `which claude` o try/catch con mensaje descriptivo

#### 4.4 — Daemon como proceso background
- Actualmente `fundx start` bloquea la terminal (corre en foreground)
- Opciones:
  - a) Fork del proceso con `child_process.fork()` y desconectar stdio
  - b) Mantener foreground pero documentar que se use con `nohup fundx start &` o systemd
  - **Recomendación:** Opción (a) — fork real para mejor UX

---

### Fase 5: Tests

**Objetivo:** Cobertura de tests para la funcionalidad core.

#### 5.1 — Tests unitarios (`tests/unit/`)

| Archivo de test | Módulo bajo test | Qué testear |
|---|---|---|
| `types.test.ts` | `types.ts` | Validación Zod: configs válidos e inválidos, defaults, discriminated unions |
| `paths.test.ts` | `paths.ts` | Paths generados correctamente para diferentes fund names |
| `config.test.ts` | `config.ts` | Load/save/update config con mock de fs |
| `state.test.ts` | `state.ts` | Read/write atómico de portfolio, tracker, session log |
| `template.test.ts` | `template.ts` | Generación de CLAUDE.md para cada tipo de objetivo |

#### 5.2 — Tests de integración (`tests/integration/`)

| Archivo de test | Qué testear |
|---|---|
| `fund-lifecycle.test.ts` | Crear fund → verificar config → verificar state → listar → info → delete |
| `init.test.ts` | Init workspace → verificar estructura de directorios y config.yaml |

#### 5.3 — Test E2E (`tests/e2e/`)

| Archivo de test | Qué testear |
|---|---|
| `cli.test.ts` | Ejecutar CLI como child process: `--help`, `fund list`, `status` |

---

### Fase 6: Verificación Final y Documentación

#### 6.1 — Verificación completa
```bash
pnpm typecheck   # Sin errores
pnpm lint         # Sin warnings
pnpm format       # Código formateado
pnpm test         # Todos los tests pasan
pnpm build        # Build exitoso
```

#### 6.2 — Smoke test E2E manual
```bash
pnpm dev -- init                    # Crear workspace
pnpm dev -- fund create             # Crear fund interactivo
pnpm dev -- fund list               # Verificar fund aparece
pnpm dev -- fund info <name>        # Verificar detalles
pnpm dev -- status                  # Verificar dashboard
pnpm dev -- logs                    # Verificar logs
pnpm dev -- fund delete <name>      # Limpieza
```

#### 6.3 — Actualizar CLAUDE.md
- Marcar items completados en la checklist de Phase 1
- Actualizar cualquier información que haya cambiado

---

## Orden de Ejecución Recomendado

```
Fase 1 (Build)
  └── 1.1 Install → 1.2 Typecheck → 1.3 Build → 1.4 Smoke test
Fase 2 (Herramientas)
  └── 2.1 ESLint → 2.2 Prettier → 2.3 Vitest
Fase 3 (Logs command)
  └── 3.1 logs.ts → 3.2 Daemon logging → 3.3 Registrar en index.ts
Fase 4 (Fixes)
  └── 4.1 Daemon log → 4.2 Session history → 4.3 Claude check → 4.4 Background daemon
Fase 5 (Tests)
  └── 5.1 Unit tests → 5.2 Integration → 5.3 E2E
Fase 6 (Verificación)
  └── 6.1 Full check → 6.2 Manual smoke → 6.3 Update docs
```

## Archivos a Crear

| Archivo | Propósito |
|---|---|
| `eslint.config.js` | ESLint 9 flat config |
| `.prettierrc` | Prettier config |
| `vitest.config.ts` | Vitest config |
| `src/logs.ts` | Comando `fundx logs` |
| `tests/unit/types.test.ts` | Tests de esquemas Zod |
| `tests/unit/paths.test.ts` | Tests de path helpers |
| `tests/unit/config.test.ts` | Tests de config global |
| `tests/unit/state.test.ts` | Tests de state CRUD |
| `tests/unit/template.test.ts` | Tests de generación CLAUDE.md |
| `tests/integration/fund-lifecycle.test.ts` | Test ciclo de vida de fund |
| `tests/integration/init.test.ts` | Test de inicialización |
| `tests/e2e/cli.test.ts` | Test CLI como child process |

## Archivos a Modificar

| Archivo | Cambios |
|---|---|
| `src/index.ts` | Registrar `logsCommand` |
| `src/daemon.ts` | Agregar escritura a `daemon.log`, opción fork para background |
| `src/session.ts` | Validar existencia de `claude` CLI, mejor error handling |
| `src/state.ts` | (Opcional) Session history append-only |
| `CLAUDE.md` | Actualizar checklist Phase 1 |

## Criterios de Aceptación

La primera versión funcional estará lista cuando:

1. ✗ `pnpm install` completa sin errores
2. ✗ `pnpm typecheck` pasa sin errores
3. ✗ `pnpm build` genera `dist/index.js` correctamente
4. ✗ `pnpm lint` pasa sin errores
5. ✗ `pnpm format` no produce cambios
6. ✗ `pnpm test` — todos los tests pasan
7. ✗ `fundx --help` muestra todos los comandos
8. ✗ `fundx init` crea workspace correctamente
9. ✗ `fundx fund create` crea un fund con toda su estructura
10. ✗ `fundx status` muestra dashboard
11. ✗ `fundx logs` muestra logs
12. ✗ `fundx fund delete` limpia correctamente
