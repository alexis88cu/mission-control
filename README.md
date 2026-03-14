# MISSION CONTROL — ALEXIS OPS v2.0
## Local Web Server — Setup & Run

---

### REQUISITOS
- Node.js v18 o superior (descarga: https://nodejs.org)

---

### INSTALACIÓN (una sola vez)

```bash
# 1. Entrar a la carpeta
cd mission-control

# 2. Instalar dependencias
npm install
```

---

### ARRANCAR EL SERVIDOR

```bash
npm start
```

O con auto-restart al guardar cambios:
```bash
npm run dev
```

---

### ACCEDER AL DASHBOARD

Abre tu navegador en:
**http://localhost:3000**

---

### CARACTERÍSTICAS

| Característica | Descripción |
|---|---|
| **WebSocket** | Actualizaciones en tiempo real cada 3 segundos |
| **REST API** | CRUD completo para proyectos, agentes, blockers |
| **AI Chat** | Conectado a Claude (Anthropic API) |
| **API Vault** | Gestión segura de todas tus API keys |
| **Simulación** | Los agentes generan heartbeats y eventos automáticamente |
| **Persistencia** | Los datos se guardan en `data.json` |

---

### ENDPOINTS API

| Método | Endpoint | Descripción |
|---|---|---|
| GET | /api/state | Estado completo del sistema |
| GET/POST | /api/projects | Listar/crear proyectos |
| GET/PATCH/DELETE | /api/projects/:id | Proyecto específico |
| GET/POST | /api/agents | Listar agentes |
| PATCH | /api/agents/:id | Actualizar agente |
| GET/POST | /api/blockers | Listar/crear blockers |
| PATCH | /api/blockers/:id | Actualizar blocker |
| GET/POST | /api/events | Logs de eventos |
| GET/POST | /api/keys | API keys |
| GET | /api/metrics | Métricas del sistema |
| GET | /api/health | Health check |

---

### CONFIGURAR AI CHAT

1. Abre el dashboard → **API Vault**
2. Edita la key **"Anthropic Claude"**
3. Pega tu API key (empieza con `sk-ant-api03-...`)
4. Guarda → Ve a **AI Chat** y empieza a chatear

---

### SEGURIDAD

- Las API keys se guardan localmente en `data.json`
- El servidor corre solo en `localhost:3000`
- No exponer el puerto 3000 a internet directamente
- Para producción: usar HTTPS + autenticación

---

### ESTRUCTURA DE ARCHIVOS

```
mission-control/
├── server.js          ← Servidor principal (Express + WebSocket)
├── data.json          ← Base de datos local (proyectos, agentes, etc.)
├── package.json       ← Dependencias
├── public/
│   └── index.html     ← Dashboard completo (frontend)
└── README.md          ← Este archivo
```
