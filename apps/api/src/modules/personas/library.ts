import { and, asc, count, eq, ne, sql } from 'drizzle-orm';
import { Effect } from 'effect';
import { Database } from '../../platform/database/effect.js';
import { nameKey, personas, skills } from './schema.js';

/** A transaction on the Database, as `Database.transaction` hands it to its callback. */
export type Transaction = Parameters<Parameters<Database['Service']['transaction']>[0]>[0];

/** The Database, or a transaction on it: both read the same way. */
export type Reader = Database['Service'] | Transaction;

/** The tables that are a Library: they have the same columns, and the same name index. */
type LibraryTable = typeof skills | typeof personas;

/** An entry of a Library, as its table stores it: what the contract's Skill and Persona share. */
export interface LibraryItem {
  readonly id: string;
  readonly name: string;
  readonly archivedAt: Date | null;
  readonly createdAt: Date;
}

/** Renames an entry, archives it (`archived: true`) or restores it (`archived: false`), or both. */
export interface LibraryChanges {
  readonly name?: string | undefined;
  readonly archived?: boolean | undefined;
}

/** What makes a table a Library: everything that differs between Skills and Personas. */
export interface LibraryConfig<A, NotFound, NameTaken, TooMany> {
  readonly table: LibraryTable;
  /** The advisory lock every change takes for the user, so two at once can't both pass a rule. */
  readonly lock: 'skills' | 'personas';
  /** The most entries one user can have, archived ones included. */
  readonly max: number;
  /** Whether an id could be one of the table's: a malformed one would fail Postgres's uuid cast. */
  readonly isId: (id: string) => boolean;
  readonly errors: {
    readonly notFound: () => NotFound;
    readonly nameTaken: (archived: boolean) => NameTaken;
    readonly tooMany: () => TooMany;
  };
  /**
   * What the Library answers with for `items`, read through `reader` (inside the change's
   * transaction, under its lock, when there is one), in the same order: the entries themselves,
   * or more (a Persona's Skills).
   */
  readonly answer: (reader: Reader, items: readonly LibraryItem[]) => Effect.Effect<readonly A[]>;
}

/**
 * A Library (GLOSSARY.md): a user's named, archivable list. Every method is scoped to the user it's
 * given. A name is taken ignoring case and surrounding spaces, archived entries included; the
 * user's entries, archived ones included, are at most `max`; archiving an archived entry keeps
 * the date it was first archived; and another user's entry, or a malformed id, is the same
 * `notFound` as a missing one, so the API never confirms an id exists. Every change holds the
 * user's lock, so two requests at once can't both pass the limit or both take one name (which
 * would be a unique violation, a 500). Database failures are defects: a 500, reported.
 *
 * It needs the `Database`, which the layer of each instance (`Skills.layer`, `Personas.layer`)
 * passes on to where the App is assembled.
 */
