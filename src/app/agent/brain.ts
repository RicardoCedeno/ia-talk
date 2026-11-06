import { ActionContext, describeAction, MIN_HUNGER_TO_EAT, reach, startAction, TOOLS } from './actions';
import { CharacterCard, LongTermMemory } from './memory';
import { Perceived } from './perception';
import { generateCard, profileSource, reflect } from './reflection';
import { WISH_COOLDOWN, WishSystem } from '../world/wishes';
import { CharacterProfile } from './profile';
import { relationLabel, SHOUT_DISTANCE, TALK_DISTANCE } from './social';
import { ChatResponse, OpenAiError, OpenAiService } from '../core/openai.service';
import { TYPE_NAMES } from '../world/entities';

/** Tiempo mínimo entre el inicio de dos decisiones. */
const MIN_CYCLE_MS = 2500;
const MAX_CALLS_PER_MINUTE = 20;
/** Cuando hay más sucesos que esto, los más antiguos se resumen. */
const EVENT_LIMIT = 24;
const SUMMARY_CHUNK = 12;
const DIALOGUE_LIMIT = 16;
const SPEECH_TOOLS = new Set(['talk_to', 'shout_to']);
/** A partir de aquí una necesidad pasa por delante de cualquier conversación. */
const CRITICAL_NEED = 75;
/** Reflexiona tras este número de líneas de conversación nuevas... */
const REFLECT_AFTER_LINES = 6;
/** ...o tras estos sucesos, si ha pasado al menos REFLECT_MIN_SECONDS. */
const REFLECT_AFTER_EVENTS = 12;
const REFLECT_MIN_SECONDS = 60;
const MIN_MEMORY_IMPORTANCE = 3;
const MAX_MEMORIES_PER_REFLECTION = 3;
/** Frases seguidas sin hacer nada más: a partir de aquí se le pide actuar... */
const SPEECH_STREAK_HINT = 3;
/** ...y a partir de aquí se queda sin saliva hasta que haga otra cosa. */
const SPEECH_STREAK_LIMIT = 4;

function cardBlock(card: CharacterCard | null): string {
  if (!card) return '';
  return `
MÁS SOBRE TI:
- Te apasiona: ${card.interests.join('; ')}.
- Manías: ${card.quirks.join('; ')}.
- Forma de hablar: ${card.speech}
- Tu pasado: ${card.backstory}
- Un secreto que no cuentas fácilmente: ${card.secret}`;
}

const WISH_RULES = `
Magia del claro:
- Dicen que en este claro, si pides un deseo en voz alta (con wish, o diciendo "Deseo un/una …" en cualquier
  frase), se cumple y lo deseado aparece a tu lado en un destello. A veces se cumple con truco, como un genio travieso.
- Pide cosas que encajen con tu personalidad, tus gustos y lo que te pasa (un capricho, algo que necesitas, algo para
  impresionar o fastidiar al otro…). La magia tarda en recargarse: como mucho un deseo por minuto.
- Lo que aparece es un objeto más: puedes examinarlo, tocarlo, enseñárselo a los demás o discutir por él.`;

