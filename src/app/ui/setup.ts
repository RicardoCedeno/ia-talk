import { Component, computed, inject, signal } from '@angular/core';
import {
  CharacterProfile,
  NAME_MAX,
  PERSONALITY_MAX,
  PREFERENCES_MAX,
  PRESETS,
  SimulationSetup,
  slugify,
  STARTING_RELATIONS,
  StartingRelation,
} from '../agent/profile';
import { LongTermMemory } from '../agent/memory';
import { SimulationService } from '../simulation.service';

type Field = keyof CharacterProfile;

/** Pantalla inicial: personalidad y gustos de cada personaje antes de empezar. */
@Component({
  selector: 'app-setup',
  templateUrl: './setup.html',
  styleUrl: './setup.scss',
})
export class Setup {
  protected readonly sim = inject(SimulationService);
  protected readonly presets = PRESETS;
  protected readonly relations = STARTING_RELATIONS;
  protected readonly limits = { name: NAME_MAX, personality: PERSONALITY_MAX, preferences: PREFERENCES_MAX };

  protected readonly draft = signal<SimulationSetup>(structuredClone(this.sim.setup()));
  /** Se incrementa al borrar recuerdos para recalcular los contadores. */
  private readonly memoryVersion = signal(0);

  /** Recuerdos guardados de partidas anteriores para cada personaje (por nombre). */
  protected readonly storedMemories = computed(() => {
    this.memoryVersion();
    return this.draft().characters.map((c) => LongTermMemory.storedCount(slugify(c.name, new Set())));
  });

  protected setKeepMemories(value: boolean): void {
    this.draft.update((d) => ({ ...d, keepMemories: value }));
  }

  protected setWishes(value: boolean): void {
    this.draft.update((d) => ({ ...d, wishes: value }));
  }

  protected setMarvels(value: boolean): void {
    this.draft.update((d) => ({ ...d, marvels: value }));
  }

  protected clearMemories(): void {
    LongTermMemory.clearAll();
    this.memoryVersion.update((v) => v + 1);
  }

  protected readonly error = computed(() => {
    const names = this.draft().characters.map((c) => c.name.trim());
    if (names.some((n) => !n)) return 'Cada personaje necesita un nombre.';
    const ids = new Set(names.map((n) => slugify(n, new Set())));
    if (ids.size < names.length) return 'Los nombres tienen que ser distintos.';
    return null;
  });

  protected update(index: number, field: Field, value: string): void {
    this.draft.update((d) => ({
      ...d,
      characters: d.characters.map((c, i) => (i === index ? { ...c, [field]: value } : c)),
    }));
  }

  protected applyPreset(index: number, preset: CharacterProfile): void {
    this.draft.update((d) => ({
      ...d,
      characters: d.characters.map((c, i) => (i === index ? { ...preset } : c)),
    }));
  }

  protected setRelation(value: string): void {
    this.draft.update((d) => ({ ...d, relation: value as StartingRelation }));
  }

  protected start(): void {
    if (this.error()) return;
    const d = this.draft();
    void this.sim.start({
      relation: d.relation,
      keepMemories: d.keepMemories !== false,
      marvels: !!d.marvels,
      wishes: d.wishes !== false,
      characters: d.characters.map((c) => ({
        name: c.name.trim(),
        color: c.color,
        personality: c.personality.trim(),
        preferences: c.preferences.trim(),
      })),
    });
  }
}
