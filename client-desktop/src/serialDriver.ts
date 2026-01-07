import { SerialPort } from 'serialport';

export type SerialConnectionOptions = {
  path: string;
  baudRate: number;
};

export class SerialTCodeDriver {
  private port: SerialPort | null = null;

  async connect(opts: SerialConnectionOptions): Promise<void> {
    await this.disconnect();
    this.port = new SerialPort({ path: opts.path, baudRate: opts.baudRate, autoOpen: false });
    await new Promise<void>((resolve, reject) => {
      this.port!.open((err) => (err ? reject(err) : resolve()));
    });
  }

  async disconnect(): Promise<void> {
    if (!this.port) return;
    const p = this.port;
    this.port = null;
    await new Promise<void>((resolve) => {
      if (!p.isOpen) return resolve();
      p.close(() => resolve());
    });
  }

  sendLine(line: string): void {
    if (!this.port || !this.port.isOpen) return;
    const msg = line.endsWith('\n') ? line : `${line}\n`;
    this.port.write(msg);
  }
}