function systemPrompt(p: CharacterProfile, backstory: string, card: CharacterCard | null, wishes: boolean): string {
  return `Eres ${p.name}, un personaje que vive en un claro del bosque, en un mundo 3D, junto a otros personajes.
Controlas tu cuerpo eligiendo UNA acción cada vez con las herramientas disponibles.

TU PERSONALIDAD: ${p.personality.trim() || '(sin definir: invéntate una coherente)'}
TUS GUSTOS Y PREFERENCIAS: ${p.preferences.trim() || '(sin definir)'}
TU HISTORIA CON LOS DEMÁS: ${backstory}${cardBlock(card)}
Actúa SIEMPRE de forma coherente con tu personalidad y tus preferencias, tanto en lo que haces como en cómo hablas.
No seas amable por defecto: tu forma de hablar y tu tono salen de TU personalidad y de cómo va la relación.
Si eres sarcástico, gruñón, orgulloso o desconfiado, muéstralo en cada frase y no te ablandes a la primera.

Necesidades:
- hambre y sed van de 0 (saciado) a 100 (desesperado) y suben con el tiempo.
- Comes manzanas, que aparecen en el suelo junto a los árboles. Bebes en el estanque.
- Puedes guardar manzanas en el cofre para más tarde.
- Atiende primero la necesidad más alta. Con hambre por debajo de ${MIN_HUNGER_TO_EAT} no puedes comer.

Reglas del mundo:
- Solo puedes interactuar con lo que está "al_alcance"; si no, usa antes walk_to con su id.
- Solo puedes usar ids que aparezcan en "veo_ahora", "recuerdo" o "personajes".
- Solo puedes llevar una cosa en las manos.
- Si no ves lo que necesitas, explora con wander (te lleva a zonas que aún no has visto) o look_around.
- Aprende de los fallos de "sucesos recientes" y no repitas la misma acción fallida.

Vida social:
- Si alguien está cerca (menos de ${TALK_DISTANCE} m) háblale con talk_to. Si está lejos, grítale con shout_to
  (hasta ${SHOUT_DISTANCE} m, aunque no le veas): no hace falta acercarse para conversar. say es para hablar solo.
- Si alguien aparece en "debes_responder_a", respóndele (talk_to o shout_to según la distancia) antes de hacer
  otra cosa, salvo que estés enfadado y quieras ignorarle a propósito.
- Las conversaciones duran VARIOS turnos: responde a lo que te dicen y continúa el tema, haz preguntas,
  cuenta anécdotas, opina, bromea, discute o propón planes. No cortes la charla tras una o dos frases.
- Si tu hambre o tu sed llegan a 70, atiende PRIMERO esa necesidad aunque debas una respuesta; puedes
  contestar después, o a gritos mientras vas de camino.
- Si quieres que alguien venga o estáis lejos, ve tú hacia él (walk_to); no le grites lo mismo una y otra vez.
- Cada frase debe ser NUEVA: no repitas ni parafrasees lo que ya dijiste en la conversación reciente.

Cosas imposibles:
- En el claro hay objetos que NO deberían existir ("objeto imposible"). No es normal: nunca habías visto nada así.
- Reacciona según TU personalidad: miedo, fascinación, desconfianza, burla, superstición, teorías locas…
  Puedes acercarte, examinarlos (examine), tocarlos (touch) o mantenerte lejos.
- Hablar de ellos no basta. Si eres curioso, atrevido o impulsivo, VE a examinarlos y tócalos (aunque dé miedo).
  Si eres miedoso, desconfiado o prudente, mantente lejos, advierte a los demás o búrlate de quien se acerque.
- Lo que te pase con ellos es un tema estupendo para hablar, discutir o advertir a los demás.
- Si alguien hace algo imposible delante de ti (desaparecer, aparecer de la nada, flotar…), reacciona.

Superpoderes:
- Si consigues un poder (aparece en "poderes"), PRUÉBALO pronto en vez de solo hablar de él, y luego úsalo
  cuando quieras y como encaje con tu personalidad: presumir, explorar, asustar, ayudar, huir de una discusión…
- Levitando ("flotando": true) pasas por encima de rocas, del cofre y del estanque, pero para coger cosas,
  beber o usar el cofre tienes que bajar con land.
${wishes ? WISH_RULES : ''}

De qué hablar:
- La comida y el agua son solo necesidades: NO las conviertas en el tema de conversación.
- Habla de tus intereses y tu pasado, opina, pregunta al otro por su vida y sus gustos, cuenta anécdotas,
  propón planes, bromea o saca rencillas pendientes. Usa las "Ideas para conversar".
- Usa tus recuerdos: menciona lo que el otro te contó o lo que pasó entre vosotros (también "de otra vez").
- Evita los temas que ya se han hablado mucho: si un tema sale ×3 o más, cambia de tema aunque te guste.
- Tus gustos importan: si el otro dice o hace algo que choca con ellos, te molesta y lo dices;
  si coincide con ellos, te cae mejor.
- Pon en "tone" el tono real de cada frase: molesto y hostil empeoran la relación; amable la mejora.
- No discutas sin motivo, pero si algo choca con tu personalidad o tus preferencias, puedes enfadarte y discutir.
- Tu "afinidad" con cada personaje va de -100 a 100 y cambia según cómo os tratáis.
- Si la relación es "peleados", ESTÁS DE PELEA: habla con frialdad o con reproches, evita su compañía
  (avoid), no compartas comida ni le ayudes. Solo te reconcilias si te piden perdón, te hacen un regalo,
  o si tu personalidad es conciliadora. Regalar una manzana (give) es una buena forma de hacer las paces.
- Con "tensos" desconfías y estás a la defensiva; con "amigos" eres cálido y generoso.

El campo reasoning es tu pensamiento interno: breve (máx. 20 palabras) y en primera persona. Todo en español.`;
}

