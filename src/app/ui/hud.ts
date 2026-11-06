import { DecimalPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { SimulationService } from '../simulation.service';

@Component({
  selector: 'app-hud',
  imports: [DecimalPipe],
  templateUrl: './hud.html',
  styleUrl: './hud.scss',
})
export class Hud {
  protected readonly sim = inject(SimulationService);
}
