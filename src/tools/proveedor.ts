import { promises as fs } from "node:fs";
import path from "node:path";

import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import {
  CampoMapeado,
  Glosario,
  IDENTIFICADOR_TRIBUTARIO_POR_PAIS,
  Maestro,
  ToolContext,
  ToolResult,
} from "./schemas";

/**
 * Argumentos de lectura de una solicitud.
 */
const leerSolicitudArgs = {
  caso: "Caso de fixture a leer.".trim(),
} as const;

/**
 * Argumentos de mapeo de campos.
 */
const mapearCamposArgs = {
  caso: "Caso de fixture cuyo maestro y glosario serán utilizados.".trim(),
  campos: "Etiquetas de campos que deben mapearse contra el maestro.".trim(),
} as const;

type LeerSolicitudData = {
  pais: string;
  cliente: string;
  formato: "xlsx" | "pdf" | "portal";
  campos: string[];
  soportes: string[];
  ambiguos: string[];
};

type MapearCamposData = {
  llenos: CampoMapeado[];
  faltantes: CampoMapeado[];
  requiere_confirmacion: CampoMapeado[];
};

type GenerarFormularioData = {
  ruta: string;
  formato: "xlsx" | "pdf" | "portal";
};

type ArmarPaqueteData = {
  ruta: string;
  listo_para_firma: boolean;
  checklist: Array<{
    tipo: string;
    estado: string;
  }>;
};

type SimularEnvioData = {
  ruta: string;
};

type SolicitudBasica = {
  pais: string;
  cliente: string;
  formato: "xlsx" | "pdf" | "portal";
};

type PlantillaCelda = {
  hoja: string;
  celda_etiqueta: string;
  etiqueta: string;
  celda_valor: string;
};

type PlantillaCampo = {
  etiqueta: string;
  obligatorio: boolean;
};

type SoporteIndice = {
  tipo: string;
  archivo: string;
  vigencia_hasta: string | null;
  pais_emisor: string;
};

type LogEntry = {
  ts: string;
  herramienta: string;
  ok: boolean;
  resumen: string;
};

const IDENTIFICACION_TRIBUTARIA_RE =
  /\b(identificaci[oó]n\s+tributaria|tax\s*id|ruc\s*\/\s*nit|ruc|nit|rtn)\b/i;

