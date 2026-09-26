import { z } from "zod";

/**
 * Solicitud de registro de proveedor recibida desde correo, portal u otro canal.
 */
export const SolicitudSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string(),
  cliente: z.string(),
  cuerpo: z.string(),
  formato: z.enum(["xlsx", "pdf", "portal"]),
  adjuntos: z.array(z.string()),
});

/**
 * Celda de una plantilla XLSX que relaciona una etiqueta con su celda de valor.
 */
export const PlantillaCeldasSchema = z.array(
  z.object({
    hoja: z.string(),
    celda_etiqueta: z.string(),
    etiqueta: z.string(),
    celda_valor: z.string(),
  }),
);

/**
 * Campo esperado por una plantilla PDF.
 */
export const PlantillaCamposSchema = z.array(
  z.object({
    etiqueta: z.string(),
    obligatorio: z.boolean(),
  }),
);

/**
 * Lista de soportes documentales exigidos para una solicitud.
 */
export const SoporteExigidoSchema = z.array(z.string());

/**
 * Maestro de información de Periferia. Permite campos snake_case adicionales
 * para soportar atributos del maestro que no estén definidos de antemano.
 */
export const MaestroSchema = z
  .object({
    razon_social: z.string().optional(),
    nit: z.string().optional(),
    direccion: z.string().optional(),
    representante_legal: z.string().optional(),
    banco: z.string().optional(),
    cuenta: z.string().optional(),
    contactos: z.unknown().optional(),
    ciiu: z.string().optional(),
  })
  .passthrough();

/**
 * Índice de soportes documentales disponibles en el repositorio.
 */
export const SoporteIndexSchema = z.array(
  z.object({
    tipo: z.string(),
    archivo: z.string(),
    vigencia_hasta: z.string(),
    pais_emisor: z.string(),
  }),
);

/**
 * Glosario que traduce etiquetas de plantillas a claves del maestro.
 */
export const GlosarioSchema = z.record(z.string(), z.string());

export type Solicitud = z.infer<typeof SolicitudSchema>;
export type PlantillaCeldas = z.infer<typeof PlantillaCeldasSchema>;
export type PlantillaCampos = z.infer<typeof PlantillaCamposSchema>;
export type SoporteExigido = z.infer<typeof SoporteExigidoSchema>;
export type Maestro = z.infer<typeof MaestroSchema>;
export type SoporteIndex = z.infer<typeof SoporteIndexSchema>;
export type Glosario = z.infer<typeof GlosarioSchema>;

/**
 * Resultado normalizado de un campo de la plantilla frente al maestro.
 *
 * `requiere_confirmacion` se usa cuando existe una razón para no completar
 * automáticamente el campo, por ejemplo baja confianza o una regla de país.
 */
export type CampoMapeado = {
  etiqueta: string;
  clave_maestro?: string;
  valor?: string;
  estado: "lleno" | "faltante" | "requiere_confirmacion";
  nota?: string;
  confianza?: number;
};

/**
 * Resultado genérico y reutilizable para todas las herramientas del módulo.
 */
export type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

/**
 * Contexto mínimo compartido por las herramientas durante una sesión.
 */
export type ToolContext = {
  directory: string;
  sessionId: string;
};

export const IDENTIFICADOR_TRIBUTARIO_POR_PAIS: Record<string, string> = {
  CO: "NIT",
  EC: "RUC",
  PE: "RUC",
  PA: "RUC",
  HN: "RTN",
};