# Registro de proveedores — agente

## Arranque

```bash
bun install && bun run dev
```

El script `dev` debe levantar `src/server.ts` y servir `web/` concurrentemente.

## Variables de entorno

Copiar `.env.example` a `.env` y completar:

```env
ANTHROPIC_API_KEY=
PORT=3000
```

## Demo

```bash
bun run demo.ts
```

## Estructura relevante

- `src/server.ts` — API Hono y ciclo del agente.
- `src/tools/proveedor.ts` — cinco herramientas de negocio.
- `src/tools/schemas.ts` — esquemas.
- `src/knowledge/registro-proveedor.md` — conocimiento de dominio.
- `agent/prompt.md` — instrucciones del agente.
- `src/llm/adapter.ts` / `src/llm/anthropic.ts` — frontera e implementación LLM.
- `web/index.html` — frontend vanilla.
- `out/<caso>/log.jsonl` — trazabilidad de herramientas.

## Despliegue

**Link de despliegue:** `<PLACEHOLDER_DEPLOYMENT_URL>`
