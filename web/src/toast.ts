// Small status toast for transient errors / connectivity notes. One toast at a
// time (newest wins), announced politely to screen readers, auto-dismissed.
// An optional action renders as a button (e.g. "Retry").

let host: HTMLElement | undefined;
let hideTimer: number | undefined;

function ensureHost(): HTMLElement {
  if (!host) {
    host = document.createElement("div");
    host.id = "toast";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.appendChild(host);
  }
  return host;
}

export function dismissToast(): void {
  if (hideTimer !== undefined) {
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  host?.classList.remove("show");
}

export function showToast(
  message: string,
  opts: { action?: { label: string; onClick: () => void }; durationMs?: number } = {},
): void {
  const el = ensureHost();
  if (hideTimer !== undefined) window.clearTimeout(hideTimer);
  el.replaceChildren();

  const text = document.createElement("span");
  text.className = "toast-msg";
  text.textContent = message;
  el.append(text);

  if (opts.action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-act";
    btn.textContent = opts.action.label;
    btn.addEventListener("click", () => {
      dismissToast();
      opts.action?.onClick();
    });
    el.append(btn);
  }

  el.classList.add("show");
  const duration = opts.durationMs ?? (opts.action ? 10000 : 4000);
  hideTimer = window.setTimeout(dismissToast, duration);
}