function normalizarTexto(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function esCampoTributario(etiqueta: string): boolean {
  return IDENTIFICACION_TRIBUTARIA_RE.test(etiqueta);
}

function obtenerIdentificadorPais(pais: string): string | undefined {
  return IDENTIFICADOR_TRIBUTARIO_POR_PAIS[pais.trim().toUpperCase()];
}

function esValorMaestroValido(
  maestro: Maestro,
  clave: string,
): boolean {
  const valor = maestro[clave];
  return typeof valor === "string" && valor.length > 0;
}

function buscarClaveExacta(
  etiqueta: string,
  glosario: Glosario,
  maestro: Maestro,
): string | undefined {
  const etiquetaNormalizada = normalizarTexto(etiqueta);

  const claveDirecta = Object.keys(maestro).find(
    (clave) => normalizarTexto(clave) === etiquetaNormalizada,
  );

  if (claveDirecta !== undefined) {
    return claveDirecta;
  }

  const entradaGlosario = Object.entries(glosario).find(
    ([glosarioEtiqueta]) =>
      normalizarTexto(glosarioEtiqueta) === etiquetaNormalizada,
  );

  if (entradaGlosario !== undefined) {
    const [, claveMaestro] = entradaGlosario;

    if (Object.prototype.hasOwnProperty.call(maestro, claveMaestro)) {
      return claveMaestro;
    }
  }

  return undefined;
}

/**
 * Busca coincidencias aproximadas. Se consideran confirmables, no automáticas.
 */
function buscarCoincidenciaDifusa(
  etiqueta: string,
  glosario: Glosario,
  maestro: Maestro,
): { clave: string; confianza: number } | undefined {
  const objetivo = normalizarTexto(etiqueta);

  for (const clave of Object.keys(maestro)) {
    const claveNormalizada = normalizarTexto(clave);

    if (
      objetivo.length > 2 &&
      (objetivo.includes(claveNormalizada) ||
        claveNormalizada.includes(objetivo))
    ) {
      return {
        clave,
        confianza: 0.7,
      };
    }
  }

  for (const [glosarioEtiqueta, claveMaestro] of Object.entries(glosario)) {
    const etiquetaNormalizada = normalizarTexto(glosarioEtiqueta);

    if (
      objetivo.length > 2 &&
      (objetivo.includes(etiquetaNormalizada) ||
        etiquetaNormalizada.includes(objetivo))
    ) {
      if (Object.prototype.hasOwnProperty.call(maestro, claveMaestro)) {
        return {
          clave: claveMaestro,
          confianza: 0.7,
        };
      }
    }
  }

  return undefined;
}

/**
 * Resuelve una etiqueta exclusivamente contra fuentes presentes en el maestro.
 *
 * RN1: un identificador tributario de un país distinto de CO requiere confirmación
 * y conserva como referencia el NIT existente de Periferia.
 */
export function resolverCampo(
  etiqueta: string,
  glosario: Glosario,
  maestro: Maestro,
  pais: string,
): CampoMapeado {
  const claveExacta = buscarClaveExacta(etiqueta, glosario, maestro);

  if (claveExacta !== undefined && esValorMaestroValido(maestro, claveExacta)) {
    if (esCampoTributario(etiqueta) && pais.trim().toUpperCase() !== "CO") {
      const nit = maestro.nit;

      if (typeof nit === "string" && nit.length > 0) {
        return {
          etiqueta,
          clave_maestro: "nit",
          valor: nit,
          estado: "requiere_confirmacion",
          nota: "identificador extranjero",
        };
      }

      return {
        etiqueta,
        clave_maestro: claveExacta,
        estado: "requiere_confirmacion",
        nota: "identificador extranjero",
      };
    }

    return {
      etiqueta,
      clave_maestro: claveExacta,
      valor: maestro[claveExacta] as string,
      estado: "lleno",
      confianza: 1.0,
    };
  }

  const coincidenciaDifusa = buscarCoincidenciaDifusa(
    etiqueta,
    glosario,
    maestro,
  );

  if (coincidenciaDifusa !== undefined) {
    const valor = maestro[coincidenciaDifusa.clave];

    if (typeof valor === "string" && valor.length > 0) {
      return {
        etiqueta,
        clave_maestro: coincidenciaDifusa.clave,
        valor,
        estado: "requiere_confirmacion",
        confianza: coincidenciaDifusa.confianza,
      };
    }

    return {
      etiqueta,
      clave_maestro: coincidenciaDifusa.clave,
      estado: "requiere_confirmacion",
      confianza: coincidenciaDifusa.confianza,
    };
  }

  // RN1: cualquier identificador extranjero no se inventa ni se transforma.
  if (esCampoTributario(etiqueta) && pais.trim().toUpperCase() !== "CO") {
    const nit = maestro.nit;

    if (typeof nit === "string" && nit.length > 0) {
      return {
        etiqueta,
        clave_maestro: "nit",
        valor: nit,
        estado: "requiere_confirmacion",
        nota: "identificador extranjero",
      };
    }

    return {
      etiqueta,
      estado: "requiere_confirmacion",
      nota: "identificador extranjero",
    };
  }

  // "faltante" significa que no existe una fuente en el maestro.
  return {
    etiqueta,
    estado: "faltante",
  };
}

async function asegurarDirectorio(ruta: string): Promise<void> {
  await fs.mkdir(ruta, { recursive: true });
}

async function registrarLog(
  ctx: ToolContext,
  caso: string,
  herramienta: string,
  ok: boolean,
  resumen: string,
): Promise<void> {
  try {
    const casoDir = path.resolve(
      ctx.directory,
      "out",
      caso,
    );

    await asegurarDirectorio(casoDir);

    const entrada: LogEntry = {
      ts: new Date().toISOString(),
      herramienta,
      ok,
      resumen,
    };

    await fs.appendFile(
      path.join(casoDir, "log.jsonl"),
      `${JSON.stringify(entrada)}\n`,
      "utf8",
    );
  } catch {
    // El logging nunca debe alterar el resultado de la herramienta.
  }
}

async function ejecutarConLog<T>(
  ctx: ToolContext,
  caso: string,
  herramienta: string,
  operacion: () => Promise<string>,
): Promise<string> {
  try {
    const resultado = await operacion();

    let ok = false;
    let resumen = "resultado no interpretable";

    try {
      const parsed: unknown = JSON.parse(resultado);

      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "ok" in parsed &&
        typeof parsed.ok === "boolean"
      ) {
        ok = parsed.ok;

        if (parsed.ok) {
          resumen = "operación completada";
        } else if (
          "error" in parsed &&
          typeof parsed.error === "string"
        ) {
          resumen = parsed.error;
        }
      }
    } catch {
      resumen = "resultado no JSON";
    }

    await registrarLog(
      ctx,
      caso,
      herramienta,
      ok,
      resumen,
    );

    return resultado;
  } catch (error: unknown) {
    const mensaje =
      error instanceof Error ? error.message : "error inesperado";

    const resultado = JSON.stringify({
      ok: false,
      error: mensaje,
    } satisfies ToolResult<never>);

    await registrarLog(
      ctx,
      caso,
      herramienta,
      false,
      mensaje,
    );

    return resultado;
  }
}

