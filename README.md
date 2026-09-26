# Registro de proveedores — agente

## Arranque

Requiere Node.js 20+ (verificado con Node 24 en GitHub Codespaces).

```bash
npm install
npm run dev
```

El servidor arranca en `http://localhost:3000`, sirviendo tanto la API (`/api/*`) como el frontend de chat en `web/index.html`.

## Variables de entorno

Copiar `.env.example` a `.env` y completar:

```env
ANTHROPIC_API_KEY=tu_clave_aqui
PORT=3000
```

**Nota**: la API de Anthropic no ofrece capa gratuita permanente. Sin crédito cargado en la cuenta, el servidor arranca y responde correctamente en `/api/health`, pero `/api/chat` devolverá un error de saldo insuficiente al intentar generar una respuesta. Ver `SOLUCION.md`, sección "Estado de verificación end-to-end", para el detalle de qué se verificó sin necesidad de crédito.

## Demo (sin necesidad de API key)

```bash
npm run demo
```

Procesa los 4 casos de `fixtures/reto-01/casos/` de forma determinista, sin consumir ningún modelo. Imprime un resumen por caso en consola.

## Estructura relevante

- `src/server.ts` — API Hono y ciclo del agente.
- `src/tools/proveedor.ts` — cinco herramientas de negocio.
- `src/tools/schemas.ts` — esquemas.
- `src/knowledge/registro-proveedor.md` — conocimiento de dominio.
- `agent/prompt.md` — instrucciones del agente.
-