import type { ZodType } from "zod";

/**
 * Mensaje interno, independiente del proveedor LLM.
 */
export type Mensaje = {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

/**
 * Llamada de herramienta solicitada por el modelo.
 */
export type ToolCall = {
  id: string;
  name: string;
  args: unknown;
};

/**
 * Herramienta disponible para el ciclo del agente.
 */
export type ToolDef = {
  name: string;
  description: string;
  args: Record<string, ZodType<unknown>>;
};

/**
 * Error normalizado producido por un adaptador LLM.
 */
export type LLMError = {
  code:
    | "missing_api_key"
    | "timeout"
    | "http_error"
    | "invalid_response"
    | "network_error";
  message: string;
};

/**
 * Respuesta normalizada de cualquier proveedor LLM.
 */
export type RespuestaLLM = {
  contenido?: string;
  tool_calls?: ToolCall[];
  fin: "tool_calls" | "stop";
  error?: LLMError;
};

/**
 * Contrato agnóstico del proveedor para el ciclo del agente.
 */
export interface LLMAdapter {
  enviar(
    mensajes: Mensaje[],
    herramientas: ToolDef[],
  ): Promise<RespuestaLLM>;
}