export type BrainLogKind = 'think' | 'action' | 'result' | 'fail' | 'error' | 'info' | 'memory';

export interface BrainHooks {
  log(kind: BrainLogKind, text: string): void;
  usage(inputTokens: number, outputTokens: number): void;
  thinking(on: boolean): void;
  thought(text: string): void;
  fatal(message: string): void;
  /** La memoria a largo plazo ha cambiado (para guardarla). */
  memoryChanged(): void;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Bucle de decisión de un personaje: observa, pregunta al modelo y ejecuta la acción. */
export class Brain {
  private loopToken = 0;
  private busy = false;
  private events: string[] = [];
  private dialogue: string[] = [];
  private summary = '';
  private summarizing = false;
  private callTimes: number[] = [];
  private lastHeardAt = 0;
  /** Quién le ha hablado sin que haya respondido aún, y cuándo (tiempo de simulación). */
  private readonly pendingReplies = new Map<string, number>();
  private wakeRequested = false;
  private wakeUp: (() => void) | null = null;
  private readonly reminder: string;
  private linesSinceReflection = 0;
  private eventsSinceReflection = 0;
  private lastReflectionAt = 0;
  private reflecting = false;
  /** Cuántas acciones de hablar lleva seguidas (para que no se pasen la vida charlando a gritos). */
  private speechStreak = 0;
  /** Cuándo pidió su último deseo (tiempo de simulación), o null si aún no ha pedido ninguno. */
  private lastWishAt: number | null = null;

  constructor(
    private readonly openai: OpenAiService,
    private readonly ctx: ActionContext,
    private readonly profile: CharacterProfile,
    private readonly backstory: string,
    readonly memory: LongTermMemory,
    private readonly options: { wishes: boolean },
    private readonly clock: () => number,
    private readonly getVisible: () => Perceived[],
    private readonly hooks: BrainHooks,
  ) {
    // Se repite al final de cada mensaje: los modelos pequeños tienden a volverse amables y genéricos.
    this.reminder = `Recuerda: eres ${profile.name}. ${profile.personality.trim()}`;
  }

  /** Genera (o reutiliza) la ficha ampliada del personaje antes de empezar. */
  async prepare(): Promise<void> {
    const memory = this.memory;
    if (memory.card?.source !== profileSource(this.profile)) {
      try {
        memory.card = await generateCard(this.openai, this.profile, (i, o) => this.hooks.usage(i, o));
        this.hooks.memoryChanged();
      } catch (e) {
        this.hooks.log('error', `No se pudo crear su ficha: ${String(e)}`);
      }
    }
    if (!memory.nextTopics.length && memory.card) memory.nextTopics = memory.card.interests.slice(0, 3);
  }