async function leerJson<T>(archivo: string): Promise<T> {
  const contenido = await fs.readFile(archivo, "utf8");
  return JSON.parse(contenido) as T;
}

async function leerSolicitudBase(
  archivo: string,
): Promise<SolicitudBasica> {
  const contenido = await leerJson<unknown>(archivo);

  if (
    typeof contenido !== "object" ||
    contenido === null ||
    !("pais" in contenido) ||
    !("cliente" in contenido) ||
    !("formato" in contenido) ||
    typeof contenido.pais !== "string" ||
    typeof contenido.cliente !== "string" ||
    (contenido.formato !== "xlsx" &&
      contenido.formato !== "pdf" &&
      contenido.formato !== "portal")
  ) {
    throw new Error("solicitud inválida");
  }

  return {
    pais: contenido.pais,
    cliente: contenido.cliente,
    formato: contenido.formato,
  };
}

function extraerCamposDesdePlantilla(
  formato: SolicitudBasica["formato"],
  datos: unknown,
): string[] {
  if (!Array.isArray(datos)) {
    throw new Error("plantilla inválida");
  }

  if (formato === "xlsx") {
    return datos.map((fila: unknown) => {
      if (
        typeof fila !== "object" ||
        fila === null ||
        !("etiqueta" in fila) ||
        typeof fila.etiqueta !== "string"
      ) {
        throw new Error("plantilla inválida");
      }

      return fila.etiqueta;
    });
  }

  if (formato === "pdf") {
    return datos.map((campo: unknown) => {
      if (
        typeof campo !== "object" ||
        campo === null ||
        !("etiqueta" in campo) ||
        typeof campo.etiqueta !== "string"
      ) {
        throw new Error("plantilla inválida");
      }

      return campo.etiqueta;
    });
  }

  return [];
}

function construirAmbiguos(
  campos: string[],
  pais: string,
): string[] {
  const identificadorSugerido =
    obtenerIdentificadorPais(pais) ?? undefined;

  if (identificadorSugerido === undefined) {
    return [];
  }

  return campos
    .filter((campo) => esCampoTributario(campo))
    .map((campo) => `${campo} → ${identificadorSugerido}`);
}

async function ejecutarLeerSolicitud(
  args: { caso: string },
  ctx: ToolContext,
): Promise<string> {
  const casoDir = path.resolve(
    ctx.directory,
    "fixtures",
    "reto-01",
    "casos",
    args.caso,
  );

  const solicitudPath = path.join(casoDir, "solicitud.json");

  try {
    await fs.access(solicitudPath);
  } catch {
    return JSON.stringify({
      ok: false,
      error: `caso no encontrado: ${args.caso}`,
    } satisfies ToolResult<never>);
  }

  let solicitud: SolicitudBasica;

  try {
    solicitud = await leerSolicitudBase(solicitudPath);
  } catch {
    return JSON.stringify({
      ok: false,
      error: `plantilla corrupta en ${args.caso}`,
    } satisfies ToolResult<never>);
  }

  let campos: string[] = [];

  if (solicitud.formato === "xlsx") {
    try {
      const plantilla = await leerJson<unknown>(
        path.join(casoDir, "plantilla-celdas.json"),
      );
      campos = extraerCamposDesdePlantilla("xlsx", plantilla);
    } catch {
      return JSON.stringify({
        ok: false,
        error: `plantilla corrupta en ${args.caso}`,
      } satisfies ToolResult<never>);
    }
    } else if (solicitud.formato === "pdf" || solicitud.formato === "portal") {
    try {
      const plantilla = await leerJson<unknown>(
        path.join(casoDir, "plantilla-campos.json"),
      );
      campos = extraerCamposDesdePlantilla("pdf", plantilla);
    } catch {
      return JSON.stringify({
        ok: false,
        error: `plantilla corrupta en ${args.caso}`,
      } satisfies ToolResult<never>);
    }
  }

  let soportes: string[];

  try {
    const soportesJson = await leerJson<unknown>(
      path.join(casoDir, "soportes-exigidos.json"),
    );

    if (
      !Array.isArray(soportesJson) ||
      !soportesJson.every(
        (soporte): soporte is string => typeof soporte === "string",
      )
    ) {
      throw new Error("soportes inválidos");
    }

    soportes = soportesJson;
  } catch {
    return JSON.stringify({
      ok: false,
      error: `plantilla corrupta en ${args.caso}`,
    } satisfies ToolResult<never>);
  }

  const data: LeerSolicitudData = {
    pais: solicitud.pais,
    cliente: solicitud.cliente,
    formato: solicitud.formato,
    campos,
    soportes,
    ambiguos: construirAmbiguos(campos, solicitud.pais),
  };

  return JSON.stringify({
    ok: true,
    data,
  } satisfies ToolResult<LeerSolicitudData>);
}

