// A compact, accessible single-select dropdown for the header toolbar.
//
// Each control renders as a fixed-width trigger ("value ▾") that opens a small
// menu. Because every trigger is always present (and fixed width), switching
// views or changing a value never reflows its neighbours — which is the whole
// point: the old always-visible pill groups shifted the toolbar whenever the
// (conditional) sort group appeared/disappeared.
export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

export interface DropdownHandle<T extends string> {
  el: HTMLElement;
  setValue(value: T): void;
  setDisabled(disabled: boolean, reason?: string): void;
}

// Only one menu open at a time across the whole toolbar.
let activeClose: (() => void) | null = null;

export function createDropdown<T extends string>(cfg: {
  name: string; // control name, shown as the menu header + trigger tooltip
  options: DropdownOption<T>[];
  value: T;
  onChange: (value: T) => void;
  minWidth?: string; // keep the trigger a stable width regardless of value
}): DropdownHandle<T> {
  const wrap = document.createElement("div");
  wrap.className = "dd";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "dd-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.title = cfg.name;
  if (cfg.minWidth) trigger.style.minWidth = cfg.minWidth;
  const cur = document.createElement("span");
  cur.className = "dd-cur";
  const caret = document.createElement("span");
  caret.className = "dd-caret";
  caret.textContent = "▾";
  caret.setAttribute("aria-hidden", "true");
  trigger.append(cur, caret);

  const menu = document.createElement("div");
  menu.className = "dd-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", cfg.name);
  menu.hidden = true;
  const head = document.createElement("div");
  head.className = "dd-head";
  head.textContent = cfg.name;
  menu.appendChild(head);

  let value = cfg.value;
  const optEls = new Map<T, HTMLButtonElement>();
  for (const o of cfg.options) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "dd-opt";
    b.setAttribute("role", "option");
    b.textContent = o.label;
    if (o.title) b.title = o.title;
    b.addEventListener("click", () => {
      close();
      trigger.focus();
      if (o.value !== value) {
        setValue(o.value);
        cfg.onChange(o.value);
      }
    });
    optEls.set(o.value, b);
    menu.appendChild(b);
  }

  function renderCurrent(): void {
    const o = cfg.options.find((x) => x.value === value);
    cur.textContent = o ? o.label : "";
    for (const [v, el] of optEls) {
      const on = v === value;
      el.setAttribute("aria-selected", on ? "true" : "false");
      el.classList.toggle("on", on);
    }
  }

  function setValue(v: T): void {
    value = v;
    renderCurrent();
  }

  function focusOption(delta: number): void {
    const list = [...optEls.values()];
    const active = document.activeElement as HTMLElement | null;
    let i = list.findIndex((el) => el === active);
    if (i === -1) i = list.findIndex((el) => el.classList.contains("on"));
    const next = list[(i + delta + list.length) % list.length];
    next?.focus();
  }

  function onDocClick(e: MouseEvent): void {
    if (!wrap.contains(e.target as Node)) close();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      close();
      trigger.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      focusOption(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusOption(-1);
    }
  }

  function open(): void {
    if (activeClose && activeClose !== close) activeClose();
    menu.hidden = false;
    wrap.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    activeClose = close;
    // Defer so the opening click doesn't immediately close it.
    setTimeout(() => document.addEventListener("click", onDocClick), 0);
    document.addEventListener("keydown", onKey);
    (optEls.get(value) ?? [...optEls.values()][0])?.focus();
  }
  function close(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    wrap.classList.remove("open");
    trigger.setAttribute("aria-expanded", "false");
    if (activeClose === close) activeClose = null;
    document.removeEventListener("click", onDocClick);
    document.removeEventListener("keydown", onKey);
  }

  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.hidden) open();
    else close();
  });

  wrap.append(trigger, menu);
  renderCurrent();

  return {
    el: wrap,
    setValue,
    setDisabled(disabled: boolean, reason?: string) {
      trigger.disabled = disabled;
      wrap.classList.toggle("disabled", disabled);
      trigger.title = disabled && reason ? reason : cfg.name;
      if (disabled) close();
    },
  };
}
