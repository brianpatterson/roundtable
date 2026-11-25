// The personas module's public interface (ADR-0023): the shell imports from here, never from the
// files behind it. So far the skill library (GLOSSARY.md): the Skills page, and the hook other
// modules read the Skills through rather than asking the API again.
export { SkillsPage } from './SkillsPage';

export { useSkills } from './queries';