export const leer_solicitud = {
  description:
    "Lee una solicitud y su plantilla para identificar campos, soportes y ambigüedades tributarias.",
  args: {
    caso: {
      parse: (value: unknown): string => {
        if (typeof value !== "string") {
          throw new Error("caso debe ser un string");
        }
        return value;
      },
      describe: "Nombre del caso dentro de fixtures/reto-01/casos.",
    },
  },
  async execute(
    args: { caso: string },
    ctx: ToolContext,
  ): Promise<string> {
    return ejecutarConLog(
      ctx,
      args.caso,
      "proveedor_leer_solicitud",
      () => ejecutarLeerSolicitud(args, ctx),
    );
  },
};

async function ejecutarMapearCampos(
  args: { caso: string; campos: string[] },
  ctx: ToolContext,
): Promise<string> {
  const baseDir = path.resolve(ctx.directory, "fixtures", "reto-01");

  const solicitudPath = path.join(
    baseDir,
    "casos",
    args.caso,
    "solicitud.json",
  );
  const glosarioPath = path.join(baseDir, "glosario-campos.json");
  const maestroPath = path.join(baseDir, "repositorio", "maestro.json");

  let solicitud: SolicitudBasica;
  let glosario: Glosario;
  let maestro: Maestro;

  try {
    solicitud = await leerSolicitudBase(solicitudPath);
    glosario = await leerJson<Glosario>(glosarioPath);
    maestro = await leerJson<Maestro>(maestroPath);
  } catch {
    return JSON.stringify({
      ok: false,
      error: `no se pudo cargar la información del caso: ${args.caso}`,
    } satisfies ToolResult<never>);
  }

  const mapeados = args.campos.map((campo) =>
    resolverCampo(
      campo,
      glosario,
      maestro,
      solicitud.pais,
    ),
  );

  const data: MapearCamposData = {
    llenos: mapeados.filter(
      (campo) => campo.estado === "lleno",
    ),
    faltantes: mapeados.filter(
      (campo) => campo.estado === "faltante",
    ),
    requiere_confirmacion: mapeados.filter(
      (campo) => campo.estado === "requiere_confirmacion",
    ),
  };

  return JSON.stringify({
    ok: true,
    data,
  } satisfies ToolResult<MapearCamposData>);
}

export const mapear_campos = {
  description:
    "Mapea los campos solicitados contra el glosario y el maestro de Periferia sin inventar valores.",
  args: {
    caso: {
      parse: (value: unknown): string => {
        if (typeof value !== "string") {
          throw new Error("caso debe ser un string");
        }
        return value;
      },
      describe: "Nombre del caso cuyo maestro y glosario serán utilizados.",
    },
    campos: {
      parse: (value: unknown): string[] => {
        if (
          !Array.isArray(value) ||
          !value.every(
            (campo): campo is string => typeof campo === "string",
          )
        ) {
          throw new Error("campos debe ser un arreglo de strings");
        }

        return value;
      },
      describe: "Etiquetas de campos que deben mapearse.",
    },
  },
  async execute(
    args: { caso: string; campos: string[] },
    ctx: ToolContext,
  ): Promise<string> {
    return ejecutarConLog(
      ctx,
      args.caso,
      "proveedor_mapear_campos",
      () => ejecutarMapearCampos(args, ctx),
    );
  },
};

function buscarCampoMapeado(
  mapeo: CampoMapeado[],
  etiqueta: string,
): CampoMapeado | undefined {
  const etiquetaNormalizada = normalizarTexto(etiqueta);

  return mapeo.find(
    (campo) => normalizarTexto(campo.etiqueta) === etiquetaNormalizada,
  );
}

function valorParaFormulario(campo: CampoMapeado | undefined): string {
  if (campo === undefined) {
    return "";
  }

  return typeof campo.valor === "string" ? campo.valor : "";
}

