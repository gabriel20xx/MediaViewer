declare global {
  interface Window {
    mv: {
      listSerialPorts(): Promise<Array<{ path: string }>>;
      serialConnect(opts: { path: string; baudRate: number }): Promise<void>;
      serialDisconnect(): Promise<void>;
      tcodeSend(line: string): Promise<void>;
    };
  }
}

export {};
