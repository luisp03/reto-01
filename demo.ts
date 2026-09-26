import { rmSync } from "node:fs";

import {
  armar_paquete,
  generar_formulario,
  leer_solicitud,
  mapear_campos,
} from "./src/tools/proveedor";
import { CampoMapeado, ToolContext } from "./src/tools/schemas";

type ToolResponse<T> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: string;
    };

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

function parseToolResponse<T>(resultado: string): ToolResponse<T> {
  return JSON.parse(resultado) as ToolResponse<T>;
}

function exigirOk<T>(
  resultado: ToolResponse<T>,
  etapa: string,
): T {
  if (!resultado.ok) {
    throw new Error(`${etapa}: ${resultado.error}`);
  }

  return resultado.data;
}

async function main(): Promise<void> {
  rmSync("out", {
    recursive: true,
    force: true,
  });

  const ctx: ToolContext = {
    directory: process.cwd(),
    sessionId: "demo",
  };

  const casos = [
    "co-industrias-delta",
    "ec-corp-andina",
    "hn-agroexport-sula",
    "pa-logistica-istmo",
  ];

  for (const caso of casos) {
    try {
      const solicitud = exigirOk<LeerSolicitudData>(
        parseToolResponse<LeerSolicitudData>(
          await leer_solicitud.execute({ caso }, ctx),
        ),
        "leer_solicitud",
      );

      const mapeo = exigirOk<MapearCamposData>(
        parseToolResponse<MapearCamposData>(
          await mapear_campos.execute(
            {
              caso,
              campos: solicitud.campos,
            },
            ctx,
          ),
        ),
        "mapear_campos",
      );

      const todosLosCampos: CampoMapeado[] = [
        ...mapeo.llenos,
        ...mapeo.faltantes,
        ...mapeo.requiere_confirmacion,
      ];

      const resultadoFormulario = parseToolResponse<GenerarFormularioData>(
        await generar_formulario.execute(
          {
            caso,
            mapeo: todosLosCampos,
          },
          ctx,
        ),
      );

      if (!resultadoFormulario.ok) {
        if (resultadoFormulario.error !== "formato no soportado") {
          throw new Error(`generar_formulario: ${resultadoFormulario.error}`);
        }
        console.log(`  (formato no soportado — se generó valores-portal.md como alternativa)`);
      }

      const paquete = exigirOk<ArmarPaqueteData>(
        parseToolResponse<ArmarPaqueteData>(
          await armar_paquete.execute({ caso }, ctx),
        ),
        "armar_paquete",
      );

      console.log("");
      console.log(`Caso: ${caso}`);
      console.table([
        {
          formato: solicitud.formato,
          llenos: mapeo.llenos.length,
          faltantes: mapeo.faltantes.length,
          requiere_confirmacion:
            mapeo.requiere_confirmacion.length,
          listo_para_firma: paquete.listo_para_firma,
          ruta_paquete: paquete.ruta,
        },
      ]);
    } catch (error: unknown) {
      const mensaje =
        error instanceof Error ? error.message : String(error);

      console.error("");
      console.error(`Caso: ${caso}`);
      console.error(`ERROR: ${mensaje}`);
    }
  }
}

await main();