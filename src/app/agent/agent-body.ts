import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

export type AnimName = 'idle' | 'walk' | 'pickup' | 'eat' | 'drink' | 'talk' | 'shout' | 'look';

/** Duración (s) de las animaciones que se reproducen una sola vez. */
export const ANIM_DURATION = { pickup: 1.1, eat: 2.2, drink: 2.6 } as const;

interface Pose {
  legL: number;
  legR: number;
  armL: number;
  armR: number;
  spread: number;
  bend: number;
  headX: number;
  headY: number;
  bob: number;
}

const shared = {
  eye: new THREE.MeshStandardMaterial({ color: 0x1d1d1d, roughness: 0.3 }),
  antenna: new THREE.MeshStandardMaterial({ color: 0x7ad3ff, emissive: 0x2a8fd0, emissiveIntensity: 0.6 }),
};

/** Sube a 1 en `ramp` segundos, se mantiene y baja a 0 al final de `duration`. */
const envelope = (t: number, duration: number, ramp: number) =>
  THREE.MathUtils.clamp(Math.min(t, duration - t) / ramp, 0, 1);

/**
 * Cuerpo del personaje hecho con primitivas y animado de forma procedural.
 * Mira hacia +Z en su espacio local.
 */
export class AgentBody {
  readonly root = new THREE.Group();
  /** Punto donde se coloca lo que lleva en las manos. */
  readonly holdAnchor = new THREE.Group();
  carrying = false;
  /** Enfadado: brazos cruzados, cara roja y 💢 junto al nombre. */
  angry = false;
  /** 0..1: velocidad relativa al caminar, ajusta el ritmo de los pasos. */
  stride = 1;
  /** Altura (m) a la que quiere flotar; 0 = en el suelo. */
  hoverTarget = 0;

  private readonly mats: Record<'body' | 'limb' | 'skin', THREE.MeshStandardMaterial>;
  private readonly rig = new THREE.Group();
  private readonly upper = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly bubbleEl = document.createElement('div');
  private readonly bubble = new CSS2DObject(this.bubbleEl);
  private readonly nameEl = document.createElement('div');
  private readonly nameTag = new CSS2DObject(this.nameEl);
  private readonly aura: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  private hover = 0;
  private shownAngry = false;
  private bubbleTime = 0;
  private anim: AnimName = 'idle';
  private animTime = 0;
  private time = Math.random() * 10;
  private walkPhase = 0;