  /** Añade un suceso a la memoria a corto plazo del agente. */
  remember(text: string): void {
    this.events.push(`[t=${Math.round(this.clock())}s] ${text}`);
    this.eventsSinceReflection++;
    if (this.events.length > EVENT_LIMIT && !this.summarizing) void this.summarize();
    this.maybeReflect();
  }

  /**
   * Ha oído algo: suceso + línea de conversación. Con `fromId`, iba dirigido a él
   * y queda pendiente de respuesta. `faceToFace`: se lo han dicho al lado, así que
   * si estaba decidiendo otra cosa conviene reconsiderarlo.
   */
  hear(line: string, fromId?: string, faceToFace = false): void {
    this.remember(line);
    this.addDialogue(line);
    if (fromId) this.pendingReplies.set(fromId, this.clock());
    if (faceToFace) this.lastHeardAt = performance.now();
  }

  /** Lo que él mismo ha dicho a alguien, para que la conversación tenga contexto. */
  noteSaid(line: string, toId: string): void {
    this.addDialogue(line);
    this.pendingReplies.delete(toId);
  }

  /** Corta la espera entre decisiones (p. ej. porque le acaban de hablar). */
  wake(): void {
    this.wakeRequested = true;
    this.wakeUp?.();
  }

  start(): void {
    const token = ++this.loopToken;
    void this.loop(token);
  }

  stop(): void {
    this.loopToken++;
    this.wakeUp?.();
  }

  /** Una sola decisión (con la IA en pausa). */
  async step(): Promise<void> {
    await this.cycle(null);
  }

  private addDialogue(line: string): void {
    this.dialogue.push(`[t=${Math.round(this.clock())}s] ${line}`);
    if (this.dialogue.length > DIALOGUE_LIMIT) this.dialogue.shift();
    this.linesSinceReflection++;
    this.maybeReflect();
  }

  private maybeReflect(): void {
    if (this.reflecting || this.loopToken === 0) return;
    const enoughTalk = this.linesSinceReflection >= REFLECT_AFTER_LINES;
    const enoughEvents =
      this.eventsSinceReflection >= REFLECT_AFTER_EVENTS &&
      this.clock() - this.lastReflectionAt >= REFLECT_MIN_SECONDS;
    if (enoughTalk || enoughEvents) void this.reflectNow();
  }

  /** Repasa lo ocurrido y actualiza recuerdos, opiniones y temas. No bloquea las decisiones. */
  private async reflectNow(): Promise<void> {
    this.reflecting = true;
    this.linesSinceReflection = 0;
    this.eventsSinceReflection = 0;
    this.lastReflectionAt = this.clock();
    const { agent, social } = this.ctx;
    const memory = this.memory;
    const others = social.others(agent);
    try {
      const result = await reflect(
        this.openai,
        {
          profile: this.profile,
          memories: memory.items.map((i) => `- (${i.about}) ${i.text}`).join('\n'),
          opinions: [...memory.opinions].map(([id, text]) => `- ${id}: ${text}`).join('\n'),
          dialogue: this.dialogue.join('\n'),
          events: this.events.slice(-12).join('\n'),
          characters: others.map((o) => ({ id: o.id, nombre: o.name })),
        },
        (i, o) => this.hooks.usage(i, o),
      );

      const validAbout = new Set(['yo', 'mundo', ...others.map((o) => o.id)]);
      // Solo lo que de verdad importa: el modelo tiende a apuntar cada frase como "recuerdo".
      const worthKeeping = (result.recuerdos ?? [])
        .filter((r) => r.importancia >= MIN_MEMORY_IMPORTANCE)
        .sort((a, b) => b.importancia - a.importancia)
        .slice(0, MAX_MEMORIES_PER_REFLECTION);
      for (const r of worthKeeping) {
        const about = validAbout.has(r.sobre) ? r.sobre : 'mundo';
        if (memory.add(about, r.texto, r.importancia)) this.hooks.log('memory', `Recuerda: ${r.texto}`);
      }
      for (const o of result.opiniones ?? []) {
        const other = social.agent(o.id);
        if (!other || other === agent) continue;
        memory.opinions.set(o.id, o.opinion.slice(0, 160));
        const delta = Math.max(-8, Math.min(8, Math.round(o.ajuste_afinidad) || 0));
        if (delta) {
          agent.changeAffinity(o.id, delta);
          this.hooks.log('memory', `Opina de ${other.name}: ${o.opinion} (${delta > 0 ? '+' : ''}${delta})`);
        }
      }
      memory.noteTopics(result.temas_hablados ?? []);
      if (result.proximos_temas?.length) memory.nextTopics = result.proximos_temas.slice(0, 4);
      this.hooks.memoryChanged();
    } catch {
      // Si falla, se reintentará con la siguiente tanda de sucesos.
    } finally {
      this.reflecting = false;
    }
  }

