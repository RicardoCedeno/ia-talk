import { Component, computed, inject } from '@angular/core';
import { SimulationService } from '../simulation.service';

const MAX_LINES = 5;

/** Franja inferior con las últimas frases de la conversación, por si se escapa algún globo. */
@Component({
  selector: 'app-subtitles',
  template: `
    @if (sim.subtitles() && lines().length) {
      <ol>
        @for (line of lines(); track line.id; let i = $index; let n = $count) {
          <li [class]="'tone-' + (line.tone ?? 'neutral')" [style.opacity]="0.45 + (0.55 * (i + 1)) / n">
            <b [style.color]="line.color">{{ line.who }}</b> {{ line.text }}
          </li>
        }
      </ol>
    }
  `,
  styles: `
    :host {
      position: fixed;
      left: 380px;
      right: 16px;
      bottom: 16px;
      display: flex;
      justify-content: center;
      pointer-events: none;
    }
    ol {
      max-width: 760px;
      margin: 0;
      padding: 8px 14px;
      list-style: none;
      border-radius: 12px;
      background: rgba(18, 24, 32, 0.72);
      backdrop-filter: blur(6px);
      color: #f1f5f9;
      font-size: 14px;
      line-height: 1.4;
    }
    li {
      padding: 2px 0 2px 8px;
      border-left: 3px solid transparent;
      transition: opacity 0.3s;
    }
    .tone-amable {
      border-color: #8fd694;
    }
    .tone-molesto {
      border-color: #f6a35b;
    }
    .tone-hostil {
      border-color: #ff6b6b;
    }
    b {
      font-weight: 700;
    }
    /* En pantallas estrechas el panel ocupa casi todo el ancho: no hay sitio. */
    @media (max-width: 760px) {
      :host {
        display: none;
      }
    }
  `,
})
export class Subtitles {
  protected readonly sim = inject(SimulationService);

  /** Las últimas frases dichas, de la más antigua a la más reciente (el registro va al revés). */
  protected readonly lines = computed(() =>
    this.sim
      .log()
      .filter((e) => e.kind === 'talk')
      .slice(0, MAX_LINES)
      .reverse(),
  );
}
