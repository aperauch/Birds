// Aviary: a single Durable Object that holds hot state and fans out new
// detections to all connected dashboards + frames over WebSockets.
//
// Uses the WebSocket Hibernation API so idle connections incur no billing.
import { DurableObject } from "cloudflare:workers";
import type { Bindings, DetectionEvent } from "./types";

const RECENT_MAX = 60; // ring buffer of recent events kept for replay-on-connect

interface WireMessage {
  type: "hello" | "detection" | "ping";
  recent?: DetectionEvent[];
  event?: DetectionEvent;
  ts?: number;
}

export class Aviary extends DurableObject<Bindings> {
  private recent: DetectionEvent[] = [];
  private hydrated = false;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
  }

  private async hydrate(): Promise<void> {
    if (this.hydrated) return;
    const stored = await this.ctx.storage.get<DetectionEvent[]>("recent");
    this.recent = stored ?? [];
    this.hydrated = true;
  }

  /** WebSocket upgrade entrypoint (proxied from the Worker at /ws). */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    await this.hydrate();

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    // Hibernatable accept: the runtime can evict us between messages.
    this.ctx.acceptWebSocket(server);

    // Greet with the recent backlog so a fresh page paints immediately.
    server.send(
      JSON.stringify({ type: "hello", recent: this.recent } satisfies WireMessage),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Called via RPC from the ingest path when a new detection lands. */
  async broadcast(event: DetectionEvent): Promise<void> {
    await this.hydrate();
    this.recent.unshift(event);
    if (this.recent.length > RECENT_MAX) this.recent.length = RECENT_MAX;
    await this.ctx.storage.put("recent", this.recent);

    const msg = JSON.stringify({ type: "detection", event } satisfies WireMessage);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // best-effort; dead sockets are cleaned up by close handlers
      }
    }
  }

  /** Recent events for the read API (avoids a D1 round-trip on hot path). */
  async getRecent(): Promise<DetectionEvent[]> {
    await this.hydrate();
    return this.recent;
  }

  /** Clear the hot buffer (used by the admin reset before going live). */
  async reset(): Promise<void> {
    this.recent = [];
    this.hydrated = true;
    await this.ctx.storage.put("recent", []);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // Clients may ping to keep middleboxes from dropping the connection.
    if (typeof message === "string" && message === "ping") {
      ws.send(JSON.stringify({ type: "ping", ts: Date.now() } satisfies WireMessage));
    }
  }

  webSocketClose(ws: WebSocket, code: number, _reason: string, _clean: boolean): void {
    try {
      ws.close(code, "closing");
    } catch {
      // already closed
    }
  }

  webSocketError(_ws: WebSocket, _error: unknown): void {
    // no-op: hibernation API surfaces errors here; nothing to recover.
  }
}