  /** Recuerdos, opiniones y temas en texto para el prompt de decisión. */
  private memoryBlock(): string {
    const memory = this.memory;
    const { agent, social } = this.ctx;
    const aboutLabel = (about: string) =>
      about === 'yo' ? 'sobre ti' : about === 'mundo' ? 'del claro' : `sobre ${social.agent(about)?.name ?? about}`;
    const lines: string[] = [];
    if (memory.items.length) {
      lines.push('Tus recuerdos importantes:');
      for (const i of memory.items) {
        const old = i.session !== memory.session ? ', de otra vez' : '';
        lines.push(`- (${aboutLabel(i.about)}${old}) ${i.text}`);
      }
    }
    const opinions = social
      .others(agent)
      .filter((o) => memory.opinions.has(o.id))
      .map((o) => `- ${o.name}: ${memory.opinions.get(o.id)}`);
    if (opinions.length) lines.push('Lo que opinas de los demás:', ...opinions);
    const topics = [...memory.topics]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([t, n]) => `${t} (×${n})`);
    if (topics.length) lines.push(`Temas ya muy hablados (evítalos y saca otros): ${topics.join(', ')}`);
    if (memory.nextTopics.length) lines.push(`Ideas para conversar: ${memory.nextTopics.join('; ')}`);
    return lines.join('\n');
  }

