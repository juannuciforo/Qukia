# QUKia Backend API

Backend para la plataforma QUKia — chat de IA analítico sobre modelos Power BI, multi-tenant, con sistema de créditos.

---

## Stack

| Componente | Tecnología |
|---|---|
| Runtime | Node.js 20+ |
| Framework | Express 4 |
| ORM / DB | Prisma + PostgreSQL 16 |
| Cache | Redis 7 |
| AI | Anthropic SDK (claude-sonnet-4) |
| Datos | Power BI REST API + DAX |
| Auth | JWT (access 15min + refresh 7d) |

---

## Arranque local

### 1. Requisitos previos

- Node.js 20+
- Docker + Docker Compose

### 2. Clonar e instalar

```bash
npm install
npx prisma generate
```

### 3. Levantar infraestructura

```bash
docker compose up -d
```

Postgres en `localhost:5432`, Redis en `localhost:6379`.

### 4. Variables de entorno

```bash
cp .env.example .env
# Editar .env: añadir ANTHROPIC_API_KEY y credenciales PBI
```

### 5. Migrar y seed

```bash
npm run db:migrate     # crea las tablas
npm run db:seed        # crea admin, planes, demo tenant
```

### 6. Arrancar

```bash
npm run dev
```

API disponible en `http://localhost:3000`.

---

## Arquitectura

```
┌─────────────────────────────────────────────────────┐
│  Admin Panel (SUPERADMIN)    User Panel (tenant)     │
└──────────────┬──────────────────────┬───────────────┘
               │                      │
         /admin/*                 /user/*
               │                      │
┌──────────────▼──────────────────────▼───────────────┐
│              Express API (src/index.js)               │
│  helmet · cors · rate-limit · morgan · error handler  │
└──────────────┬──────────────────────┬───────────────┘
               │                      │
      requireSuperAdmin     authenticate + resolveTenant
               │             + assertTenantAccess
               │                      │
               │             (chat) checkCredits
               │                      │
┌──────────────▼──────────────────────▼───────────────┐
│  Route handlers                                       │
│  admin/: dashboard · tenants · users · models ·       │
│          prompts · plans · logs                       │
│  user/:  chat · files · prompts · models · account    │
└──────────────┬──────────────────────┬───────────────┘
               │                      │
     ┌─────────▼──────┐    ┌──────────▼──────────┐
     │  Prisma (DB)   │    │  services/ai.js      │
     │  PostgreSQL    │    │  Claude + DAX loop   │
     └────────────────┘    └──────────┬───────────┘
                                      │
                           ┌──────────▼──────────┐
                           │  services/powerbi.js │
                           │  OAuth2 + DAX exec   │
                           └─────────────────────┘
```

---

## Agentic AI Loop

El flujo de un mensaje de chat:

```
User message
    │
    ▼
Claude (con schema PBI como contexto)
    │
    ├── necesita datos → tool_use: run_dax_query
    │       │
    │       ▼
    │   services/powerbi.runDaxQuery()
    │       │
    │       ▼
    │   Power BI REST API (DAX execution)
    │       │
    │       ▼
    │   rows[] → tool_result → Claude
    │       │
    │       └── (repite hasta max 5 iteraciones)
    │
    ▼
Respuesta final (streamed via SSE)
    │
    ▼
deductCredits(ceil(totalTokens / TOKENS_PER_CREDIT))
```

---

## API Reference

### Auth

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/auth/login` | Login → access + refresh token |
| POST | `/auth/refresh` | Rotar refresh token |
| POST | `/auth/logout` | Invalidar refresh token |
| GET  | `/auth/me` | Datos del usuario autenticado |

### Admin (requiere SUPERADMIN)

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/admin/dashboard` | Métricas globales |
| GET/POST | `/admin/tenants` | Listar / crear tenant |
| GET/PATCH/DELETE | `/admin/tenants/:id` | Leer / editar / suspender |
| POST | `/admin/tenants/:id/credits` | Añadir/resetear créditos |
| GET/POST/PATCH/DELETE | `/admin/users` | CRUD usuarios |
| GET/POST/PATCH/DELETE | `/admin/models` | CRUD modelos PBI |
| POST | `/admin/models/:id/test` | Test conectividad PBI |
| GET/POST/PATCH/DELETE | `/admin/prompts` | CRUD prompts globales |
| GET/POST/PATCH | `/admin/plans` | CRUD planes |
| GET | `/admin/logs` | Audit log |

### User (requiere USER/TENANT_ADMIN del tenant)

| Método | Ruta | Descripción |
|---|---|---|
| POST | `/user/chat/message` | Enviar mensaje (SSE stream) |
| POST | `/user/chat/confirm` | Confirmar y persistir respuesta |
| GET | `/user/chat/conversations` | Historial de conversaciones |
| GET | `/user/chat/conversations/:id` | Conversación con mensajes |
| DELETE | `/user/chat/conversations/:id` | Eliminar conversación |
| GET | `/user/models` | Modelos disponibles |
| POST | `/user/files` | Subir archivo |
| GET | `/user/files` | Listar archivos |
| POST | `/user/files/:id/analyze` | Analizar archivo con IA |
| DELETE | `/user/files/:id` | Eliminar archivo |
| GET/POST/PATCH/DELETE | `/user/prompts` | CRUD prompts personales |
| GET | `/user/account` | Datos cuenta + créditos |
| PATCH | `/user/account` | Actualizar nombre/contraseña |
| GET | `/user/account/usage` | Historial de consumo |

---

## SSE Chat Protocol

```javascript
// Cliente — ejemplo mínimo
const res = await fetch('/user/chat/message', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ modelId, message }),
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
let fullResponse = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const lines = decoder.decode(value).split('\n');
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice(6));

    if (event.type === 'conversation_id') {
      // Guardar conversationId para continuar el hilo
    }
    if (event.type === 'token') {
      fullResponse += event.text;
      // renderizar token en UI
    }
    if (event.type === 'tool_running') {
      // mostrar "Consultando datos: [description]"
    }
    if (event.type === 'done') {
      // confirmar mensaje
      await fetch('/user/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          conversationId: savedConversationId,
          content: fullResponse,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          creditsUsed: event.credits,
        }),
      });
    }
  }
}
```

---

## Variables de entorno

Ver `.env.example` para la lista completa con descripciones.

Las únicas obligatorias para arrancar:

```
DATABASE_URL
JWT_SECRET
JWT_REFRESH_SECRET
ANTHROPIC_API_KEY
```

Para conectar Power BI (global fallback si el modelo no tiene credenciales propias):

```
PBI_CLIENT_ID
PBI_CLIENT_SECRET
PBI_TENANT_ID
```

---

## Producción

```bash
# Migración sin downtime
npm run db:migrate:prod

# Start
NODE_ENV=production npm start
```

Recomendaciones:
- Usar PM2 o systemd para process management
- Nginx como reverse proxy con SSL termination
- Subdominio wildcard `*.quikia.cookdata.io` apuntando al servidor
- Variables de entorno via secretos (Railway, Render, AWS Secrets Manager, etc.)
