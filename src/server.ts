import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

import { Hono } from "hono";
import { z } from "zod";

import {
  leer_solicitud,
  mapear_campos,
  generar_formulario,
  armar_paquete,
  simular_envio,
} from "./tools/proveedor";

import { AnthropicAdapter } from "./llm/anthropic";
import type {
  LLMError,
  Mensaje,
  ToolCall,
  ToolDef,
} from "./llm/adapter";

const MAX_ITERACIONES = 25;
const MODEL = "claude-sonnet-4-6";

const systemPrompt = readFileSync(
  path.resolve(process.cwd(), "agent", "prompt.md"),
  "utf8",
);

const adapter = new AnthropicAdapter({
  systemPrompt,
  model: MODEL,
  timeoutMs: 30_000,
});

type ToolImplementation = {
  name: string;
  description: string;
  args: Record<string, z.ZodType<unknown>>;
  execute: (
    args: Record<string, unknown>,
    ctx: {
      directory: string;
      sessionId: string;
    },
  ) => Promise<string>;
};

type ToolCallSummary = {
  name: string;
  args: unknown;
  resultado_resumen: string;
};

type TurnResult = {
  reply: string;
  toolCalls: ToolCallSummary[];
  needsConfirmation: boolean;
};

type ToolExecutionResult = {
  resultado: string;
  resumen: string;
};

type SessionState = {
  mensajes: Mensaje[];
};

const sesiones = new Map<string, SessionState>();

const herramientas: ToolImplementation[] = [
  { ...leer_solicitud, name: "proveedor_leer_solicitud" },
  { ...mapear_campos, name: "proveedor_mapear_campos" },
  { ...generar_formulario, name: "proveedor_generar_formulario" },
  { ...armar_paquete, name: "proveedor_armar_paquete" },
  { ...simular_envio, name: "proveedor_simular_envio" },
] as ToolImplementation[];

const herramientasPorNombre = new Map(
  herramientas.map((herramienta) => [
    herramienta.name,
    herramienta,
  ]),
);

function obtenerHerramientasLLM(): ToolDef[] {
  return herramientas.map((herramienta) => ({
    name: herramienta.name,
    description: herramienta.description,
    args: herramienta.args,
  }));
}

