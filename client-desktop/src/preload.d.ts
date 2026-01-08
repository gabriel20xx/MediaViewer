declare global {
  interface Window {
    mv: {
      listSerialPorts(): Promise<Array<{ path: string }>>;
      serialConnect(opts: { path: string; baudRate: number }): Promise<void>;
      serialDisconnect(): Promise<void>;
      tcodeSend(line: string): Promise<void>;
      setKeepAwake(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }>;
      allowInsecureCertForUrl(url: string): Promise<{ ok: boolean; host?: string; skipped?: boolean; error?: string }>;

      // DeoVR Remote Control (TCP 23554)
      deoVrConnect(host: string): Promise<{ ok: boolean; host?: string; error?: string }>;
      deoVrDisconnect(): void;
      deoVrSend(data: any): void;
      deoVrGetConnectionInfo(): { ok: boolean; host?: string };
      deoVrOnStatus(handler: (s: {
        path?: string;
        duration?: number;
        currentTime?: number;
        playbackSpeed?: number;
        playerState?: number;
      }) => void): () => void;
      deoVrOnConnection(handler: (e: { type: 'connected' | 'disconnected' | 'error'; host?: string; error?: string }) => void): () => void;
    };
  }
}

export {};
