/**
 * Every corpus programme, in one registry.
 *
 * Order matters only for reporting: basic first, then cli, then complex.
 */
import type { Programme } from '../src/types.js';
import { basicProgrammes } from './basic.js';
import { cliProgrammes } from './cli.js';
import { complexProgrammes } from './complex.js';

export * from './basic.js';
export * from './cli.js';
export * from './complex.js';

export const allProgrammes: Programme[] = [
  ...basicProgrammes,
  ...cliProgrammes,
  ...complexProgrammes,
];

export const programmesByCategory: Record<'basic' | 'cli' | 'complex', Programme[]> = {
  basic: basicProgrammes,
  cli: cliProgrammes,
  complex: complexProgrammes,
};

export function findProgramme(id: string): Programme | undefined {
  return allProgrammes.find((p) => p.id === id);
}
