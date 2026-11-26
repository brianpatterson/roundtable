// The personas module's public interface (ADR-0023): other modules and server.ts import from here,
// never from the files behind it. Owns the skill library and Personas; their documents come later
// (docs/roadmap.md). Another module checks a Skill id with `Skills.findOwned` and a Persona id with
// `Personas.findOwned` (ADR-0044). The App provides PersonasLive once.
import { Layer } from 'effect';
import { PersonasApiLive, SkillsApiLive } from './handlers.js';
import { Personas } from './personas.js';
import { Skills } from './skills.js';

export { Personas } from './personas.js';

export { Skills } from './skills.js';

/**
 * The skill library's and the Personas' endpoints, with the services behind them. The App
 * provides the Database and the Authorization middleware. A module that checks Skill or Persona
 * ids gets `Skills.layer` or `Personas.layer` from the App.
 */
export const PersonasLive = Layer.mergeAll(
  SkillsApiLive.pipe(Layer.provide(Skills.layer)),
  PersonasApiLive.pipe(Layer.provide(Personas.layer)),
);
