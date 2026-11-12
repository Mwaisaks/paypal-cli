import { z } from 'zod';

/** Strips optional/default/effects wrappers to find the base zod type. */
export function baseType(t: z.ZodTypeAny): z.ZodTypeAny {
  let cur: z.ZodTypeAny = t;
  for (;;) {
    if (cur instanceof z.ZodOptional || cur instanceof z.ZodNullable) cur = cur._def.innerType;
    else if (cur instanceof z.ZodDefault) cur = cur._def.innerType;
    else if (cur instanceof z.ZodEffects) cur = cur._def.schema;
    else return cur;
  }
}

export const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

/** Converts raw commander values (strings) into what the zod schema expects, then validates. */
export function parseInput(shape: z.ZodRawShape, raw: Record<string, unknown>): Record<string, unknown> {
  const prepared: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(shape)) {
    const v = raw[key];
    if (v === undefined) continue;
    const b = baseType(schema as z.ZodTypeAny);
    if (b instanceof z.ZodArray && typeof v === 'string') {
      prepared[key] = v.split(',').map((s) => s.trim()).filter(Boolean);
    } else {
      prepared[key] = v;
    }
  }
  const res = z.object(shape).strict().safeParse(prepared);
  if (!res.success) {
    const msg = res.error.issues
      .map((i) => `--${kebab(String(i.path[0] ?? ''))}: ${i.message}`)
      .join('\n');
    throw new InputError(msg);
  }
  return res.data;
}

export class InputError extends Error {}
