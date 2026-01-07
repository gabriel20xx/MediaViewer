declare global {
  interface Window {
    mv: {
      listSerialPorts(): Promise<Array<{ path: string }>>;
      serialConnect(opts: { path: string; baudRate: number }): Promise<void>;
      serialDisconnect(): Promise<void>;
      tcodeSend(line: string): Promise<void>;
      setKeepAwake(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }>;
      allowInsecureCertForUrl(url: string): Promise<{ ok: boolean; host?: string; skipped?: boolean; error?: string }>;
    };
  }
}

export {};
