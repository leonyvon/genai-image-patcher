// hooks/useBridge.ts — 把桥接命令映射到应用处理器，并推送状态快照。
import { useEffect, useRef, useState } from 'react';
import { BridgeClient, BridgeStateSnapshot } from '../services/bridgeClient';

export interface BridgeHandlerMap {
  [action: string]: (params: any) => Promise<any> | any;
}

export interface UseBridgeOptions {
  enabled: boolean;
  url?: string;
  snapshot: BridgeStateSnapshot | null;
  handlers: BridgeHandlerMap;
}

export function useBridge({ enabled, url = 'ws://127.0.0.1:3100/ws', snapshot, handlers }: UseBridgeOptions) {
  const [connected, setConnected] = useState(false);
  const clientRef = useRef<BridgeClient | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const pushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const client = new BridgeClient(url);
    clientRef.current = client;
    client.setConnectionHandler(setConnected);
    client.setCommandHandler(async (action, params) => {
      const h = handlersRef.current[action];
      if (!h) return { error: `unknown action: ${action}` };
      return h(params);
    });
    client.connect();
    return () => {
      client.close();
      clientRef.current = null;
      if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    };
  }, [enabled, url]);

  useEffect(() => {
    if (!enabled || !connected || !snapshot) return;
    if (pushTimerRef.current) clearTimeout(pushTimerRef.current);
    pushTimerRef.current = setTimeout(() => {
      clientRef.current?.sendState(snapshotRef.current!);
    }, 300);
  }, [enabled, connected, snapshot]);

  return { connected };
}
