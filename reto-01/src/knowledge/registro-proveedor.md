# Conocimiento de dominio — Registro de proveedores

## Proceso

El registro de proveedores consiste en recibir una solicitud de alta o actualización,
identificar los campos y soportes exigidos por el cliente, y contrastarlos exclusivamente
contra la información disponible en el maestro de Periferia y su repositorio documental.
El objetivo es preparar la información requerida con trazabilidad suficiente para que los
datos puedan ser revisados antes de completar, enviar o firmar la documentación.

## Identificador tributario por país

| País | Identificador tributario |
|---|---|
| CO | NIT |
| EC | RUC |
| PE | RUC |
| PA | RUC |
| HN | RTN |

Periferia dispone únicamente de NIT como identificador tributario en su maestro. Cuando la
solicitud corresponde a Colombia (`CO`), el campo tributario puede mapearse contra el NIT
del maestro. Para cualquier país distinto de Colombia, el campo debe quedar como
`requiere_confirmacion` con la nota **"identificador extranjero"**. No debe transformarse
el NIT de Periferia en un RUC, RTN u otro identificador ni debe inventarse un identificador
extranjero.

## Estados de los campos

Cada campo mapeado debe clasificarse como `lleno`, `faltante` o
`requiere_confirmacion`.

- **lleno:** existe un valor en el maestro y puede utilizarse como fuente del campo.
- **faltante:** la plantilla solicita el campo, pero no existe un valor disponible en el
  maestro.
- **requiere_confirmacion:** existe información relacionada o una regla que impide
  completarlo automáticamente. También aplica cuando la confianza del mapeo es menor
  a `0.8`.

La distinción es importante para mantener trazabilidad. `faltante` significa que no existe
un dato fuente disponible; `requiere_confirmacion` significa que existe una condición que
requiere revisión humana. Ningún valor debe inferirse, fabricarse o derivarse sin una
fuente válida en el maestro.

## Datos bancarios

Los datos bancarios solo deben incluirse cuando la plantilla de registro los solicita
explícitamente. Que un dato como banco o cuenta exista en el maestro no significa que
deba incorporarse automáticamente a una respuesta.

Los datos bancarios **nunca deben incluirse en el borrador de correo**. El correo debe
limitarse a la información necesaria para comunicar el estado de la solicitud, las
confirmaciones requeridas o los soportes pendientes.

## Vigencia de soportes

Los soportes exigidos deben contrastarse con el índice documental disponible y con su fecha
de vigencia. Un soporte vencido constituye un bloqueo para alcanzar el estado
`listo_para_firma`.

En cambio, un campo de información faltante no bloquea por sí mismo
`listo_para_firma`; debe quedar identificado como `faltante` para permitir su trazabilidad
y posterior gestión. La ausencia de un dato nunca debe resolverse inventando un valor.