async function generarFormularioXlsx(
  casoDir: string,
  outputPath: string,
  mapeo: CampoMapeado[],
): Promise<void> {
  const plantillaPath = path.join(casoDir, "plantilla-celdas.json");
  const plantilla = await leerJson<unknown>(plantillaPath);

  if (!Array.isArray(plantilla)) {
    throw new Error("plantilla XLSX inválida");
  }

  const entradas: PlantillaCelda[] = plantilla.map((entrada: unknown) => {
    if (
      typeof entrada !== "object" ||
      entrada === null ||
      !("hoja" in entrada) ||
      !("celda_etiqueta" in entrada) ||
      !("etiqueta" in entrada) ||
      !("celda_valor" in entrada) ||
      typeof entrada.hoja !== "string" ||
      typeof entrada.celda_etiqueta !== "string" ||
      typeof entrada.etiqueta !== "string" ||
      typeof entrada.celda_valor !== "string"
    ) {
      throw new Error("plantilla XLSX inválida");
    }

    return {
      hoja: entrada.hoja,
      celda_etiqueta: entrada.celda_etiqueta,
      etiqueta: entrada.etiqueta,
      celda_valor: entrada.celda_valor,
    };
  });

  // ExcelJS permite escribir directamente por celda y crear hojas ausentes con facilidad.
  const workbook = new ExcelJS.Workbook();

  for (const entrada of entradas) {
    let worksheet = workbook.getWorksheet(entrada.hoja);

    if (worksheet === undefined) {
      worksheet = workbook.addWorksheet(entrada.hoja);
    }

    const campo = buscarCampoMapeado(mapeo, entrada.etiqueta);
    worksheet.getCell(entrada.celda_valor).value =
      valorParaFormulario(campo);
  }

  await workbook.xlsx.writeFile(outputPath);
}

async function generarFormularioPdf(
  casoDir: string,
  outputPath: string,
  mapeo: CampoMapeado[],
): Promise<void> {
  const plantillaPath = path.join(casoDir, "plantilla-campos.json");
  const plantilla = await leerJson<unknown>(plantillaPath);

  if (!Array.isArray(plantilla)) {
    throw new Error("plantilla PDF inválida");
  }

  const campos: PlantillaCampo[] = plantilla.map((campo: unknown) => {
    if (
      typeof campo !== "object" ||
      campo === null ||
      !("etiqueta" in campo) ||
      !("obligatorio" in campo) ||
      typeof campo.etiqueta !== "string" ||
      typeof campo.obligatorio !== "boolean"
    ) {
      throw new Error("plantilla PDF inválida");
    }

    return {
      etiqueta: campo.etiqueta,
      obligatorio: campo.obligatorio,
    };
  });

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const marginX = 50;
  const marginTop = 50;
  const marginBottom = 50;
  const lineHeight = 22;

  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - marginTop;

  const nuevaPagina = (): void => {
    page = pdf.addPage([pageWidth, pageHeight]);
    y = pageHeight - marginTop;
  };

  page.drawText("Formulario de registro de proveedor", {
    x: marginX,
    y,
    size: 14,
    font: boldFont,
    color: rgb(0, 0, 0),
  });

  y -= lineHeight * 2;

  for (const plantillaCampo of campos) {
    if (y < marginBottom + lineHeight) {
      nuevaPagina();
    }

    const campo = buscarCampoMapeado(mapeo, plantillaCampo.etiqueta);
    const valor = valorParaFormulario(campo);
    const obligatorio = plantillaCampo.obligatorio ? " *" : "";

    page.drawText(`${plantillaCampo.etiqueta}${obligatorio}:`, {
      x: marginX,
      y,
      size: 10,
      font: boldFont,
      color: rgb(0, 0, 0),
    });

    page.drawText(valor, {
      x: marginX + 210,
      y,
      size: 10,
      font,
      color: rgb(0, 0, 0),
    });

    y -= lineHeight;
  }

  const bytes = await pdf.save();
  await fs.writeFile(outputPath, bytes);
}

async function generarValoresPortal(
  outputPath: string,
  mapeo: CampoMapeado[],
): Promise<void> {
  const lineas = [
    "# Valores para registro en portal",
    "",
    ...mapeo.map(
      (campo) => `- ${campo.etiqueta}: ${valorParaFormulario(campo)}`,
    ),
    "",
    "⚠️ formato no soportado — completar manualmente en el portal",
    "",
  ];

  await fs.writeFile(outputPath, lineas.join("\n"), "utf8");
}

