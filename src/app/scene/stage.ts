import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';

const SKY = 0xa8d8f0;

/** Renderer, cámara, luces, suelo y bucle de render. No sabe nada del agente. */
export class Stage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
  readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  readonly labels = new CSS2DRenderer();
  readonly controls: OrbitControls;
  readonly ground: THREE.Mesh;

  /** Objetos que se pueden seleccionar con un clic. */
  pickables: THREE.Object3D[] = [];
  onClick?: (hit: THREE.Intersection) => void;

  private readonly raycaster = new THREE.Raycaster();
  private readonly resizeObserver = new ResizeObserver(() => this.fit());
  private pointerDown: { x: number; y: number } | null = null;
  private last = 0;

  constructor(private readonly host: HTMLElement) {
    const { renderer, scene, camera } = this;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    const labelsEl = this.labels.domElement;
    labelsEl.style.position = 'absolute';
    labelsEl.style.inset = '0';
    labelsEl.style.pointerEvents = 'none';
    host.append(renderer.domElement, labelsEl);

    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, 40, 90);

    camera.position.set(16, 15, 20);
    this.controls = new OrbitControls(camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 1.45;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 60;

    scene.add(new THREE.HemisphereLight(0xe3f3ff, 0x5d7a3a, 1.3));
    const sun = new THREE.DirectionalLight(0xfff4e0, 2.4);
    sun.position.set(15, 25, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -26, right: 26, top: 26, bottom: -26, near: 1, far: 70 });
    sun.shadow.normalBias = 0.03;
    scene.add(sun);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshStandardMaterial({ color: 0x7cb35a, roughness: 1 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    scene.add(this.ground, this.createGrass());

    renderer.domElement.addEventListener('pointerdown', this.handlePointerDown);
    renderer.domElement.addEventListener('pointerup', this.handlePointerUp);
    this.resizeObserver.observe(host);
    this.fit();
  }

  start(update: (dt: number) => void): void {
    this.last = performance.now();
    this.renderer.setAnimationLoop((now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      update(dt);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.labels.render(this.scene, this.camera);
    });
  }

  /** Desplaza suavemente cámara y objetivo para seguir un punto. */
  follow(target: THREE.Vector3, dt: number): void {
    const k = 1 - Math.exp(-3 * dt);
    const delta = new THREE.Vector3(
      (target.x - this.controls.target.x) * k,
      (0.8 - this.controls.target.y) * k,
      (target.z - this.controls.target.z) * k,
    );
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
    this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  private fit(): void {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private createGrass(): THREE.InstancedMesh {
    const count = 500;
    const grass = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.05, 0.28, 4),
      new THREE.MeshStandardMaterial({ color: 0x5f9a42, roughness: 1 }),
      count,
    );
    const m = new THREE.Matrix4();
    for (let i = 0; i < count; i++) {
      const s = 0.7 + Math.random() * 0.8;
      m.compose(
        new THREE.Vector3((Math.random() - 0.5) * 50, 0.13 * s, (Math.random() - 0.5) * 50),
        new THREE.Quaternion(),
        new THREE.Vector3(s, s, s),
      );
      grass.setMatrixAt(i, m);
    }
    grass.receiveShadow = true;
    return grass;
  }

  // Distingue un clic de un arrastre de cámara.
  private readonly handlePointerDown = (e: PointerEvent) => {
    this.pointerDown = { x: e.clientX, y: e.clientY };
  };

  private readonly handlePointerUp = (e: PointerEvent) => {
    const down = this.pointerDown;
    this.pointerDown = null;
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || !this.onClick) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, true)[0];
    if (hit) this.onClick(hit);
  };
}
