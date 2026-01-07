import { spawn } from 'node:child_process';

export type VrStereo = 'sbs' | 'tb' | 'mono';

export type VrProbe = {
  isVr: boolean;
  width: number | null;
  height: number | null;
  projection: string | null;
  fov: 180 | 360 | null;
  stereo: VrStereo | null;
  reason: string;
};

function lower(v: unknown): string {
  return String(v ?? '').toLowerCase();
}

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function stereoFromText(s: string): VrStereo | null {
  const t = s.toLowerCase();
  if (t.includes('top') && t.includes('bottom')) return 'tb';
  if (t.includes('bottom') && t.includes('top')) return 'tb';
  if (t.includes('left') && t.includes('right')) return 'sbs';
  if (t.includes('right') && t.includes('left')) return 'sbs';
  if (t.includes('mono')) return 'mono';
  return null;
}

function fovFromSphericalBounds(sd: any): 180 | 360 | null {
  const bl = asNum(sd?.bound_left);
  const br = asNum(sd?.bound_right);
  if (bl === null || br === null) return null;
  const span = br - bl;
  if (!Number.isFinite(span) || span <= 0) return null;
  // Best-effort: 180 content often carries cropped bounds (< ~0.75 of the sphere).
  if (span <= 0.75) return 180;
  return 360;
}

function fovFromDimensions(width: number, height: number): 180 | 360 | null {
  if (width <= 0 || height <= 0) return null;
  const ratio = width / height;

  // Be conservative to avoid misclassifying normal 16:9 video as VR.
  const near2to1 = ratio >= 1.95 && ratio <= 2.05;
  const near1to1 = ratio >= 0.95 && ratio <= 1.05;

  // Require fairly large frames to reduce false positives.
  if (near2to1 && width >= 3000 && height >= 1500) return 360;
  if (near1to1 && width >= 2500 && height >= 2500) return 180;
  return null;
}

export async function probeVrWithFfprobe(absPath: string): Promise<VrProbe | null> {
  const ffprobe = (process.env.FFPROBE_PATH || 'ffprobe').trim() || 'ffprobe';

  const args = ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', '-i', absPath];

  const out = await new Promise<string | null>((resolve) => {
    const child = spawn(ffprobe, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));

    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      if (!stdout.trim()) return resolve(null);
      resolve(stdout);
    });
  });

  if (!out) return null;

  let json: any;
  try {
    json = JSON.parse(out);
  } catch {
    return null;
  }

  const streams = Array.isArray(json?.streams) ? json.streams : [];
  const video = streams.find((s: any) => lower(s?.codec_type) === 'video') ?? null;
  if (!video) return null;

  const width = asNum(video?.width);
  const height = asNum(video?.height);
  const side = Array.isArray(video?.side_data_list) ? video.side_data_list : [];

  // Prefer explicit VR metadata if present.
  const spherical = side.find((sd: any) => lower(sd?.side_data_type).includes('spherical')) ?? null;
  const stereo3d = side.find((sd: any) => lower(sd?.side_data_type).includes('stereo')) ?? null;

  const projection = spherical ? (typeof spherical?.projection === 'string' ? spherical.projection : null) : null;

  let stereo: VrStereo | null = null;
  if (typeof video?.tags?.stereo_mode === 'string') stereo = stereoFromText(video.tags.stereo_mode) ?? stereo;
  if (!stereo && stereo3d) {
    stereo =
      stereoFromText(String(stereo3d?.type ?? '')) ??
      stereoFromText(String(stereo3d?.stereo_mode ?? '')) ??
      stereoFromText(JSON.stringify(stereo3d));
  }

  let fov: 180 | 360 | null = null;
  if (spherical) {
    fov = fovFromSphericalBounds(spherical);
  }

  if (!fov && typeof width === 'number' && typeof height === 'number') {
    fov = fovFromDimensions(width, height);
  }

  const isVr = Boolean(spherical) || Boolean(fov) || Boolean(stereo3d);

  const reason = spherical
    ? 'spherical-metadata'
    : stereo3d
      ? 'stereo3d-metadata'
      : fov
        ? 'dimension-heuristic'
        : 'unknown';

  return {
    isVr,
    width: typeof width === 'number' ? width : null,
    height: typeof height === 'number' ? height : null,
    projection,
    fov,
    stereo,
    reason,
  };
}
