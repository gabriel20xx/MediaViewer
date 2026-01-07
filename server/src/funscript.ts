import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { Funscript } from './types.js';

const ActionSchema = z.object({
  at: z.number().int().nonnegative(),
  pos: z.number().int().min(0).max(100),
});

const FunscriptSchema = z.object({
  version: z.string().optional(),
  inverted: z.boolean().optional(),
  range: z.number().optional(),
  actions: z.array(ActionSchema),
});

export function sidecarFunscriptPath(mediaAbsPath: string): string {
  const dir = path.dirname(mediaAbsPath);
  const base = path.basename(mediaAbsPath, path.extname(mediaAbsPath));
  return path.join(dir, `${base}.funscript`);
}

export async function loadFunscriptIfExists(mediaAbsPath: string): Promise<Funscript | null> {
  const funPath = sidecarFunscriptPath(mediaAbsPath);
  try {
    const raw = await fs.readFile(funPath, 'utf-8');
    const json = JSON.parse(raw);
    const parsed = FunscriptSchema.safeParse(json);
    if (!parsed.success) return null;
    const script = parsed.data;
    // Ensure sorted actions.
    script.actions.sort((a, b) => a.at - b.at);
    return script;
  } catch {
    return null;
  }
}
