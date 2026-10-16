# Plan actualizado: PayBox Tribunal — 15 oct 2026

Leyenda: ✅ verificado · ⚠️ inferencia · ❓ pendiente

## 1. Lo que cambió tras investigar

| Tema | Antes | Ahora |
|---|---|---|
| Página oficial | No verificada | ✅ `developer.paybox.sh` (enlazada desde la búsqueda; el título dice **1.º lugar: $5k USDC**). Pozo: $20k en la cabecera, $15k en otra versión → tomar el dato al abrir |
| Fecha límite | ❓ | ❓ Sigue sin publicarse: va en los "Chapter Details" del 16. Entregas tardías no se aceptan |
| ¿Programar antes? | ❓ | ✅ Los términos permiten material previo **si se declara** → ya está en el README |
| Criterios | ⚠️ | ✅ Términos: calidad, completitud, cumplimiento, creatividad, utilidad y ejecución técnica |
| IP | ❓ | ✅ Conservas la propiedad; MoonPay recibe licencia amplia de uso promocional |
| Formato del plugin | ❓ | ⚠️ El plugin oficial (`moonpay/paybox-plugin`) es un paquete con `.grok-plugin/plugin.json` + `skills/` + `.mcp.json`. El hackathon dice: "PayBox habla x402 nativo: envuelve tu endpoint y funciona dentro de PayBox". **Ruta rápida = servicio x402 + skill** |
| Competencia | ❓ | ✅ Existe **x402r**: reembolsos con contrato escrow en cadena + árbitro, con disputa manual. Ganó un hackathon de Coinbase/EF |
| Librería x402 | ❓ | ✅ `@x402/hono` v2 + `@x402/core` + `@x402/evm`. Testnet: Base Sepolia `eip155:84532`, facilitador `https://x402.org/facilitator` |

## 2. La idea mejoró: de "reembolso" a "pago contra validación"

Leí el código del middleware oficial de x402: **el pago se verifica antes del handler y se liquida
después, solo si la respuesta es < 400**. Por eso:

- Si el resultado falla → respondemos **422** → **el dinero nunca se mueve**. No hace falta reembolsar.
- Los créditos quedan para **apelaciones** sobre resultados ya entregados y cobrados.

**Diferencia con x402r (para el pitch):** x402r requiere un esquema escrow propio y una disputa manual.
Tribunal funciona con el x402 `exact` estándar que PayBox ya firma, decide solo y en el momento,
y publica cada veredicto. Hay que ser honestos con el límite: la garantía depende de que el vendedor no
liquide igual; por eso el registro público y el puntaje.

## 3. Estado del código (hecho hoy)

- ✅ Servidor Hono + x402 v2 real. Probado: responde 402 con `PAYMENT-REQUIRED` (USDC, Base Sepolia).
- ✅ Contrato publicado (`GET /contract`), validador por reglas y juez de IA (Claude, salida estructurada).
- ✅ Veredictos públicos, apelaciones con recibo, vouchers firmados de un solo uso, puntaje Wilson.
- ✅ Hook de liquidación: registra la transacción real en el caso.
- ✅ Fallos de demo (`x-demo-fault`) para el video.
- ✅ 19 tests pasando (`npm test`), tipado estricto limpio.
- ⚠️ Borrador de `plugin/plugin.json` y `plugin/skills/tribunal/SKILL.md`.

## 4. Riesgos que hay que probar el 16

1. **¿Cómo reacciona PayBox a un 422 tras firmar?** `use_service` devuelve `{status, body}`; falta ver qué
   estado muestra la solicitud (¿`pending_settlement` eterno? ¿`error`?). Es lo primero que hay que probar.
2. **Formato real del marketplace** y proceso de entrega: leer los Chapter Details apenas abran.
3. **Base mainnet vs testnet:** PayBox probablemente opera en mainnet. El facilitador de x402.org es solo
   testnet → para mainnet hace falta un facilitador (p. ej. CDP de Coinbase, requiere claves).
4. **Wallet EOA:** si la wallet de PayBox está delegada con EIP-7702, `pay_x402` falla o pide paso extra.
5. **Despliegue público** con HTTPS (Railway/Render/Fly; los Workers de Cloudflare requieren adaptar el store).

## 5. Plan desde el 16 oct

1. Leer Chapter Details: fecha límite, formato, entrega. Ajustar este plan.
2. Registro + KYC + onboarding de PayBox. Wallet nueva solo para pruebas.
3. Desplegar en un host con HTTPS y probar de punta a punta con PayBox en Claude (MCP), en este orden:
   entrega OK → 422 sin cobro → apelación → voucher gratis.
4. Configurar `ANTHROPIC_API_KEY` para extracción y juez reales.
5. Adaptar `plugin/` al formato oficial y publicar.
6. Página simple de veredictos/puntaje (se ve bien en el video).
7. Video 60–90 s y publicar en X. Entregar con margen.

## 6. Guion del video (60–90 s)

1. "Los agentes ya pagan solos. ¿Y si el servicio entrega basura?" (2 s de un JSON roto).
2. Claude con PayBox pide extraer una factura → aprobación con passkey → 200, datos correctos, tx en la cadena.
3. Mismo flujo con un fallo forzado → **422: "Tu pago no se liquidó"** → wallet sin cambios.
4. Fallo sutil (`swapped_items`, pasa todas las reglas) → el juez de IA lo atrapa. Mostrar también la página de veredictos en vivo.
5. Apelación sobre un resultado entregado → voucher → reintento gratis sin aprobación.
6. Cierre: puntaje de confianza público. "Paga solo si funciona."

## 7. Seguridad (sin cambios)

Wallet nueva con fondos mínimos · nunca compartir frase semilla · solo enlaces oficiales ·
ignorar DMs de "ayuda" · `DEMO_FAULTS=0` en producción.
