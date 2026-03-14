# CLAUDE.md — ALEXIS OPS Mission Control
> Este archivo instruye a Claude Code a leer el contexto del sistema al inicio de cada sesión.

---

## AL INICIO DE CADA SESIÓN — LEE ESTOS ARCHIVOS

```
memory/user.md        → Quién es Alexis, estado actual del sistema, números clave
memory/decisions.md   → Decisiones de arquitectura, diseño y patrones establecidos
memory/people.md      → Agentes, proyectos conectados, servicios externos
memory/preferences.md → Estilo de código, patrones UI, preferencias de workflow
```

**Lee todos antes de escribir una sola línea de código.**

---

## SISTEMA

Este es **ALEXIS OPS Mission Control** — un dashboard Node.js/Express local que coordina proyectos de trading, portafolio, estimación y seguridad mediante agentes autónomos.

- **URL local:** http://localhost:3000
- **Arranque:** `cd mission-control && npm install && npm start`
- **Estado:** `data.json` (fuente de verdad para todo)
- **Versión actual:** v16

---

## REGLAS CRÍTICAS (nunca violar)

1. **Trading League = Monitoring Only.** Nunca ejecutar trades reales.
2. **Todas las operaciones externas** de agentes pasan por Security Gateway. Sin excepciones.
3. **API keys** nunca hardcodeadas — siempre desde `db.apiKeys`.
4. **Siempre** llamar `saveDb()` + `broadcast()` después de mutar estado.
5. **Nunca** exponer tokens de bots a agentes — el Gateway inyecta credenciales.
6. **Responder HTTP primero** en endpoints con llamadas AI async, luego broadcast.
7. **Validar** con script de checks antes de empaquetar nueva versión.

---

## AL FINAL DE CADA SESIÓN — ACTUALIZA

Si algo cambió (nueva versión, nuevas decisiones, nuevos agentes, nuevos endpoints):

```bash
# Actualiza el archivo relevante en /memory/
# Ejemplo:
echo "### AD-008 · Nueva decisión..." >> memory/decisions.md
```

Mantén los archivos en `/memory/` actualizados — son la memoria persistente del sistema.

---

## VERSIÓN ACTUAL

```
v16 · server.js ~2,217 líneas · index.html ~9,688 líneas
Último feature: Mission Control Coordination Layer (Dashboard)
Próximo: Resolución SG delayed ops + Infire whitelist api.wix.com
```
