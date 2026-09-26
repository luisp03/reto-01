import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";

import type {
  LLMAdapter,
  LLMError,
  Mensaje,
  RespuestaLLM,
  ToolCall,
  ToolDef,
} from "./adapter";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOKENS = 4096;

type AnthropicTextBlock = {
  type: "text";
  text: string;
};

type AnthropicToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

type AnthropicResponseBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | {
      type: string;
      [key: string]: unknown;
    };

type AnthropicResponse = {
  type?: string;
  content?: AnthropicResponseBlock[];
  stop_reason?: string | null;
};

type AnthropicErrorResponse = {
  error?: {
    type?: string;
    message?: string;
  };
};

type AnthropicTextContent = {
  type: "text";
  text: string;
};

type AnthropicToolUseContent = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};

type AnthropicToolResultContent = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
};

type AnthropicInputContent =
  | AnthropicTextContent
  | AnthropicToolUseContent
  | AnthropicToolResultContent;

type AnthropicInputMessage = {
  role: "user" | "assistant";
  content: string | AnthropicInputContent[];
};

type AnthropicToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

function esRegistro(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function obtenerMensajeError(
  value: unknown,
): string {
  if (!esRegistro(value)) {
    return "respuesta de Anthropic inválida";
  }

  const error = value.error;

  if (!esRegistro(error)) {
    return "respuesta de Anthropic inválida";
  }

  return typeof error.message === "string"
    ? error.message
    : "error desconocido de Anthropic";
}

function convertirHerramientas(
  herramientas: ToolDef[],
): AnthropicToolDefinition[] {
  return herramientas.map((herramienta) => {
    const schema = zodToJsonSchema(
      // Anthropic espera un JSON Schema para input_schema.
      // Se eliminan refs para entregar cada herramienta como esquema autocontenido.
      ObjectSchema(herramienta),
      {
        target: "jsonSchema7",
        $refStrategy: "none",
      },
    );

    return {
      name: herramienta.name,
      description: herramienta.description,
      input_schema: schema as Record<string, unknown>,
    };
  });
}

/**
 * Construye un objeto Zod para el mapa de argumentos de una herramienta.
 */
function ObjectSchema(tool: ToolDef) {
  return z.object(tool.args);
}


function convertirMensajes(
  mensajes: Mensaje[],
): AnthropicInputMessage[] {
  const resultado: AnthropicInputMessage[] = [];

  for (const mensaje of mensajes) {
    if (mensaje.role === "tool") {
      const bloque: AnthropicToolResultContent = {
        type: "tool_result",
        tool_use_id: mensaje.tool_call_id ?? "",
        content: mensaje.content,
      };

      const ultimo = resultado.at(-1);

      if (
        ultimo !== undefined &&
        ultimo.role === "user" &&
        Array.isArray(ultimo.content)
      ) {
        ultimo.content.push(bloque);
      } else {
        resultado.push({
          role: "user",
          content: [bloque],
        });
      }

      continue;
    }

    if (mensaje.role === "user") {
      resultado.push({
        role: "user",
        content: mensaje.content,
      });
      continue;
    }

    const bloques: AnthropicInputContent[] = [];

    if (mensaje.content.length > 0) {
      bloques.push({
        type: "text",
        text: mensaje.content,
      });
    }

    for (const toolCall of mensaje.tool_calls ?? []) {
      bloques.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.args,
      });
    }

    resultado.push({
      role: "assistant",
      content: bloques.length > 0 ? bloques : "",
    });
  }

  return resultado;
}

function extraerRespuesta(
  response: AnthropicResponse,
): RespuestaLLM {
  if (!Array.isArray(response.content)) {
    return {
      fin: "stop",
      error: {
        code: "invalid_response",
        message: "Anthropic no devolvió contenido válido",
      },
    };
  }

  const textos: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const bloque of response.content) {
    if (bloque.type === "text") {
      if (typeof bloque.text === "string") {
        textos.push(bloque.text);
      }
      continue;
    }

    if (bloque.type === "tool_use") {
      if (
        typeof bloque.id === "string" &&
        typeof bloque.name === "string"
      ) {
        toolCalls.push({
          id: bloque.id,
          name: bloque.name,
          args: bloque.input,
        });
      }
    }
  }

  if (toolCalls.length > 0 || response.stop_reason === "tool_use") {
    return {
      contenido:
        textos.length > 0 ? textos.join("\n") : undefined,
      tool_calls: toolCalls,
      fin: "tool_calls",
    };
  }

  return {
    contenido:
      textos.length > 0 ? textos.join("\n") : undefined,
    fin: "stop",
  };
}

/**
 * Adaptador HTTP para Claude Messages API.
 */
export class AnthropicAdapter implements LLMAdapter {
  private readonly apiKey: string | undefined;
  private readonly systemPrompt: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly maxTokens: number;

  constructor(options: {
    systemPrompt: string;
    model?: string;
    timeoutMs?: number;
    maxTokens?: number;
  }) {
    this.apiKey = process.env.ANTHROPIC_API_KEY;
    this.systemPrompt = options.systemPrompt;
    this.model = options.model ?? DEFAULT_MODEL;
    this.timeoutMs =
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTokens =
      options.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async enviar(
    mensajes: Mensaje[],
    herramientas: ToolDef[],
  ): Promise<RespuestaLLM> {
    if (!this.apiKey) {
      return {
        fin: "stop",
        error: {
          code: "missing_api_key",
          message:
            "falta la variable de entorno ANTHROPIC_API_KEY",
        },
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.timeoutMs,
    );

    try {
      const body = {
        model: this.model,
        max_tokens: this.maxTokens,
        system: this.systemPrompt,
        messages: convertirMensajes(mensajes),
        tools: convertirHerramientas(herramientas),
      };

      let response: Response;

      try {
        response = await fetch(ANTHROPIC_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error: unknown) {
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return {
            fin: "stop",
            error: {
              code: "timeout",
              message:
                `timeout del proveedor LLM después de ${this.timeoutMs} ms`,
            },
          };
        }

        const mensaje =
          error instanceof Error
            ? error.message
            : "error de red contra Anthropic";

        return {
          fin: "stop",
          error: {
            code: "network_error",
            message: mensaje,
          },
        };
      }

      const rawBody = await response.text();

      if (!response.ok) {
        let mensaje = `Anthropic respondió HTTP ${response.status}`;

        try {
          const parsed: unknown = JSON.parse(rawBody);
          const detalle = obtenerMensajeError(parsed);

          if (detalle !== "respuesta de Anthropic inválida") {
            mensaje = detalle;
          }
        } catch {
          // Se conserva el error HTTP sin exponer el cuerpo completo.
        }

        return {
          fin: "stop",
          error: {
            code: "http_error",
            message: mensaje,
          },
        };
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return {
          fin: "stop",
          error: {
            code: "invalid_response",
            message:
              "Anthropic devolvió una respuesta que no es JSON",
          },
        };
      }

      if (!esRegistro(parsed)) {
        return {
          fin: "stop",
          error: {
            code: "invalid_response",
            message:
              "Anthropic devolvió una estructura de respuesta inválida",
          },
        };
      }

      return extraerRespuesta(
        parsed as unknown as AnthropicResponse,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}