  private nap(ms: number): Promise<void> {
    if (this.wakeRequested) {
      this.wakeRequested = false;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.wakeUp = null;
        self.wakeRequested = false;
        resolve();
      }
      this.wakeUp = done;
    });
  }

  private async loop(token: number): Promise<void> {
    while (token === this.loopToken) {
      if (document.hidden) {
        await this.nap(500);
        continue;
      }
      const now = performance.now();
      this.callTimes = this.callTimes.filter((t) => now - t < 60_000);
      if (this.callTimes.length >= MAX_CALLS_PER_MINUTE) {
        await this.nap(1000);
        continue;
      }
      const ok = await this.cycle(token);
      if (token !== this.loopToken) break;
      const elapsed = performance.now() - now;
      await this.nap(ok ? Math.max(0, MIN_CYCLE_MS - elapsed) : 5000);
    }
  }

  private async cycle(token: number | null): Promise<boolean> {
    if (this.busy) return true;
    this.busy = true;
    try {
      const askedAt = performance.now();
      this.callTimes.push(askedAt);
      let res: ChatResponse;
      this.hooks.thinking(true);
      try {
        res = await this.openai.chat({
          messages: [
            {
              role: 'system',
              content: systemPrompt(this.profile, this.backstory, this.memory.card, this.options.wishes),
            },
            { role: 'user', content: this.buildPrompt() },
          ],
          tools: this.options.wishes ? TOOLS : TOOLS.filter((t) => t.function.name !== 'wish'),
          tool_choice: 'required',
          parallel_tool_calls: false,
          temperature: 0.8,
          max_completion_tokens: 220,
        });
      } finally {
        this.hooks.thinking(false);
      }
      if (res.usage) this.hooks.usage(res.usage.prompt_tokens, res.usage.completion_tokens);
      if (token !== null && token !== this.loopToken) return true; // se pausó mientras pensaba

      const call = res.choices[0]?.message.tool_calls?.[0];
      if (!call) {
        this.remember('No elegiste ninguna acción.');
        return true;
      }
      // Le hablaron mientras pensaba otra cosa: mejor decidir de nuevo con la frase delante.
      if (this.lastHeardAt > askedAt && !SPEECH_TOOLS.has(call.function.name)) {
        this.wakeRequested = true;
        return true;
      }
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(call.function.arguments) as Record<string, unknown>;
      } catch {
        this.remember(`Los argumentos de ${call.function.name} no eran JSON válido.`);
        return true;
      }

      const reasoning = String(args['reasoning'] ?? '').trim();
      if (reasoning) {
        this.hooks.thought(reasoning);
        this.hooks.log('think', reasoning);
      }
      const label = describeAction(call.function.name, args);
      const speech = SPEECH_TOOLS.has(call.function.name) || call.function.name === 'say';
      if (!speech) this.hooks.log('action', label);

      if (speech && this.speechStreak >= SPEECH_STREAK_LIMIT) {
        const tired = 'Te has quedado sin saliva de tanto hablar: haz otra cosa antes de volver a hablar.';
        this.remember(`${label} → FALLO: ${tired}`);
        this.hooks.log('fail', tired);
        return true;
      }
      this.speechStreak = speech ? this.speechStreak + 1 : 0;

      const started = startAction(this.ctx, call.function.name, args);
      if (typeof started === 'string') {
        this.remember(`${label} → ERROR: ${started}`);
        this.hooks.log('fail', started);
        return true;
      }
      const wished = call.function.name === 'wish' || (speech && WishSystem.detect(String(args['text'] ?? '')));
      if (wished) this.lastWishAt = this.clock();
      const result = await this.ctx.agent.run(label, started.gen, started.priority);
      this.remember(`${label} → ${result.ok ? 'OK' : 'FALLO'}: ${result.message}`);
      // Las frases ya salen en el registro como conversación.
      if (!(result.ok && speech)) this.hooks.log(result.ok ? 'result' : 'fail', result.message);
      return true;
    } catch (e) {
      const dailyQuota = e instanceof OpenAiError && e.code === 'daily_quota';
      const message = dailyQuota
        ? `Se ha agotado la cuota diaria de ${this.openai.model}. Espera a que se renueve, activa la ` +
          'facturación en Google AI Studio o cambia de modelo o proveedor en environment.local.ts.'
        : e instanceof OpenAiError
          ? `API ${e.status}: ${e.message}`
          : `Error: ${String(e)}`;
      this.hooks.log('error', message);
      const fatal =
        e instanceof OpenAiError &&
        (dailyQuota ||
          e.status === 401 ||
          e.status === 403 ||
          e.code === 'insufficient_quota' ||
          /api key/i.test(e.message));
      if (fatal) {
        this.stop();
        this.hooks.fatal(message);
      }
      return false;
    } finally {
      this.busy = false;
    }
  }

  private buildPrompt(): string {
    const { agent, world, social, marvels } = this.ctx;
    const now = this.clock();
    const visible = this.getVisible();
    const visibleIds = new Set(visible.map((v) => v.entity.id));

    const remembered = [...agent.known.values()]
      .filter((k) => !visibleIds.has(k.id) && k.type !== 'character')
      .map((k) => ({ k, d: agent.distanceTo(k.position) }))
      .sort((a, b) => a.d - b.d);
    // De árboles y rocas basta con los más cercanos; lo demás se recuerda todo.
    const nearbyScenery = remembered.filter((r) => r.k.type === 'tree' || r.k.type === 'rock').slice(0, 4);
    const important = remembered.filter((r) => r.k.type !== 'tree' && r.k.type !== 'rock');

    const characters = social.others(agent).map((o) => {
      const affinity = Math.round(agent.getAffinity(o.id));
      const relation = { tu_afinidad: affinity, relacion: relationLabel(affinity) };
      const seen = visibleIds.has(o.id);
      const memory = agent.known.get(o.id);
      // Al alcance de un grito: se sabe aunque no le veas (como cuando oyes a alguien cerca).
      const puedes_gritarle = agent.distanceTo(o.position) <= SHOUT_DISTANCE;
      if (!seen && !memory) {
        return { id: o.id, nombre: o.name, donde: 'no sabes dónde está', puedes_gritarle, ...relation };
      }
      const d = agent.distanceTo(seen ? o.position : memory!.position);
      return {
        id: o.id,
        nombre: o.name,
        lo_ves: seen,
        distancia_m: round1(d),
        puedes_hablarle: d <= TALK_DISTANCE,
        puedes_gritarle,
        ...(seen
          ? {
              esta_haciendo: o.actionLabel ?? 'nada',
              lleva: o.holding?.id ?? null,
              ...(o.levitating && { flotando_en_el_aire: true }),
            }
          : { visto_hace_s: Math.round(now - memory!.lastSeen) }),
        ...relation,
      };
    });

    const chest = world.byType('chest').find((c) => agent.known.has(c.id));
    // Con una necesidad crítica se oculta la charla pendiente: los modelos pequeños
    // tienden a seguir conversando aunque se estén muriendo de sed.
    const critical =
      agent.thirst >= CRITICAL_NEED ? 'sed' : agent.hunger >= CRITICAL_NEED ? 'hambre' : null;
    const chatty = this.speechStreak >= SPEECH_STREAK_HINT;
    const pending = critical || chatty
      ? []
      : [...this.pendingReplies]
          .filter(([, at]) => now - at < 60)
          .map(([id, at]) => ({ id, nombre: social.agent(id)?.name ?? id, hace_s: Math.round(now - at) }));
    const observation = {
      ...(critical && { aviso_urgente: this.urgentHint(critical) }),
      ...(!critical &&
        chatty && {
          aviso: `Llevas ${this.speechStreak} frases seguidas sin hacer nada más. Ahora HAZ algo con el cuerpo ` +
            '(acércate, examina, toca, explora, come…) y luego retoma la charla.',
        }),
      tiempo_s: Math.round(now),
      yo: {
        posicion: [round1(agent.position.x), round1(agent.position.z)],
        hambre: Math.round(agent.hunger),
        sed: Math.round(agent.thirst),
        en_las_manos: agent.holding?.id ?? null,
        animo: agent.angry ? 'enfadado (de pelea)' : 'normal',
        ...(agent.powers.size && { poderes: [...agent.powers], flotando: agent.levitating }),
        ...(agent.powers.has('levitar') &&
          !agent.hasLevitated && {
            poder_sin_estrenar: '¡Aún no has probado a levitar! Hablar de ello no basta: usa levitate y vuela un poco.',
          }),
      },
      personajes: characters,
      debes_responder_a: pending,
      veo_ahora: visible
        .filter((v) => v.entity.type !== 'character')
        .map((v) => ({
          id: v.entity.id,
          tipo: TYPE_NAMES[v.entity.type],
          ...(v.entity.type === 'marvel' && { que_ves: marvels.describe(agent, v.entity.id) }),
          distancia_m: v.distance,
          direccion: v.direction,
          al_alcance: agent.distanceTo(v.entity.object.position) <= reach(v.entity),
        })),
      recuerdo: [...important, ...nearbyScenery].map(({ k, d }) => ({
        id: k.id,
        tipo: TYPE_NAMES[k.type],
        ...(k.type === 'marvel' && { que_es: marvels.describe(agent, k.id) }),
        posicion: [round1(k.position.x), round1(k.position.z)],
        distancia_m: round1(d),
        visto_hace_s: Math.round(now - k.lastSeen),
      })),
      cofre: chest ? { id: chest.id, manzanas_dentro: world.chestApples } : 'aún no lo has encontrado',
    };

    const memory = this.memoryBlock();
    return [
      memory ? `${memory}\n` : '',
      this.summary ? `Resumen de lo que ha pasado antes: ${this.summary}\n` : '',
      'Conversación reciente (del más antiguo al más reciente):',
      this.dialogue.join('\n') || '(nadie ha hablado todavía)',
      '',
      'Sucesos recientes (del más antiguo al más reciente):',
      this.events.join('\n') || '(ninguno todavía)',
      '',
      'Tu situación ahora mismo:',
      JSON.stringify(observation),
      '',
      this.reminder,
      // Al final del mensaje: los modelos pequeños hacen más caso a lo último que leen.
      this.options.wishes && !critical ? `🪄 ${this.wishHint(now)}` : '',
      'Elige tu siguiente acción.',
    ].join('\n');
  }

  /** Recordatorio de la magia de los deseos, para que la usen de verdad. */
  private wishHint(now: number): string {
    if (this.lastWishAt === null) {
      return 'Aún no has pedido ningún deseo. ¡Pruébalo con wish! Pide algo que de verdad quieras según tus gustos.';
    }
    const wait = Math.ceil(WISH_COOLDOWN - (now - this.lastWishAt));
    return wait > 0
      ? `La magia se está recargando (faltan ${wait} s para otro deseo).`
      : 'La magia se ha recargado: puedes pedir otro deseo si te apetece.';
  }

  /** Aviso concreto para una necesidad crítica: qué hacer exactamente. */
  private urgentHint(need: 'sed' | 'hambre'): string {
    const { agent, world } = this.ctx;
    const base = `Tu ${need} es crítica: deja la charla y resuélvelo YA.`;
    if (need === 'sed') {
      const pond = world.byType('pond').find((p) => agent.known.has(p.id));
      return pond ? `${base} Ya sabes dónde está ${pond.id}: walk_to("${pond.id}") y luego drink.` : `${base} Explora para encontrar agua.`;
    }
    if (agent.holding?.type === 'apple') return `${base} ¡Llevas ${agent.holding.id} en las manos: usa eat ahora!`;
    const apple = [...agent.known.values()]
      .filter((k) => k.type === 'apple')
      .sort((a, b) => agent.distanceTo(a.position) - agent.distanceTo(b.position))[0];
    return apple ? `${base} La manzana más cercana que conoces es ${apple.id}.` : `${base} Busca manzanas junto a los árboles.`;
  }

  /** Comprime los sucesos más antiguos en un resumen corto. */
  private async summarize(): Promise<void> {
    this.summarizing = true;
    const old = this.events.splice(0, SUMMARY_CHUNK);
    try {
      const res = await this.openai.chat({
        temperature: 0.3,
        max_completion_tokens: 220,
        messages: [
          {
            role: 'system',
            content:
              'Resume en primera persona y en máximo 90 palabras los recuerdos de un personaje. ' +
              'Conserva lo útil: dónde hay cosas (con ids), qué funcionó, qué falló y cómo van sus ' +
              'relaciones con los demás (discusiones, favores, promesas).',
          },
          {
            role: 'user',
            content: `Resumen anterior: ${this.summary || '(ninguno)'}\n\nSucesos nuevos:\n${old.join('\n')}`,
          },
        ],
      });
      if (res.usage) this.hooks.usage(res.usage.prompt_tokens, res.usage.completion_tokens);
      this.summary = res.choices[0]?.message.content?.trim() || this.summary;
    } catch {
      this.events.unshift(...old);
    } finally {
      this.summarizing = false;
    }
  }
}