  constructor(
    color: string,
    private readonly name: string,
    options: { skin?: string; roughness?: number } = {},
  ) {
    const base = new THREE.Color(color);
    const roughness = options.roughness ?? 0.6;
    this.mats = {
      body: new THREE.MeshStandardMaterial({ color: base, roughness }),
      limb: new THREE.MeshStandardMaterial({ color: base.clone().offsetHSL(0, 0, -0.12), roughness }),
      skin: new THREE.MeshStandardMaterial({ color: options.skin ?? 0xffd6a5, roughness, emissiveIntensity: 0.3 }),
    };
    this.legL = this.limb(0.11, 0.78);
    this.legR = this.limb(0.11, 0.78);
    this.armL = this.limb(0.08, 0.62, true);
    this.armR = this.limb(0.08, 0.62, true);

    this.root.add(this.rig);
    this.legL.position.set(0.15, 0.8, 0);
    this.legR.position.set(-0.15, 0.8, 0);
    this.upper.position.y = 0.8;
    this.rig.add(this.legL, this.legR, this.upper);

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.45, 6, 14), this.mats.body);
    torso.position.y = 0.45;
    this.armL.position.set(0.42, 0.78, 0);
    this.armR.position.set(-0.42, 0.78, 0);
    this.head.position.y = 1;
    this.holdAnchor.position.set(0, 0.5, 0.55);
    this.upper.add(torso, this.armL, this.armR, this.head, this.holdAnchor);

    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.27, 20, 14), this.mats.skin);
    skull.position.y = 0.25;
    const eyeGeo = new THREE.SphereGeometry(0.045, 10, 8);
    const eyeL = new THREE.Mesh(eyeGeo, shared.eye);
    eyeL.position.set(0.1, 0.3, 0.245);
    const eyeR = eyeL.clone();
    eyeR.position.x = -0.1;
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.25), this.mats.limb);
    stalk.position.y = 0.6;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), shared.antenna);
    ball.position.y = 0.74;
    this.head.add(skull, eyeL, eyeR, stalk, ball);

    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });

    // Anillo de luz bajo los pies mientras levita.
    this.aura = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.035, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0xc9a6ff, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.aura.rotation.x = Math.PI / 2;
    this.aura.position.y = 0.02;
    this.aura.visible = false;
    this.rig.add(this.aura);

    this.nameEl.className = 'name-tag';
    this.nameEl.textContent = name;
    this.nameEl.style.setProperty('--c', color);
    this.nameTag.position.y = 2.6;
    this.nameTag.center.set(0.5, 1);
    this.root.add(this.nameTag);

    this.bubbleEl.className = 'bubble';
    this.bubble.position.y = 3;
    this.bubble.center.set(0.5, 1);
    this.bubble.visible = false;
    this.root.add(this.bubble);
  }

  get animation(): AnimName {
    return this.anim;
  }

  /** Altura actual de levitación (m), ya suavizada. */
  get hoverHeight(): number {
    return this.hover;
  }

  setAnim(anim: AnimName, restart = false): void {
    if (restart || anim !== this.anim) {
      this.anim = anim;
      this.animTime = 0;
    }
  }

  speak(text: string, seconds: number, tone = 'neutral', shout = false): void {
    this.bubbleEl.textContent = text;
    this.bubbleEl.className = `bubble tone-${tone}${shout ? ' shout' : ''}`;
    this.bubble.visible = true;
    this.bubbleTime = seconds;
  }

  setThinking(on: boolean): void {
    if (this.bubbleTime > 0) return; // no tapar lo que está diciendo
    if (on) {
      this.bubbleEl.textContent = '•••';
      this.bubbleEl.className = 'bubble thinking';
      this.bubble.visible = true;
    } else if (this.bubbleEl.classList.contains('thinking')) {
      this.bubble.visible = false;
    }
  }

  setNameVisible(visible: boolean): void {
    this.nameTag.visible = visible;
  }

  hideBubble(): void {
    this.bubbleTime = 0;
    this.bubble.visible = false;
  }

  /** Quita las etiquetas HTML y libera geometrías y materiales propios. */
  dispose(): void {
    this.bubble.removeFromParent();
    this.nameTag.removeFromParent();
    this.root.removeFromParent();
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose();
    });
    Object.values(this.mats).forEach((m) => m.dispose());
    this.aura.material.dispose();
  }

  update(dt: number): void {
    this.time += dt;
    this.animTime += dt;
    if (this.bubbleTime > 0) {
      this.bubbleTime -= dt;
      if (this.bubbleTime <= 0) this.bubble.visible = false;
    }
    if (this.angry !== this.shownAngry) {
      this.shownAngry = this.angry;
      this.nameEl.textContent = this.angry ? `${this.name} 💢` : this.name;
      this.mats.skin.emissive.setHex(this.angry ? 0xff2200 : 0x000000);
    }

    const t = this.time;
    const angry = this.angry;
    this.hover += (this.hoverTarget - this.hover) * (1 - Math.exp(-3 * dt));
    const floating = this.hover > 0.3;
    const p: Pose = { legL: 0, legR: 0, armL: 0, armR: 0, spread: 0.08, bend: 0, headX: 0, headY: 0, bob: 0 };

    switch (this.anim) {
      case 'idle':
        if (floating) {
          // Flotando: piernas colgando, brazos abiertos, vaivén suave.
          p.legL = p.legR = 0.25;
          p.armL = p.armR = 0.1;
          p.spread = angry ? -0.8 : 0.55;
          if (angry) p.armL = p.armR = -1.35;
          p.bob = Math.sin(t * 1.6) * 0.07;
        } else if (angry) {
          // Brazos cruzados y cabeza gacha.
          p.armL = p.armR = -1.35;
          p.spread = -0.8;
          p.headX = 0.15;
          p.bob = Math.sin(t * 3) * 0.01;
        } else {
          p.bob = Math.sin(t * 2) * 0.015;
          p.armL = p.armR = Math.sin(t * 2) * 0.04;
          p.headY = Math.sin(t * 0.5) * 0.2;
        }
        break;
      case 'walk': {
        if (floating) {
          // Vuela como un superhéroe: inclinado hacia delante, brazos atrás.
          p.legL = p.legR = 0.35;
          p.armL = p.armR = 0.5;
          p.spread = 0.2;
          p.bend = 0.3;
          p.bob = Math.sin(t * 2) * 0.05;
          break;
        }
        this.walkPhase += dt * 9 * Math.max(0.3, this.stride);
        const s = Math.sin(this.walkPhase);
        const swing = angry ? 1.3 : 1; // pisotones
        p.legL = s * 0.6 * swing;
        p.legR = -s * 0.6 * swing;
        p.armL = -s * 0.5 * swing;
        p.armR = s * 0.5 * swing;
        p.bob = Math.abs(Math.cos(this.walkPhase)) * 0.06 * swing;
        p.bend = angry ? 0.18 : 0.08;
        break;
      }
      case 'pickup': {
        const k = envelope(this.animTime, ANIM_DURATION.pickup, 0.4);
        p.bend = 1 * k;
        p.armL = p.armR = -1.2 * k;
        p.legL = p.legR = -0.25 * k;
        p.headX = 0.3 * k;
        p.bob = -0.12 * k;
        break;
      }
      case 'eat':
        p.armR = -2.3 + Math.sin(t * 10) * 0.15;
        p.armL = -1.1;
        p.headX = 0.15 + Math.sin(t * 10) * 0.08;
        break;
      case 'drink': {
        const k = envelope(this.animTime, ANIM_DURATION.drink, 0.5);
        p.bend = 1.1 * k;
        p.armL = p.armR = -1.4 * k;
        p.legL = p.legR = -0.3 * k;
        p.headX = 0.4 * k + Math.sin(t * 6) * 0.05 * k;
        p.bob = -0.15 * k;
        break;
      }
      case 'talk':
        if (angry) {
          // Señala con el dedo y niega con la cabeza.
          p.armR = -1.5 + Math.sin(t * 8) * 0.25;
          p.armL = -0.2;
          p.headY = Math.sin(t * 9) * 0.15;
        } else {
          p.headX = Math.sin(t * 7) * 0.12;
          p.armR = -0.7 + Math.sin(t * 5) * 0.35;
          p.spread = 0.25;
        }
        p.bob = Math.sin(t * 2) * 0.015;
        break;
      case 'shout':
        if (angry) {
          // Agita el puño en alto.
          p.armR = -2.7 + Math.sin(t * 12) * 0.2;
          p.armL = -0.3;
          p.spread = 0.15;
        } else {
          // Manos a la boca, como un altavoz.
          p.armL = p.armR = -2.1;
          p.spread = -0.45;
        }
        p.headX = -0.25 + Math.sin(t * 6) * 0.05;
        p.bend = -0.08;
        p.bob = Math.abs(Math.sin(t * 6)) * 0.03;
        break;
      case 'look':
        p.headY = Math.sin(t * 2.2) * 0.8;
        break;
    }

    if (this.carrying && this.anim !== 'eat' && this.anim !== 'pickup' && this.anim !== 'drink') {
      p.armL = p.armR = -1.1;
      p.spread = 0.02;
    }

    const k = 1 - Math.exp(-14 * dt);
    const lerp = (from: number, to: number) => from + (to - from) * k;
    this.legL.rotation.x = lerp(this.legL.rotation.x, p.legL);
    this.legR.rotation.x = lerp(this.legR.rotation.x, p.legR);
    this.armL.rotation.x = lerp(this.armL.rotation.x, p.armL);
    this.armR.rotation.x = lerp(this.armR.rotation.x, p.armR);
    this.armL.rotation.z = lerp(this.armL.rotation.z, p.spread);
    this.armR.rotation.z = lerp(this.armR.rotation.z, -p.spread);
    this.upper.rotation.x = lerp(this.upper.rotation.x, p.bend);
    this.head.rotation.x = lerp(this.head.rotation.x, p.headX);
    this.head.rotation.y = lerp(this.head.rotation.y, p.headY);
    this.rig.position.y = lerp(this.rig.position.y, p.bob + this.hover);

    this.nameTag.position.y = 2.6 + this.hover;
    this.bubble.position.y = 3 + this.hover;
    this.aura.visible = this.hover > 0.05;
    this.aura.material.opacity = Math.min(0.8, this.hover) * (0.75 + Math.sin(t * 4) * 0.25);
    this.aura.rotation.z += dt * 1.5;
  }

  /** Extremidad que cuelga de un pivote (hombro o cadera). */
  private limb(radius: number, length: number, hand = false): THREE.Group {
    const pivot = new THREE.Group();
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length - radius * 2, 4, 10), this.mats.limb);
    m.position.y = -length / 2;
    pivot.add(m);
    if (hand) {
      const h = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.25, 10, 8), this.mats.skin);
      h.position.y = -length;
      pivot.add(h);
    }
    return pivot;
  }
}
