// What GitHub answers, before `observe` parses it into the state's types. Every read names the path
// it failed at, so a part of the state that can't be read says what was missing.

/** A JSON value, as `JSON.parse` returns it. */
export type Json = string | number | boolean | null | readonly Json[] | JsonObject;

/** A JSON object. A key that isn't there reads as `undefined`. */
export interface JsonObject {
  readonly [key: string]: Json | undefined;
}

/** A value that isn't what the state needs, with where it was. */
export class Missing extends Error {
  override readonly name = 'Missing';
}

const isObject = (value: Json | undefined): value is JsonObject =>
  value instanceof Object && !Array.isArray(value);

const isList = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);

// Only a string equals its own String(); a number, an array or null never does.
const isText = (value: Json | undefined): value is string => String(value) === value;

const isNumber = (value: Json | undefined): value is number => Number(value) === value;

const isBoolean = (value: Json | undefined): value is boolean => value === true || value === false;

/** Parses JSON text. Throws `Missing` when it isn't JSON. */
export function parseJson(body: string, path: string): Json {
  try {
    const parsed: Json = JSON.parse(body);

    return parsed;
  } catch {
    throw new Missing(`${path} isn't JSON`);
  }
}

/** One value in a JSON document and its path, read into the types the state uses. */
export class Read {
  readonly value: Json | undefined;
  readonly path: string;

  constructor(value: Json | undefined, path: string) {
    this.value = value;
    this.path = path;
  }

  /** The value of `key`, if this is an object; a read of it fails otherwise. */
  field(key: string): Read {
    const path = `${this.path}.${key}`;

    return new Read(isObject(this.value) ? this.value[key] : undefined, path);
  }

  /** Whether the value is missing or `null`. */
  absent(): boolean {
    return this.value === undefined || this.value === null;
  }

  text(): string {
    if (isText(this.value)) return this.value;

    throw new Missing(`${this.path} is missing or not text`);
  }

  /** Text, or `null` when the value is missing or `null`. */
  optionalText(): string | null {
    return this.absent() ? null : this.text();
  }

  number(): number {
    if (isNumber(this.value)) return this.value;

    throw new Missing(`${this.path} is missing or not a number`);
  }

  boolean(): boolean {
    if (isBoolean(this.value)) return this.value;

    throw new Missing(`${this.path} is missing or not true or false`);
  }

  /** A timestamp, in milliseconds since the epoch. */
  time(): number {
    const parsed = Date.parse(this.text());

    if (Number.isNaN(parsed)) throw new Missing(`${this.path} is not a time`);

    return parsed;
  }

  /** A timestamp, or `null` when the value is missing or `null`. */
  optionalTime(): number | null {
    return this.absent() ? null : this.time();
  }

  items(): Read[] {
    const value = this.value;

    if (!isList(value)) throw new Missing(`${this.path} is missing or not a list`);

    return value.map((item, index) => new Read(item, `${this.path}[${index}]`));
  }

  /** The JSON value itself, which must be there. */
  json(): Json {
    if (this.value === undefined) throw new Missing(`${this.path} is missing`);

    return this.value;
  }
}
