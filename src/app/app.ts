import { afterNextRender, Component, DestroyRef, ElementRef, inject, viewChild } from '@angular/core';
import { SimulationService } from './simulation.service';
import { Hud } from './ui/hud';
import { Setup } from './ui/setup';
import { Subtitles } from './ui/subtitles';

@Component({
  selector: 'app-root',
  imports: [Hud, Setup, Subtitles],
  template: `
    <div class="viewport" #viewport></div>
    @if (sim.phase() === 'setup') {
      <app-setup />
    } @else {
      <app-hud />
      <app-subtitles />
    }
  `,
  styles: `
    .viewport {
      position: fixed;
      inset: 0;
    }
  `,
})
export class App {
  protected readonly sim = inject(SimulationService);
  private readonly viewport = viewChild.required<ElementRef<HTMLElement>>('viewport');

  constructor() {
    afterNextRender(() => this.sim.init(this.viewport().nativeElement));
    inject(DestroyRef).onDestroy(() => this.sim.destroy());
  }
}
