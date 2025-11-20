import type { ServerResponse } from 'http';
import { v4 as uuidv4 } from 'uuid';

interface Client {
  id: string;
  res: ServerResponse;
}

class RealtimeService {
  private clients: Map<string, Client> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;

  addClient(res: ServerResponse): string {
    const id = uuidv4();
    const client: Client = { id, res };
    this.clients.set(id, client);

    // Send initial event
    this.sendRaw(res, `event: connected\n` + `data: ${JSON.stringify({ id, ts: Date.now() })}\n\n`);

    // Ensure heartbeats are running
    this.ensureHeartbeat();

    return id;
  }

  removeClient(id: string) {
    const c = this.clients.get(id);
    if (c) {
      try { c.res.end(); } catch {}
      this.clients.delete(id);
    }
    if (this.clients.size === 0 && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  broadcast(event: string, payload: unknown) {
    if (this.clients.size === 0) return;
    const line = `event: ${event}\n` + `data: ${JSON.stringify({ payload, ts: Date.now() })}\n\n`;
    for (const { res } of this.clients.values()) {
      this.sendRaw(res, line);
    }
  }

  private ensureHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      for (const { res } of this.clients.values()) {
        // comment line (keeps connection alive behind some proxies)
        this.sendRaw(res, `: ping ${Date.now()}\n\n`);
      }
    }, 15000);
  }

  private sendRaw(res: ServerResponse, chunk: string) {
    try {
      res.write(chunk);
    } catch {}
  }
}

export const realtime = new RealtimeService();
