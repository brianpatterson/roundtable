import type { Persona } from '@roundtable/contract';

// What the new-application form and the application page share for picking an Application's
// Persona (GLOSSARY.md): its options and what the API is sent. Personas come from `usePersonas()`.

/** The Persona picker's value for "None": never a Persona's id, which is a UUID. */
export const NO_PERSONA = 'none';

/** A Persona's name as an Application shows it, marked when it's archived. */
const personaLabel = (persona: Persona) =>
  persona.archivedAt === null ? persona.name : `${persona.name} (archived)`;

/**
 * The Persona picker's options: "None", then the active Personas in the order `usePersonas()`
 * gives them (by name). `keep` is the Persona an Application already has, which stays selectable
 * if it's archived.
 */
export const personaOptions = (personas: readonly Persona[], keep: string | null = null) => [
  { value: NO_PERSONA, label: 'None' },
  ...personas.flatMap((persona) =>
    persona.archivedAt === null || persona.id === keep
      ? [{ value: persona.id, label: personaLabel(persona) }]
      : [],
  ),
];

/** The picker's value for an Application's `personaId`. */
export const personaChoice = (personaId: string | null) => personaId ?? NO_PERSONA;

/** What the API is sent for a picked option: a Persona's id, or null for "None". */
export const personaIdOf = (choice: string) => (choice === NO_PERSONA ? null : choice);
