// Injected with context.addInitScript({ path }) on recorded runs only.
// Playwright videos don't render the OS cursor, so draw one plus a click ring.
(() => {
  if (window.__recordClipCursor) return;
  window.__recordClipCursor = true;

  const CSS = `
    #__rc-cursor {
      position: fixed; top: 0; left: 0; width: 20px; height: 20px;
      margin: -2px 0 0 -2px; pointer-events: none; z-index: 2147483647;
      transition: transform 60ms linear;
    }
    .__rc-ring {
      position: fixed; width: 28px; height: 28px; margin: -14px 0 0 -14px;
      border: 3px solid rgba(255, 64, 64, 0.9); border-radius: 50%;
      pointer-events: none; z-index: 2147483647;
      animation: __rc-pulse 450ms ease-out forwards;
    }
    @keyframes __rc-pulse {
      from { transform: scale(0.4); opacity: 1; }
      to { transform: scale(1.8); opacity: 0; }
    }
  `;
  const ARROW =
    '<svg width="20" height="20" viewBox="0 0 20 20"><path d="M2 2 L2 17 L6 13 L9 19 L12 18 L9 12 L15 12 Z" fill="#111" stroke="#fff" stroke-width="1.5"/></svg>';
  const POS_KEY = '__rc-cursor-pos';

  // Carry the position across page loads so the cursor shows right away
  // instead of only after the next mousemove.
  const loadPos = () => {
    try {
      return JSON.parse(sessionStorage.getItem(POS_KEY));
    } catch {
      return null;
    }
  };
  const savePos = (pos) => {
    try {
      sessionStorage.setItem(POS_KEY, JSON.stringify(pos));
    } catch {}
  };

  let pos = loadPos();

  const ensureCursor = () => {
    const root = document.documentElement;
    if (!root) return null;
    if (!document.getElementById('__rc-style')) {
      const style = document.createElement('style');
      style.id = '__rc-style';
      style.textContent = CSS;
      root.appendChild(style);
    }
    let cursor = document.getElementById('__rc-cursor');
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = '__rc-cursor';
      cursor.innerHTML = ARROW;
      if (pos) cursor.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      else cursor.style.display = 'none';
    }
    if (cursor.parentNode !== root || cursor.nextSibling) root.appendChild(cursor);
    return cursor;
  };

  // Hydration or apps replacing <html> children can drop the cursor; put it back.
  const watch = () => {
    ensureCursor();
    new MutationObserver(ensureCursor).observe(document.documentElement, { childList: true });
  };
  if (document.documentElement) watch();
  else document.addEventListener('DOMContentLoaded', watch, { once: true });

  window.addEventListener('mousemove', (e) => {
    pos = { x: e.clientX, y: e.clientY };
    savePos(pos);
    const cursor = ensureCursor();
    if (!cursor) return;
    cursor.style.display = '';
    cursor.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
  }, true);

  window.addEventListener('mousedown', (e) => {
    if (!ensureCursor()) return;
    const ring = document.createElement('div');
    ring.className = '__rc-ring';
    ring.style.left = `${e.clientX}px`;
    ring.style.top = `${e.clientY}px`;
    ring.addEventListener('animationend', () => ring.remove(), { once: true });
    document.documentElement.appendChild(ring);
  }, true);
})();
