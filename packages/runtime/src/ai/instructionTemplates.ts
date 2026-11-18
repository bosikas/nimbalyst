import defaults from './instructions/defaults.json';

/** Parsed prompt sources. Substitutions are single-pass so inserted user text stays literal. */
export function instructionTemplate(key: keyof typeof defaults, values: readonly unknown[] = []): string {
  return defaults[key].replace(/\{\{(\d+)\}\}/g, (_match, index: string) => {
    const position = Number(index);
    if (position >= values.length) throw new Error(`Missing instruction value ${index} in ${key}`);
    return String(values[position]);
  });
}
