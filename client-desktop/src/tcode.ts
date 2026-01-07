export type TCodeOptions = {
  axis?: string; // e.g. "L0"
};

export function funscriptPosToTCode(pos0to100: number, opts?: TCodeOptions): string {
  const axis = (opts?.axis ?? 'L0').toUpperCase();
  const clamped = Math.max(0, Math.min(100, Math.round(pos0to100)));
  const scaled = Math.round((clamped / 100) * 999);
  const v = String(scaled).padStart(3, '0');
  return `${axis}${v}`;
}
