// The personas module's public interface (ADR-0023): other modules and server.ts import from here,
// never from the files behind it. Owns the skill library so far; Personas and their documents come
// later (docs/roadmap.md). Another module checks a Skill id with `Skills.findOwned` (ADR-0044).
// The App provides PersonasLive once.
import { Layer } from 'effect';
import { SkillsApiLive } from './handlers.js';
import { Skills } from './skills.js';

export { Skills } from './skills.js';

/**
 * The skill library's endpoints, with the Skills service behind them. The App provides the
 * Database and the Authorization middleware. A module that checks Skill ids gets `Skills.layer`
 * from the App.
 */
export const PersonasLive = SkillsApiLive.pipe(Layer.provide(Skills.layer));
