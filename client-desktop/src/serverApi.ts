import fetch from 'node-fetch';
import { parseFunscript, type Funscript } from './funscript.js';

export type MediaListItem = {
  id: string;
  filename: string;
  relPath: string;
  mediaType: 'video' | 'image' | 'other' | string;
  hasFunscript: boolean;
};

export type MediaListResponse = {
  total: number;
  page: number;
  pageSize: number;
  items: MediaListItem[];
};

export async function getMediaList(serverUrl: string, q: string, page: number, pageSize: number): Promise<MediaListResponse> {
  const url = new URL('/api/media', serverUrl);
  url.searchParams.set('q', q);
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as MediaListResponse;
}

export async function getFunscript(serverUrl: string, mediaId: string): Promise<Funscript> {
  const url = new URL(`/api/media/${mediaId}/funscript`, serverUrl);
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(await res.text());
  const json = await res.json();
  return parseFunscript(json);
}

export async function putPlayback(serverUrl: string, body: {
  clientId: string;
  mediaId: string;
  timeMs: number;
  fps: number;
  frame: number;
}): Promise<void> {
  const url = new URL('/api/playback', serverUrl);
  const res = await fetch(url.toString(), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await res.text());
}
