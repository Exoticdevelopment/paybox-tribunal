# Preguntas que te pueden hacer (y cómo responder)

Estudia esto hasta poder decirlo sin leer. Cada respuesta tiene una versión corta en inglés para decirla tal cual.

---

## 1. ¿Qué hace tu proyecto, en una frase?
Si la API no cumple lo que prometió, el agente no paga.
> *"If the API doesn't keep its promise, the agent doesn't pay."*

## 2. ¿Cómo evitas el cobro si el resultado es malo?
En x402 el pago tiene dos pasos: **verificar** la firma y **liquidar** (mover el dinero). Tribunal verifica,
ejecuta el servicio, revisa el resultado, y solo si cumple responde 200 y se liquida. Si no cumple responde
**422** y el middleware oficial (`@x402/hono`) nunca liquida. El dinero nunca se mueve.
> *"x402 verifies first and settles later. We judge in between. A 422 means settlement never happens."*

## 3. ¿Qué es EIP-3009?
Es el estándar de USDC que permite pagar con una **firma** en vez de una transacción. El agente firma
"autorizo pagar X a Y", con un número único (nonce) y una fecha límite. Quien tenga la firma puede cobrarla
una sola vez, antes de la fecha límite.
> *"It's a signed authorization to transfer USDC. Single use, with a nonce and a deadline."*

## 4. ¿Y si el vendedor es deshonesto y cobra igual la firma rechazada?
Puede intentarlo, porque tiene la firma por 5 minutos. Pero Tribunal **revisa la blockchain**: consulta a USDC
si ese nonce se usó (`authorizationState`). Si se usó, marca el caso públicamente como
"settled_despite_rejection" y la puntuación de confianza del servicio cae a **0**. El fraude queda a la vista.
> *"We audit every rejected case on-chain. If the nonce was used, it's public fraud and trust drops to zero."*

## 5. ¿Por qué no un contrato de escrow (depósito en garantía)?
Porque funciona **hoy** con lo que PayBox ya firma (x402 `exact` en Base), sin contratos nuevos, sin disputas
ni fianzas. El escrow da una garantía más fuerte para pagos grandes; está en la hoja de ruta como complemento.
> *"It works today with what PayBox already signs. Escrow is stronger for big payments; it's on our roadmap."*

## 6. ¿La IA decide si te cobran? ¿Y si se equivoca?
Primero van las **reglas exactas** (matemáticas, límites, campos, fechas). La IA solo revisa lo que las reglas no
pueden ver. Y para rechazar, **dos revisiones independientes** tienen que encontrar el problema; una de ellas
defiende al vendedor. Si no están de acuerdo, la IA se abstiene y deciden las reglas.
> *"Rules first. The AI can only reject when two independent reviews agree. Otherwise it abstains."*

## 7. ¿Y si Gemini se cae?
Las reglas siguen funcionando sin IA. Además: respuestas guardadas, varios modelos de respaldo, reintentos, y los
ejemplos se preparan al arrancar. Si nada responde, la IA se abstiene. Nadie paga por una suposición.
> *"The AI is never required for objective checks. If it's down, it abstains and the rules decide."*

## 8. ¿Por qué los vendedores lo usarían?
Porque no tienen que cambiar nada: pegan la URL de su API, escriben su promesa, y Tribunal se pone delante
(el "instant guarantee"). Ganan una puntuación de confianza pública, y los agentes prefieren pagar a quien garantiza.
> *"Zero code. Paste your URL, write your promise. Agents trust guaranteed APIs more."*

## 9. ¿Qué es el certificado y por qué Ed25519?
Cada caso produce un certificado firmado con Ed25519 (una firma digital rápida y estándar). Incluye el contrato,
el veredicto y el hash del resultado. Cualquiera puede verificarlo con la clave pública; el plugin lo verifica solo.
> *"Every verdict is signed. Anyone can verify it with our public key, and the plugin does it automatically."*

## 10. ¿Qué evita que el agente pague dos veces?
Una misma firma de pago no se acepta dos veces (409 "payment_already_used"), y con `Idempotency-Key` una
repetición devuelve la respuesta original sin cobrar de nuevo.
> *"The same payment can't be used twice, and retries return the original answer."*

## 11. ¿Qué es el compilador de promesas?
El vendedor escribe su promesa en lenguaje normal. Se convierte en reglas de un **catálogo cerrado de 9 tipos**.
La IA nunca escribe código que se ejecute. Cada promesa dice qué tan segura es la revisión, y lo subjetivo
("tono profesional") se marca como **no garantizado**, nunca se inventa.
> *"Plain-language promises become checks from a closed catalog. Subjective promises are refused, not faked."*

## 12. ¿Qué no hace todavía? (Responde con honestidad: suma puntos)
- La no-liquidación la hace cumplir el servidor, no un contrato; el fraude se detecta, no se impide. Escrow está en la hoja de ruta.
- La base de datos es un archivo JSON (suficiente para la demo).
> *"Non-settlement is enforced by our server and audited on-chain, not by a smart contract yet."*

---

### Si no sabes una respuesta
> *"Good question. I don't want to guess. It's documented in the README, and I'm happy to follow up."*
