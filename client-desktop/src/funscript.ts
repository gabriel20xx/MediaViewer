import { z } from 'zod';

export type FunscriptAction = { at: number; pos: number };
export type Funscript = { actions: FunscriptAction[]; version?: string; inverted?: boolean; range?: number };

const ActionSchema = z.object({
  at: z.number().int().nonnegative(),
  pos: z.number().int().min(0).max(100)
});

const FunscriptSchema = z.object({
  version: z.string().optional(),
  inverted: z.boolean().optional(),
  range: z.number().optional(),
  actions: z.array(ActionSchema)
});

export function parseFunscript(json: unknown): Funscript {
  const parsed = FunscriptSchema.parse(json);
  parsed.actions.sort((a, b) => a.at - b.at);
  return parsed;
}

export function indexForTimeMs(actions: FunscriptAction[], timeMs: number): number {
  // Returns largest i such that actions[i].at <= timeMs, else -1
  let lo = 0;
  let hi = actions.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = actions[mid]!.at;
    if (at <= timeMs) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