async function ejecutarGenerarFormulario(
  args: { caso: string; mapeo: CampoMapeado[] },
  ctx: ToolContext,
): Promise<string> {
  const casoDir = path.resolve(
    ctx.directory,
    "fixtures",
    "reto-01",
    "casos",
    args.caso,
  );

  const outputDir = path.resolve(
    ctx.directory,
    "out",
    args.caso,
  );

  const solicitudPath = path.join(casoDir, "solicitud.json");
  const solicitud = await leerSolicitudBase(solicitudPath);

  await asegurarDirectorio(outputDir);

  if (solicitud.formato === "xlsx") {
    const outputPath = path.join(outputDir, "formulario.xlsx");

    await generarFormularioXlsx(
      casoDir,
      outputPath,
      args.mapeo,
    );

    const data: GenerarFormularioData = {
      ruta: path.join(
        "out",
        args.caso,
        "formulario.xlsx",
      ),
      formato: "xlsx",
    };

    return JSON.stringify({
      ok: true,
      data,
    } satisfies ToolResult<GenerarFormularioData>);
  }

  if (solicitud.formato === "pdf") {
    const outputPath = path.join(outputDir, "formulario.pdf");

    await generarFormularioPdf(
      casoDir,
      outputPath,
      args.mapeo,
    );

    const data: GenerarFormularioData = {
      ruta: path.join(
        "out",
        args.caso,
        "formulario.pdf",
      ),
      formato: "pdf",
    };

    return JSON.stringify({
      ok: true,
      data,
    } satisfies ToolResult<GenerarFormularioData>);
  }

  const outputPath = path.join(
    outputDir,
    "valores-portal.md",
  );

  await generarValoresPortal(outputPath, args.mapeo);

  // HU-3: se genera el archivo auxiliar, pero no se automatiza el portal.
  return JSON.stringify({
    ok: false,
    error: "formato no soportado",
  } satisfies ToolResult<never>);
}

export const generar_formulario = {
  description:
    "Genera el formulario de proveedor en XLSX, PDF o una lista de valores para portal según el formato de la solicitud.",
  args: {
    caso: {
      parse: (value: unknown): string => {
        if (typeof value !== "string") {
          throw new Error("caso debe ser un string");
        }
        return value;
      },
      describe: "Nombre del caso dentro de fixtures/reto-01/casos.",
    },
    mapeo: {
      parse: (value: unknown): CampoMapeado[] => {
        if (!Array.isArray(value)) {
          throw new Error("mapeo debe ser un arreglo de CampoMapeado");
        }

        return value.map((campo: unknown): CampoMapeado => {
          if (
            typeof campo !== "object" ||
            campo === null ||
            !("etiqueta" in campo) ||
            !("estado" in campo) ||
            typeof campo.etiqueta !== "string" ||
            (campo.estado !== "lleno" &&
              campo.estado !== "faltante" &&
              campo.estado !== "requiere_confirmacion")
          ) {
            throw new Error("mapeo contiene un CampoMapeado inválido");
          }

          const resultado: CampoMapeado = {
            etiqueta: campo.etiqueta,
            estado: campo.estado,
          };

          if (
            "clave_maestro" in campo &&
            typeof campo.clave_maestro === "string"
          ) {
            resultado.clave_maestro = campo.clave_maestro;
          }

          if ("valor" in campo && typeof campo.valor === "string") {
            resultado.valor = campo.valor;
          }

          if ("nota" in campo && typeof campo.nota === "string") {
            resultado.nota = campo.nota;
          }

          if ("confianza" in campo && typeof campo.confianza === "number") {
            resultado.confianza = campo.confianza;
          }

          return resultado;
        });
      },
      describe:
        "Campos previamente mapeados contra el maestro de Periferia.",
    },
  },
  async execute(
    args: { caso: string; mapeo: CampoMapeado[] },
    ctx: ToolContext,
  ): Promise<string> {
    return ejecutarConLog(
      ctx,
      args.caso,
      "proveedor_generar_formulario",
      () => ejecutarGenerarFormulario(args, ctx),
    );
  },
};

async function leerSoportesExigidos(
  casoDir: string,
): Promise<string[]> {
  const datos = await leerJson<unknown>(
    path.join(casoDir, "soportes-exigidos.json"),
  );

  if (
    !Array.isArray(datos) ||
    !datos.every(
      (valor): valor is string => typeof valor === "string",
    )
  ) {
    throw new Error("soportes-exigidos.json inválido");
  }

  return datos;
}

async function leerIndiceSoportes(
  repositorioDir: string,
): Promise<SoporteIndice[]> {
  const datos = await leerJson<unknown>(
    path.join(repositorioDir, "soportes", "index.json"),
  );

  if (!Array.isArray(datos)) {
    throw new Error("repositorio/soportes/index.json inválido");
  }

  return datos.map((entrada: unknown) => {
    if (
      typeof entrada !== "object" ||
      entrada === null ||
      !("tipo" in entrada) ||
      !("archivo" in entrada) ||
      !("vigencia_hasta" in entrada) ||
      !("pais_emisor" in entrada) ||
      typeof entrada.tipo !== "string" ||
      typeof entrada.archivo !== "string" ||
            (entrada.vigencia_hasta !== null && typeof entrada.vigencia_hasta !== "string") ||
      typeof entrada.pais_emisor !== "string"
    ) {
      throw new Error("repositorio/soportes/index.json inválido");
    }

    return {
      tipo: entrada.tipo,
      archivo: entrada.archivo,
      vigencia_hasta: entrada.vigencia_hasta,
      pais_emisor: entrada.pais_emisor,
    };
  });
}

