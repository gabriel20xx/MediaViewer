export type MediaType = 'video' | 'image' | 'other';

export type MediaListItem = {
  id: string;
  filename: string;
  relPath: string;
  mediaType: MediaType;
  hasFunscript: boolean;
  sizeBytes: string;
  modifiedMs: string;
};

export type FunscriptAction = {
  at: number; // ms
  pos: number; // 0-100
};

export type Funscript = {
  version?: string;
  inverted?: boolean;
  range?: number;
  actions: FunscriptAction[];
};
