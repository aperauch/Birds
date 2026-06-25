// Web Push subscribe/unsubscribe flow (Phase 6).
// Wires a single toggle button; no-ops gracefully when the browser lacks
// support or the server has push disabled (no VAPID key).

function supported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function getServerKey(): Promise<string | null> {
  try {
    const res = await fetch("/api/push/key");
    if (!res.ok) return null;
    const { enabled, key } = (await res.json()) as { enabled: boolean; key: string | null };
    return enabled ? key : null;
  } catch {
    return null;
  }
}

async function subscribe(reg: ServiceWorkerRegistration, key: string): Promise<boolean> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return false;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key) as unknown as BufferSource,
  });
  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  return res.ok;
}

async function unsubscribe(reg: ServiceWorkerRegistration): Promise<void> {
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await fetch("/api/push/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => undefined);
  await sub.unsubscribe();
}

/** Wire the notify toggle button; hides it when unavailable. */
export async function setupNotifyButton(btn: HTMLButtonElement): Promise<void> {
  if (!supported()) {
    btn.hidden = true;
    return;
  }
  const key = await getServerKey();
  if (!key) {
    btn.hidden = true; // server push disabled
    return;
  }

  let reg: ServiceWorkerRegistration;
  try {
    reg = await navigator.serviceWorker.register("/sw.js");
  } catch {
    btn.hidden = true;
    return;
  }

  const reflect = async (): Promise<void> => {
    const sub = await reg.pushManager.getSubscription();
    const on = !!sub;
    btn.classList.toggle("active", on);
    btn.textContent = on ? "Alerts on" : "Notify";
    btn.title = on ? "Disable new/rare species alerts" : "Get alerts for new & rare species";
  };

  btn.hidden = false;
  await reflect();

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      const sub = await reg.pushManager.getSubscription();
      if (sub) await unsubscribe(reg);
      else await subscribe(reg, key);
      await reflect();
    } finally {
      btn.disabled = false;
    }
  });
}