const make = <A, NotFound, NameTaken, TooMany>(
  config: LibraryConfig<A, NotFound, NameTaken, TooMany>,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const { table, errors } = config;

    const columns = {
      id: table.id,
      name: table.name,
      archivedAt: table.archivedAt,
      createdAt: table.createdAt,
    };

    const ownedBy = (userId: string, id: string) => and(eq(table.id, id), eq(table.userId, userId));

    /** The answer for one entry: `config.answer` keeps one for each it's given. */
    const answerOne = (reader: Reader, item: LibraryItem) =>
      Effect.gen(function* () {
        const [answered] = yield* config.answer(reader, [item]);

        if (answered === undefined) return yield* Effect.die(new Error('an entry lost its answer'));

        return answered;
      });

    /** The user's entry `id`, answered, or `notFound`. */
    const read = (reader: Reader, userId: string, id: string) =>
      Effect.gen(function* () {
        const [item] = yield* reader
          .select(columns)
          .from(table)
          .where(ownedBy(userId, id))
          .pipe(Effect.orDie);

        if (!item) return yield* Effect.fail(errors.notFound());

        return yield* answerOne(reader, item);
      });

    /** A transaction that changes the user's entries, holding their lock. */
    const locked = <B, E>(userId: string, change: (tx: Transaction) => Effect.Effect<B, E>) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .execute(
                sql`select pg_advisory_xact_lock(hashtext(${config.lock}), hashtext(${userId}))`,
              )
              .pipe(Effect.orDie);

            return yield* change(tx);
          }),
        )
        .pipe(Effect.catchTag('SqlError', Effect.die));

    /**
     * Fails with `nameTaken` if the user has another entry (not `exceptId`) by `name`, compared the
     * way the unique index compares them.
     */
    const checkNameFree = (tx: Transaction, userId: string, name: string, exceptId?: string) =>
      Effect.gen(function* () {
        const [taken] = yield* tx
          .select({ archivedAt: table.archivedAt })
          .from(table)
          .where(
            and(
              eq(table.userId, userId),
              sql`${nameKey(table.name)} = ${nameKey(sql`${name}`)}`,
              exceptId === undefined ? undefined : ne(table.id, exceptId),
            ),
          )
          .pipe(Effect.orDie);

        if (taken) return yield* Effect.fail(errors.nameTaken(taken.archivedAt !== null));
      });

    /**
     * Runs `change` on the user's entry `id` under their lock, then answers with the entry as it
     * is after it. Another user's entry is `notFound`, before `change` runs.
     */
    const changing = <E>(
      userId: string,
      id: string,
      change: (tx: Transaction) => Effect.Effect<void, E>,
    ) =>
      locked(userId, (tx) =>
        Effect.gen(function* () {
          const [owned] = yield* tx
            .select({ id: table.id })
            .from(table)
            .where(ownedBy(userId, id))
            .pipe(Effect.orDie);

          if (!owned) return yield* Effect.fail(errors.notFound());

          yield* change(tx);

          return yield* read(tx, userId, id);
        }),
      );

    return {
      /** The user's entries, archived ones included, by name ignoring case. */
      list: Effect.fn('Library.list')(function* (userId: string) {
        const items = yield* db
          .select(columns)
          .from(table)
          .where(eq(table.userId, userId))
          .orderBy(asc(nameKey(table.name)), asc(table.id))
          .pipe(Effect.orDie);

        return yield* config.answer(db, items);
      }),

      /** Adds an entry named `name` (already trimmed by the contract). */
      create: Effect.fn('Library.create')(function* (userId: string, name: string) {
        return yield* locked(userId, (tx) =>
          Effect.gen(function* () {
            yield* checkNameFree(tx, userId, name);

            const [owned] = yield* tx
              .select({ count: count() })
              .from(table)
              .where(eq(table.userId, userId))
              .pipe(Effect.orDie);

            // Archived entries count: they're never deleted, so they'd otherwise grow without bound.
            if ((owned?.count ?? 0) >= config.max) return yield* Effect.fail(errors.tooMany());

            const [created] = yield* tx
              .insert(table)
              .values({ userId, name })
              .returning(columns)
              .pipe(Effect.orDie);

            if (!created) return yield* Effect.die(new Error('insert returned no row'));

            return yield* answerOne(tx, created);
          }),
        );
      }),

      /** Renames, archives or restores the user's entry `id`. */
      update: Effect.fn('Library.update')(function* (
        userId: string,
        id: string,
        changes: LibraryChanges,
      ) {
        return yield* changing(userId, id, (tx) =>
          Effect.gen(function* () {
            // Its own name in another case isn't taken: that's a rename to the same entry.
            if (changes.name !== undefined) yield* checkNameFree(tx, userId, changes.name, id);

            yield* tx
              .update(table)
              .set({
                ...(changes.name !== undefined && { name: changes.name }),
                // Archiving an archived entry keeps the date it was first archived.
                ...(changes.archived !== undefined && {
                  archivedAt: changes.archived ? sql`coalesce(${table.archivedAt}, now())` : null,
                }),
              })
              .where(ownedBy(userId, id))
              .pipe(Effect.orDie);
          }),
        );
      }),

      /**
       * The user's entry `id`, archived or not: for another module that takes its id, before it
       * stores it. Any id that isn't one of the user's, a malformed one included, is `notFound`.
       */
      findOwned: Effect.fn('Library.findOwned')(function* (userId: string, id: string) {
        if (!config.isId(id)) return yield* Effect.fail(errors.notFound());

        return yield* read(db, userId, id);
      }),

      /**
       * Changes what hangs off the user's entry `id` (a Persona's Skills) under the Library's lock,
       * then answers with it: for the module's own instance, never another module's.
       */
      changing,
    };
  });

/** Builds a Library: `Library.make(config)`, inside an instance's layer. */
export const Library = { make };
