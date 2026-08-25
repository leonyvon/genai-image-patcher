// services/bridgeClient.ts — 浏览器侧桥接 WS 客户端。
// 负责连接/重连、命令请求-响应、状态快照推送。
export interface BridgeRegionInfo {
  id: string;
  status: string;
  x: number; y: number; width: number; height: number;
  customPrompt: string | null;
  errorMessage: string | null;
  hasResult: boolean;
  fullRedraw: boolean;
}

export interface BridgeImageInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  isReference: boolean;
  referenceOrder: number | null;
  hasResult: boolean;
  regions: BridgeRegionInfo[];
}

export interface BridgeStateSnapshot {
  processingState: string;
  selectedImageId: string | null;
  generationSeq: number;
  updatedAt: number;
  images: BridgeImageInfo[];
  config: {
    provider: string;
    model: string;
    prompt: string;
    processingMode: string;
    referenceCount: number;
  };
}

export interface BridgeOutcome {
  ok: boolean;
  result?: any;
  error?: string;
}

type CommandHandler = (action: string, params: any) => Promise<any>;

export class BridgeClient {
  private ws: WebSocket | null = null;
  private url: string;
  private commandHandler: CommandHandler | null = null;
  private connectionHandler: ((connected: boolean) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  connected = false;

  constructor(url: string) {
    this.url = url;
  }

  setCommandHandler(h: CommandHandler) {
    this.commandHandler = h;
  }

  setConnectionHandler(h: (connected: boolean) => void) {
    this.connectionHandler = h;
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.connectionHandler?.(true);
    };

    ws.onmessage = async (ev) => {
      let msg: any;
      try { msg = JSON.parse(ev.data as string); } catch { return; }
      if (msg.type !== 'command') return;
      let outcome: BridgeOutcome;
      try {
        const result = this.commandHandler ? await this.commandHandler(msg.action, msg.params ?? {}) : { error: 'no handler' };
        outcome = result && typeof result === 'object' && 'ok' in result
          ? result as BridgeOutcome
          : result && typeof result === 'object' && 'error' in result
            ? { ok: false, error: (result as any).error }
            : { ok: true, result };
      } catch (e) {
        outcome = { ok: false, error: (e as Error).message || String(e) };
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'result', id: msg.id, ...outcome }));
      }
    };

    ws.onclose = () => {
      this.connected = false;
      this.connectionHandler?.(false);
      if (!this.closed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    };

    ws.onerror = () => { /* close follows */ };
  }

  sendState(snapshot: BridgeStateSnapshot) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'state', snapshot }));
    }
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
