# SOLUCION.md

## 1. Problema en una frase

Automatizar y trazabilizar el registro de proveedores a partir de solicitudes y documentos heterogéneos, preparando formularios, paquetes y valores para portal sin inventar datos ni ejecutar envíos sin confirmación humana.

## 2. Arquitectura

```text
Front (web/index.html)
        |
        v
Backend Hono (src/server.ts)
        |
        v
Agente + Claude Sonnet 4.6
        |
        v
Herramientas (src/tools/proveedor.ts)
        |
        +--> XLSX / PDF / paquete / simulación
        |
        v
out/<caso>/log.jsonl

Prompt: agent/prompt.md
Conocimiento: src/knowledge/registro-proveedor.md
Ejecución: src/server.ts + src/tools/proveedor.ts
```

El frontend conversa únicamente con `/api/chat`; el backend conserva sesiones en memoria y orquesta el ciclo agente-herramientas. Cada herramienta registra su ejecución mediante la función `registrarLog` compartida.

## 3. Ciclo del agente

El ciclo parte de la solicitud del usuario y permite hasta **25 iteraciones** entre modelo y herramientas. El flujo esperado es `proveedor_leer_solicitud` → `proveedor_mapear_campos` → `proveedor_generar_formulario` → `proveedor_armar_paquete` → confirmación explícita → `proveedor_simular_envio`.

`needsConfirmation=true` indica que el agente ha llegado a un punto en el que necesita una decisión humana antes de ejecutar la simulación de envío. La interfaz lo destaca y deja la interacción centrada en responder mediante el input; nunca se debe interpretar la simulación como un envío real.

### Estado de verificación end-to-end

`demo.ts` fue ejecutado exitosamente contra los 4 casos de fixtures, de forma determinista y sin ninguna clave de API, confirmando el comportamiento de las 5 herramientas (incluyendo casos límite: soporte sin fecha de vencimiento, formato portal sin automatizar).

El ciclo del agente con modelo real (`src/server.ts` + adaptador de Anthropic) fue verificado hasta el punto de comunicación exitosa con la API: el servidor arma correctamente el system prompt, convierte las herramientas al formato esperado por Claude, y envía la solicitud. La prueba de esto es que el error devuelto en las pruebas provino explícitamente de Anthropic por saldo insuficiente en la cuenta de prueba (la API no ofrece capa gratuita permanente), no de una falla de integración. No fue posible completar una conversación end-to-end con respuesta del modelo por esta limitación de crédito.

## 4. Elección del modelo

Se usa **Claude Sonnet 4.6 vía API directa de Anthropic**, por su equilibrio entre capacidad de seguimiento de instrucciones, uso de herramientas y costo para un flujo agenteico de varias iteraciones. Anthropic publica para Sonnet 4.6 US$3/M tokens de entrada y US$15/M de salida en la API estándar global. 

## 5. Diseño del portal web

Siguiendo la sección 7.4 del PRD, el portal se plantea con una estrategia de **RPA/navegador controlado** solo como evolución futura; la solución actual no automatiza el portal y genera `valores-portal.md`.

El agente prepara y verifica los valores que deben ingresarse. El humano conserva el control de credenciales, CAPTCHA/MFA y del clic final de envío. CAPTCHA y MFA no se deben intentar eludir ni automatizar.

Las credenciales nunca viven en el repositorio, prompt ni logs. Las ingresa el humano directamente en el portal. El agente prepara valores y guía la carga; el humano introduce credenciales y ejecuta el envío.

## 6. Decisiones y trade-offs

1. **exceljs vs SheetJS** — Se eligió `exceljs` por el mayor control sobre celdas, estilos y estructura del XLSX. Se descartó SheetJS porque el caso requiere mayor control de presentación y manipulación de celdas.
2. **Sesiones en memoria vs archivo** — Se eligió `Map` en memoria por simplicidad y alcance de prototipo. Se descartó persistencia en archivo porque añade coordinación, concurrencia y manejo de estado innecesarios para esta versión.
3. **Hono vs Express** — Se eligió Hono por su API pequeña y adecuada para el backend HTTP del proyecto. Se descartó Express por ser más pesado para este alcance y requerir más estructura alrededor de un servidor sencillo.
4. **Node + tsx vs Bun** — El código base se escribió originalmente asumiendo el runtime de Bun (`Bun.serve`), pero el entorno de desarrollo disponible solo tenía Node.js. Se migró el arranque del servidor a `@hono/node-server` y se resolvió un import dinámico incompatible con módulos ES (`require` de CommonJS) para garantizar compatibilidad con Node 20+, que es el runtime mínimo aceptado según el PRD.

## 7. Supuestos

- Los fixtures del proyecto representan casos controlados y reproducibles para demostrar el flujo; no sustituyen una integración con fuentes productivas.
- Existe un repositorio maestro de proveedores y se asume que está actualizado cuando se utiliza como fuente de referencia.
- Los documentos de entrada tienen suficiente información para que las herramientas puedan identificar campos o declarar explícitamente faltantes.
- La generación de PDF crea un documento nuevo con `pdf-lib`; no depende de AcroForm.
- Los datos bancarios solo se manejan cuando la plantilla los exige y no se divulgan en correo.
- El portal web sigue siendo una interacción humana; `proveedor_simular_envio` no representa un envío real.

## 8. Cobertura: tabla HU-1 a HU-5

| Historia | Estado (hecho/parcial/no hecho) | Qué falta para producción |
|---|---|---|
| HU-1 | hecho | Integrar fuentes productivas y controles de acceso. |
| HU-2 | hecho | Validación contra maestro productivo, reglas por país y auditoría formal. |
| HU-3 | hecho | Pruebas con plantillas productivas y criterios de aceptación por formato. |
| HU-4 | hecho | Almacenamiento seguro, versionado y políticas de retención del paquete. |
| HU-5 | hecho | Cobertura de pruebas automatizadas de errores (caso inexistente, plantilla corrupta, formato no soportado); todas las herramientas devuelven `{ok:false, error}` sin lanzar excepción, verificado en `demo.ts` con los 4 casos. |

## 9. Uso de IA

Se utilizó un asistente de código para acelerar la generación de las herramientas, el adaptador LLM, el backend y el frontend, manteniendo las reglas de negocio y los contratos explícitos en archivos del proyecto. La IA se usó como acelerador de implementación, no como fuente autónoma de datos de proveedores. Se descartó una librería de automatización completa del portal por la complejidad operativa y las barreras de CAPTCHA/MFA. La validación final sigue dependiendo de fixtures, reglas deterministas y confirmación humana.

## 10. Riesgos de producción

- **El modelo alucina un valor.** Mitigación: CA2 en `agent/prompt.md`, prohibición de afirmar valores no obtenidos de herramientas, estados `faltante`/`requiere_confirmacion` y trazabilidad en `log.jsonl`.
- **Credenciales del portal expuestas.** Mitigación: no almacenar credenciales en repo, prompt ni logs; ingreso exclusivo por humano y separación del paso de autenticación.
- **Dependencia de un solo proveedor LLM.** Mitigación: mantener `src/llm/adapter.ts` como frontera de integración y permitir implementar otro adaptador sin acoplar las herramientas al proveedor.
- **Ejecución accidental de envío.** Mitigación: `needsConfirmation`, confirmación explícita y `proveedor_simular_envio` en lugar de un envío real.
- **Sesiones en memoria pierden estado.** Mitigación: aceptarlo como alcance del prototipo y migrar a almacenamiento persistente antes de operación multiinstancia.