function esRegistro(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorToString(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "error inesperado";
}

function resumirResultado(resultado: string): string {
  try {
    const parsed: unknown = JSON.parse(resultado);

    if (!esRegistro(parsed)) {
      return resultado.slice(0, 500);
    }

    if (parsed.ok === true) {
      return JSON.stringify(parsed.data ?? {});
    }

    if (
      parsed.ok === false &&
      typeof parsed.error === "string"
    ) {
      return parsed.error;
    }

    return resultado.slice(0, 500);
  } catch {
    return resultado.slice(0, 500);
  }
}

function contienePreguntaConfirmacion(
  contenido: string | undefined,
): boolean {
  if (!contenido) {
    return false;
  }

  const normalizado = contenido.trim().toLowerCase();

  if (!normalizado.endsWith("?")) {
    return false;
  }

  return (
    normalizado.includes("confirma") ||
    normalizado.includes("envío") ||
    normalizado.includes("envio")
  );
}

function obtenerCasoDeArgs(args: unknown): string | undefined {
  if (!esRegistro(args)) {
    return undefined;
  }

  return typeof args.caso === "string"
    ? args.caso
    : undefined;
}

async function registrarLog(
  sessionId: string,
  toolCall: ToolCall,
  ok: boolean,
  resumen: string,
): Promise<void> {
  const caso = obtenerCasoDeArgs(toolCall.args);

  const directorioBase = caso
    ? path.resolve(
        process.cwd(),
        "out",
        caso,
      )
    : path.resolve(
        process.cwd(),
        "out",
        sessionId,
      );

  const logPath = path.join(
    directorioBase,
    "log.jsonl",
  );

  const entrada = {
    ts: new Date().toISOString(),
    herramienta: toolCall.name,
    ok,
    resumen,
  };

  try {
    await fs.mkdir(directorioBase, {
      recursive: true,
    });

    await fs.appendFile(
      logPath,
      `${JSON.stringify(entrada)}\n`,
      "utf8",
    );
  } catch {
    // El logging no debe tumbar el ciclo principal.
  }
}

async function ejecutarHerramienta(
  toolCall: ToolCall,
  sessionId: string,
): Promise<ToolExecutionResult> {
  const herramienta =
    herramientasPorNombre.get(toolCall.name);

  if (!herramienta) {
    const resultado = JSON.stringify({
      ok: false,
      error: `herramienta no encontrada: ${toolCall.name}`,
    });

    return {
      resultado,
      resumen: `herramienta no encontrada: ${toolCall.name}`,
    };
  }

  const argsSchema = z.object(herramienta.args);
  const validacion = argsSchema.safeParse(
    toolCall.args,
  );

  if (!validacion.success) {
    const resultado = JSON.stringify({
      ok: false,
      error: `argumentos inválidos: ${validacion.error.message}`,
    });

    return {
      resultado,
      resumen: `argumentos inválidos: ${validacion.error.message}`,
    };
  }

  let resultado: string;

  try {
    resultado = await herramienta.execute(
      validacion.data,
      {
        directory: process.cwd(),
        sessionId,
      },
    );
  } catch (error: unknown) {
    resultado = JSON.stringify({
      ok: false,
      error: errorToString(error),
    });
  }

  return {
    resultado,
    resumen: resumirResultado(resultado),
  };
}

function mensajeErrorLLM(error: LLMError): string {
  switch (error.code) {
    case "missing_api_key":
      return "El proveedor LLM no está configurado: falta ANTHROPIC_API_KEY.";
    case "timeout":
      return "El proveedor LLM tardó demasiado en responder. La sesión permanece disponible para continuar.";
    case "network_error":
      return `No fue posible comunicarse con el proveedor LLM: ${error.message}`;
    case "http_error":
      return `El proveedor LLM devolvió un error: ${error.message}`;
    case "invalid_response":
      return `El proveedor LLM devolvió una respuesta inválida: ${error.message}`;
  }
}

function construirRespuestaTope(): string {
  return [
    "Se alcanzó el límite de 25 iteraciones del ciclo del agente.",
    "El proceso se detuvo para evitar continuar automáticamente.",
    "Lo alcanzado queda registrado en el historial de la sesión.",
    "Falta continuar con los pasos que todavía no hayan sido ejecutados.",
  ].join(" ");
}

export async function ejecutarTurno(
  sessionId: string,
  mensajeUsuario: string,
): Promise<TurnResult> {
  let session = sesiones.get(sessionId);

  if (!session) {
    session = {
      mensajes: [],
    };

    sesiones.set(sessionId, session);
  }

  session.mensajes.push({
    role: "user",
    content: mensajeUsuario,
  });

  const toolCallsEjecutados: ToolCallSummary[] = [];
  let needsConfirmation = false;
  let ultimaRespuestaAsistente: string | undefined;

  for (
    let iteracion = 0;
    iteracion < MAX_ITERACIONES;
    iteracion += 1
  ) {
    let respuesta;

    try {
      respuesta = await adapter.enviar(
        session.mensajes,
        obtenerHerramientasLLM(),
      );
    } catch (error: unknown) {
      const reply = `Error del proveedor LLM: ${errorToString(error)}`;

      session.mensajes.push({
        role: "assistant",
        content: reply,
      });

      return {
        reply,
        toolCalls: toolCallsEjecutados,
        needsConfirmation,
      };
    }

    if (respuesta.error) {
      const reply = mensajeErrorLLM(
        respuesta.error,
      );

      session.mensajes.push({
        role: "assistant",
        content: reply,
      });

      return {
        reply,
        toolCalls: toolCallsEjecutados,
        needsConfirmation,
      };
    }

    ultimaRespuestaAsistente =
      respuesta.contenido;

    if (
      respuesta.contenido !== undefined ||
      (respuesta.tool_calls !== undefined &&
        respuesta.tool_calls.length > 0)
    ) {
      session.mensajes.push({
        role: "assistant",
        content: respuesta.contenido ?? "",
        tool_calls: respuesta.tool_calls,
      });
    }

    if (
      contienePreguntaConfirmacion(
        respuesta.contenido,
      )
    ) {
      needsConfirmation = true;
    }

    if (
      respuesta.fin === "stop" ||
      !respuesta.tool_calls ||
      respuesta.tool_calls.length === 0
    ) {
      const reply =
        respuesta.contenido ??
        "El agente terminó el turno sin contenido adicional.";

      return {
        reply,
        toolCalls: toolCallsEjecutados,
        needsConfirmation,
      };
    }

    for (const toolCall of respuesta.tool_calls) {
      const ejecucion =
        await ejecutarHerramienta(
          toolCall,
          sessionId,
        );

      toolCallsEjecutados.push({
        name: toolCall.name,
        args: toolCall.args,
        resultado_resumen:
          ejecucion.resumen,
      });

      const resultadoOk =
        ejecucion.resultado.startsWith(
          '{"ok":true',
        );

      await registrarLog(
        sessionId,
        toolCall,
        resultadoOk,
        ejecucion.resumen,
      );

      session.mensajes.push({
        role: "tool",
        content: ejecucion.resultado,
        tool_call_id: toolCall.id,
      });

      if (
        toolCall.name ===
          "proveedor_simular_envio" &&
        ejecucion.resumen ===
          "requiere confirmación explícita"
      ) {
        needsConfirmation = true;
      }
    }
  }

  const reply =
    ultimaRespuestaAsistente !== undefined
      ? `${ultimaRespuestaAsistente}\n\n${construirRespuestaTope()}`
      : construirRespuestaTope();

  session.mensajes.push({
    role: "assistant",
    content: reply,
  });

  return {
    reply,
    toolCalls: toolCallsEjecutados,
    needsConfirmation,
  };
}

const ChatRequestSchema = z.object({
  sessionId: z.string().min(1),
  message: z.string().min(1),
});

const app = new Hono();

app.post("/api/chat", async (c) => {
  let body: unknown;

  try {
    body = await c.req.json();
  } catch {
    return c.json(
      {
        reply: "El cuerpo de la solicitud no es JSON válido.",
        toolCalls: [],
        needsConfirmation: false,
      },
      400,
    );
  }

  const parsed =
    ChatRequestSchema.safeParse(body);

  if (!parsed.success) {
    return c.json(
      {
        reply:
          "La solicitud debe contener sessionId y message.",
        toolCalls: [],
        needsConfirmation: false,
      },
      400,
    );
  }

  try {
    const resultado = await ejecutarTurno(
      parsed.data.sessionId,
      parsed.data.message,
    );

    return c.json(resultado);
  } catch (error: unknown) {
    const mensaje =
      `Error procesando el turno: ${errorToString(error)}`;

    return c.json({
      reply: mensaje,
      toolCalls: [],
      needsConfirmation: false,
    });
  }
});

app.get("/api/sessions/:id", (c) => {
  const sessionId = c.req.param("id");
  const session = sesiones.get(sessionId);

  if (!session) {
    return c.json(
      {
        error: "sesión no encontrada",
        sessionId,
        mensajes: [],
      },
      404,
    );
  }

  return c.json({
    sessionId,
    mensajes: session.mensajes,
  });
});

app.get("/api/health", (c) => {
  return c.json({
    ok: true,
    provider: "anthropic",
    model: MODEL,
  });
});

app.onError((error, c) => {
  return c.json(
    {
      error: `error interno: ${errorToString(error)}`,
    },
    500,
  );
});

export default app;

import { serve } from "@hono/node-server";

const port = Number(process.env.PORT ?? 3000);

serve({
  fetch: app.fetch,
  port,
});

console.log(`Servidor escuchando en http://localhost:${port}`);