function estadoSoporte(
  entrada: SoporteIndice | undefined,
  ahora: Date,
): string {
  if (entrada === undefined) {
    return "ausente";
  }

    if (entrada.vigencia_hasta === null) {
    return "presente";
  }

  const vigencia = new Date(entrada.vigencia_hasta);

  if (
    Number.isFinite(vigencia.getTime()) &&
    vigencia.getTime() < ahora.getTime()
  ) {
    return "vencido";
  }

  return "presente";

  if (
    Number.isFinite(vigencia.getTime()) &&
    vigencia.getTime() < ahora.getTime()
  ) {
    return "vencido";
  }

  return "presente";
}

async function copiarFormularioAlPaquete(
  outputDir: string,
  paqueteDir: string,
): Promise<string | undefined> {
  const candidatos = [
    {
      archivo: "formulario.xlsx",
      ruta: path.join(outputDir, "formulario.xlsx"),
    },
    {
      archivo: "formulario.pdf",
      ruta: path.join(outputDir, "formulario.pdf"),
    },
  ];

  for (const candidato of candidatos) {
    try {
      await fs.access(candidato.ruta);

      await fs.copyFile(
        candidato.ruta,
        path.join(paqueteDir, candidato.archivo),
      );

      return candidato.archivo;
    } catch {
      // Se prueba el siguiente formato.
    }
  }

  return undefined;
}

async function ejecutarArmarPaquete(
  args: { caso: string },
  ctx: ToolContext,
): Promise<string> {
  const casoDir = path.resolve(
    ctx.directory,
    "fixtures",
    "reto-01",
    "casos",
    args.caso,
  );

  const repositorioDir = path.resolve(
    ctx.directory,
    "fixtures",
    "reto-01",
    "repositorio",
  );

  const outputDir = path.resolve(
    ctx.directory,
    "out",
    args.caso,
  );

  const paqueteDir = path.join(outputDir, "paquete");
  const soportesDestinoDir = path.join(
    paqueteDir,
    "soportes",
  );

  await asegurarDirectorio(soportesDestinoDir);

  const soportesExigidos = await leerSoportesExigidos(casoDir);
  const indice = await leerIndiceSoportes(repositorioDir);
  const ahora = new Date();

  const checklist: Array<{
    tipo: string;
    estado: string;
  }> = [];

  for (const tipo of soportesExigidos) {
    const entrada = indice.find(
      (soporte) => soporte.tipo === tipo,
    );

    const estado = estadoSoporte(entrada, ahora);

    checklist.push({
      tipo,
      estado,
    });

    if (estado === "presente" && entrada !== undefined) {
      const origen = path.join(
        repositorioDir,
        "soportes",
        entrada.archivo,
      );

      const destino = path.join(
        soportesDestinoDir,
        path.basename(entrada.archivo),
      );

      await fs.copyFile(origen, destino);
    }
  }

  const formularioCopiado = await copiarFormularioAlPaquete(
    outputDir,
    paqueteDir,
  );

  const listoParaFirma = checklist.every(
    (item) =>
      item.estado !== "ausente" &&
      item.estado !== "vencido",
  );

  const checklistMarkdown = [
    "# Checklist de soportes",
    "",
    "| Soporte | Estado |",
    "|---|---|",
    ...checklist.map(
      (item) => `| ${item.tipo} | ${item.estado} |`,
    ),
    "",
  ].join("\n");

  await fs.writeFile(
    path.join(paqueteDir, "checklist.md"),
    checklistMarkdown,
    "utf8",
  );

  let representanteLegal = "Representante legal";

  try {
    const maestro = await leerJson<Maestro>(
      path.join(repositorioDir, "maestro.json"),
    );

    if (
      typeof maestro.representante_legal === "string" &&
      maestro.representante_legal.trim().length > 0
    ) {
      representanteLegal = maestro.representante_legal;
    }
  } catch {
    // El nombre es opcional para poder preparar el paquete.
  }

  const adjuntos = [
    ...checklist
      .filter((item) => item.estado === "presente")
      .map((item) => {
        const entrada = indice.find(
          (soporte) => soporte.tipo === item.tipo,
        );

        return entrada === undefined
          ? undefined
          : path.join(
              "soportes",
              path.basename(entrada.archivo),
            );
      })
      .filter(
        (archivo): archivo is string =>
          typeof archivo === "string",
      ),
    formularioCopiado,
  ].filter(
    (archivo): archivo is string =>
      typeof archivo === "string",
  );

  const correo = [
    "# Borrador de correo",
    "",
    `**Para:** ${representanteLegal}`,
    "",
    "Estimado/a representante legal:",
    "",
    "Solicitamos su firma del formulario de registro de proveedor preparado para este caso.",
    "",
    "Adjuntos:",
    ...adjuntos.map((archivo) => `- ${archivo}`),
    "",
    "Quedamos atentos a la firma para continuar con el proceso.",
    "",
    "Saludos,",
    "Equipo de Registro de Proveedores",
    "",
  ].join("\n");

  await fs.writeFile(
    path.join(paqueteDir, "borrador-correo.md"),
    correo,
    "utf8",
  );

  const data: ArmarPaqueteData = {
    ruta: path.join("out", args.caso, "paquete"),
    listo_para_firma: listoParaFirma,
    checklist,
  };

  return JSON.stringify({
    ok: true,
    data,
  } satisfies ToolResult<ArmarPaqueteData>);
}

