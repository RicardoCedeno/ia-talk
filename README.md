# Pip: agente con IA en un mundo 3D

Angular 22 + Three.js. Dos personajes hechos con formas básicas viven en un claro del bosque; el "cerebro" de cada uno es `gpt-4o-mini`, que elige una acción cada vez mediante tool calling. Pueden conversar, regalarse manzanas y pelearse.

## Arrancar

1. Copia `src/environments/environment.local.example.ts` como `environment.local.ts` y pon tu API key (ese archivo está en `.gitignore`).
2. `npm install`
3. `npm start` y abre http://localhost:4200

## Cómo funciona

- **Percepción** (`agent/perception.ts`): cono de visión de 120° y 14 m, con raycast contra troncos y rocas. Lo visto se guarda en la memoria espacial del agente.
- **Cerebro** (`agent/brain.ts`): convierte la situación en JSON, pide una acción a OpenAI, la ejecuta y guarda el resultado como suceso. Los sucesos antiguos se resumen para que el prompt no crezca.
- **Acciones** (`agent/actions.ts`): generadores que avanzan un frame cada vez (caminar, recoger, comer, beber, cofre, hablar, explorar...).
- **Cuerpo** (`agent/agent-body.ts`): primitivas con animaciones procedurales.
- **Necesidades**: el hambre y la sed suben con el tiempo; las manzanas reaparecen junto a los árboles.
- **Personajes** (`ui/setup.*`, `agent/profile.ts`): antes de empezar defines por texto la personalidad, los gustos y la relación inicial. Se guarda en `localStorage`.
- **Vida social** (`agent/social.ts`): hablan de cerca con `talk_to` (4,5 m) o se gritan de lejos con `shout_to` (30 m, aunque no se vean; el que oye sabe de dónde viene la voz). Las frases repetidas se rechazan y, con hambre o sed críticas, la charla pendiente pasa a segundo plano. Cada frase lleva un tono (amable, neutral, molesto, hostil) que sube o baja la afinidad (-100..100). Por debajo de -40 están **peleados**: el prompt les pide frialdad y evitarse (`avoid`), y el cuerpo lo muestra (brazos cruzados, cara roja, 💢). Con el tiempo se les pasa; un regalo (`give`) acelera la reconciliación.

- **Memoria** (`agent/memory.ts`, `agent/reflection.ts`): al empezar, cada personaje amplía su personalidad con intereses, manías, forma de hablar, pasado y un secreto. Cada pocas frases reflexiona: guarda recuerdos concretos (lo que el otro le contó, ofensas, favores), actualiza su opinión de los demás según sus propios gustos (lo que también mueve la afinidad) y anota los temas ya hablados para no repetirlos. Todo se guarda en `localStorage` por nombre, así que recuerdan partidas anteriores (se puede desactivar o borrar en la pantalla inicial).
- **Objetos imposibles** (`world/marvels.ts`, ocultos por defecto: se activan en la pantalla inicial o con el botón «Mostrar objetos raros» en plena partida): una esfera que susurra (si la tocas te revela lo que otro piensa de ti, o su secreto, y te da el poder de levitar: `levitate` / `land`; flotando se sobrevuelan rocas, cofre y estanque, pero hay que bajar para coger cosas o beber), una puerta sin pared que teletransporta a quien la cruza, una estatua idéntica a uno de los personajes que se gira para mirar a quien tenga cerca, y una nube diminuta que, si la tocas, te persigue lloviéndote encima (y salta a quien se acerque). Se interactúa con `examine` y `touch`.
- **Deseos** (`world/wishes.ts`): si un personaje dice en voz alta «Deseo un/una …» (o usa la acción `wish`), gpt-4o-mini diseña el objeto con piezas primitivas (formas, colores, tamaños y posiciones en JSON) y aparece a su lado con un destello. Puede ser comida o bebida (se consume al tocarlo), dar el poder de levitar o simplemente ser un objeto curioso. Un deseo cada 45 s por personaje, como mucho 5 objetos a la vez, y a veces se cumple «con truco». Se desactiva en la pantalla inicial.

Con la IA en pausa puedes mover al personaje seleccionado haciendo clic en el suelo o en un objeto. En desarrollo, la simulación está disponible en la consola como `window.pip`.
# ia-talk
