import type { WireMessage } from "./types";

type Handler = (msg: WireMessage) => void;
type StatusHandler = (connected: boolean) => void;

/**
 * Resilient WebSocket client for the live detection feed.
 * Auto-reconnects with backoff and pings to keep the connection warm.
 */
export class LiveFeed {
  private ws: WebSocket | null = null;
  private backoff = 1000;
  private pingTimer: number | undefined;
  private closed = false;

  constructor(
    private onMessage: Handler,
    private onStatus: StatusHandler,
  ) {}

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.backoff = 1000;
      this.onStatus(true);
      this.pingTimer = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 25000);
    });

    ws.addEventListener("message", (ev) => {
      try {
        this.onMessage(JSON.parse(ev.data as string) as WireMessage);
      } catch {
        /* ignore malformed frames */
      }
    });

    const down = () => {
      this.onStatus(false);
      window.clearInterval(this.pingTimer);
      if (!this.closed) {
        setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30000);
      }
    };
    ws.addEventListener("close", down);
    ws.addEventListener("error", () => ws.close());
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}
