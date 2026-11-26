// The personas module's public interface (ADR-0023): the shell imports from here, never from the
// files behind it. The skill library and Personas (GLOSSARY.md): their pages, and the hooks other
// modules read Skills and Personas through rather than asking the API again.
export { PersonaPage } from './PersonaPage';

export { PersonasPage } from './PersonasPage';

export { SkillsPage } from './SkillsPage';

export { usePersonas, useSkills } from './queries';
