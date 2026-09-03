# ETAPA 2 — Checklist de prueba manual

Este checklist es para probar personalmente el sistema una vez desplegado en
staging (ver `docs/ETAPA-2-CATALOGO-MAESTROS.md`, sección 16, para los pasos
exactos de despliegue). Cada paso indica la acción a realizar y el resultado
esperado. Si algún paso no da el resultado esperado, es un hallazgo real a
reportar — no lo resuelvas vos mismo modificando datos a mano.

> Nota: mientras no exista un staging desplegado, este mismo checklist se puede
> seguir en desarrollo local (`npm run dev:api`, `npm run dev:admin`, `npm run
dev:shop`, con Supabase Auth real configurado) — los pasos son idénticos.

---

## 1. Abrir staging

**Acción**: abrir en el navegador la URL de `admin-web` (ver sección 18 de
`docs/ETAPA-2-CATALOGO-MAESTROS.md` una vez desplegado).

**Resultado esperado**: se ve la pantalla de login de SistemaGrido (título,
campos Email/Contraseña, botón "Ingresar"), sin errores en la consola del
navegador.

---

## 2. Iniciar sesión

**Acción**: ingresar el email y la contraseña del usuario ADMIN creado en el
paso 7 de la sección 16 de `docs/ETAPA-2-CATALOGO-MAESTROS.md`, hacer clic en
"Ingresar".

**Resultado esperado**: la pantalla cambia a la vista principal (Dashboard),
sin quedarse en el login ni mostrar un error.

---

## 3. Verificar usuario

**Acción**: mirar el encabezado superior de la aplicación.

**Resultado esperado**: se ve tu nombre visible y tu rol (ADMIN) en la esquina
superior derecha.

---

## 4. Navegar

**Acción**: mirar el menú superior.

**Resultado esperado**: se ven los links "Inicio", "Productos", "Categorías",
"Sabores", "Usuarios" (todos visibles porque sos ADMIN).

---

## 5. Abrir Productos

**Acción**: hacer clic en "Productos" del menú.

**Resultado esperado**: se abre la pantalla de Productos, con un formulario
"Nuevo producto" arriba y una tabla "Catálogo" abajo con el catálogo real
cargado (si ya se corrió el importador — sección 12 del documento principal).

---

## 6. Buscar producto

**Acción**: escribir parte de un nombre o código conocido (por ejemplo
"LIMON" o "P001") en el campo de búsqueda de la tabla de Productos.

**Resultado esperado**: la tabla se filtra en el momento, mostrando sólo las
filas que coinciden por nombre o código.

---

## 7. Crear producto

**Acción**: completar el formulario "Nuevo producto" con un nombre de
prueba, elegir una categoría, un tipo, una unidad de manejo, dejar la
equivalencia en 1 (o el valor que corresponda), y hacer clic en "Crear
producto".

**Resultado esperado**: aparece un mensaje de "Guardando..." breve, el
formulario se limpia, y el nuevo producto aparece en la tabla de abajo con
estado "Activo".

---

## 8. Modificarlo

**Acción**: hacer clic en "Editar" sobre el producto recién creado, cambiar
el nombre o la equivalencia, hacer clic en "Guardar cambios".

**Resultado esperado**: la tabla se actualiza mostrando el nuevo valor.

---

## 9. Desactivarlo

**Acción**: hacer clic en "Desactivar" sobre ese mismo producto.

**Resultado esperado**: aparece un diálogo de confirmación ("¿Seguro que
querés desactivar...?"). Al confirmar, el estado del producto cambia a
"Inactivo" y el botón pasa a decir "Reactivar".

---

## 10. Administrar categoría

**Acción**: ir a "Categorías", crear una categoría nueva (por ejemplo
"Prueba Manual"), y luego crear una subcategoría eligiéndola como "Grupo
padre".

**Resultado esperado**: la categoría nueva aparece en la tabla; la
subcategoría aparece indentada debajo de su categoría padre (con el símbolo
"↳").

---

## 11. Administrar sabor

**Acción**: ir a "Sabores", crear un sabor de prueba, editarlo (cambiar el
nombre), y después desactivarlo.

**Resultado esperado**: cada acción se refleja de inmediato en la tabla,
igual que con Productos.

---

## 12. Administrar presentación/equivalencia

**Acción**: en "Productos", editar cualquier producto y cambiar su "Unidad
de manejo" (por ejemplo de Caja a Unidad) y su "Unidades por presentación"
(la equivalencia — cuántas unidades sueltas contiene).

**Resultado esperado**: los cambios se guardan y se reflejan en las
columnas "Unidad" y "Equiv." de la tabla. (No hay una pantalla separada de
"Presentaciones": la unidad de manejo y la equivalencia son parte del
formulario de cada producto — ver `docs/ETAPA-2-CATALOGO-MAESTROS.md`,
sección 4.2, para la justificación.)

---

## 13. Verificar errores de validación

**Acción**: en "Productos", intentar crear uno sin completar el nombre (dejar
el campo vacío) e intentar enviar el formulario. Después, intentar crear un
producto con un código que ya exista en la tabla.

**Resultado esperado**: en el primer caso, el navegador no deja enviar el
formulario (campo obligatorio). En el segundo caso, aparece un mensaje de
error rojo indicando que el código ya existe — el producto no se crea.

---

## 14. Cerrar sesión

**Acción**: hacer clic en "Salir" (arriba a la derecha).

**Resultado esperado**: la aplicación vuelve a la pantalla de login. Si
intentás volver atrás con el navegador, no se puede ver ninguna pantalla
protegida sin loguearte de nuevo.

---

## 15. Abrir Shop PWA

**Acción**: abrir en el navegador la URL de `shop-pwa` (distinta de
`admin-web`) e iniciar sesión con un usuario de rol Empleada de heladería o
Encargado de depósito (o el mismo ADMIN, si todavía no creaste otro usuario).

**Resultado esperado**: se ve una pantalla simple, mobile-first, con tu
nombre, tu rol y tu sucursal asignada (si tenés una) en el encabezado, y un
mensaje claro indicando que las funciones operativas (conteo, mermas, etc.)
todavía no están disponibles — sin ninguna pantalla de trabajo simulada.