export const armar_paquete = {
  description:
    "Valida soportes, prepara el paquete documental y determina si está listo para firma.",
  args: {
    caso: {
      parse: (value: unknown): string => {
        if (typeof value !== "string") {
          throw new Error("caso debe ser un string");
        }
        return value;
      },
      describe: "Nombre del caso dentro de fixtures/reto-01/casos.",
    },
  },
  async execute(
    args: { caso: string },
    ctx: ToolContext,
  ): Promise<string> {
    return ejecutarConLog(
      ctx,
      args.caso,
      "proveedor_armar_paquete",
      () => ejecutarArmarPaquete(args, ctx),
    );
  },
};

async function ejecutarSimularEnvio(
  args: { caso: string; confirmado: boolean },
  ctx: ToolContext,
): Promise<string> {
  if (args.confirmado !== true) {
    return JSON.stringify({
      ok: false,
      error: "requiere confirmación explícita",
    } satisfies ToolResult<never>);
  }

  const outputDir = path.resolve(
    ctx.directory,
    "out",
    args.caso,
  );

  const paqueteDir = path.join(outputDir, "paquete");
  const paqueteRuta = path.join(
    "out",
    args.caso,
    "paquete",
  );

  await fs.access(paqueteDir);

  const archivos = await fs.readdir(paqueteDir, {
    recursive: true,
  });

  const timestamp = new Date().toISOString();

  const contenido = [
    "# ENVÍO SIMULADO",
    "",
    `- Timestamp: ${timestamp}`,
    `- Caso: ${args.caso}`,
    `- Paquete: ${paqueteRuta}`,
    "",
    "## Resumen del paquete",
    "",
    ...archivos.map((archivo) => `- ${archivo}`),
    "",
    "Este archivo representa una simulación de envío.",
    "No se realizó ningún envío externo.",
    "",
  ].join("\n");

  const ruta = path.join(
    outputDir,
    "ENVIO-SIMULADO.md",
  );

  await fs.writeFile(ruta, contenido, "utf8");

  const data: SimularEnvioData = {
    ruta: path.join(
      "out",
      args.caso,
      "ENVIO-SIMULADO.md",
    ),
  };

  return JSON.stringify({
    ok: true,
    data,
  } satisfies ToolResult<SimularEnvioData>);
}

export const simular_envio = {
  description:
    "Simula el envío del paquete únicamente cuando existe confirmación explícita.",
  args: {
    caso: {
      parse: (value: unknown): string => {
        if (typeof value !== "string") {
          throw new Error("caso debe ser un string");
        }
        return value;
      },
      describe: "Nombre del caso cuyo paquete se simulará enviar.",
    },
    confirmado: {
      parse: (value: unknown): boolean => {
        if (typeof value !== "boolean") {
          throw new Error("confirmado debe ser boolean");
        }
        return value;
      },
      describe:
        "Confirmación explícita requerida para realizar la simulación.",
    },
  },
  async execute(
    args: { caso: string; confirmado: boolean },
    ctx: ToolContext,
  ): Promise<string> {
    /*
     * RN4: cuando no hay confirmación no se escribe absolutamente nada,
     * incluido el log.
     */
    if (args.confirmado !== true) {
      return JSON.stringify({
        ok: false,
        error: "requiere confirmación explícita",
      } satisfies ToolResult<never>);
    }

    return ejecutarConLog(
      ctx,
      args.caso,
      "proveedor_simular_envio",
      () => ejecutarSimularEnvio(args, ctx),
    );
  },
};