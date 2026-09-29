// Motion shared by the themes. One curve for everything that travels: it speeds up, then settles.
export const EASE = 'cubic-bezier(.65,0,.35,1)';
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Ordered 4x4 dither thresholds: pixels switch on in this pattern as light passes, so the glow is
// made of hard square pixels instead of a soft gradient.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

/**
 * A band of dithered light that crosses `host` on the ease-in-out curve and leaves a pixel trail
 * that dissolves behind it. `host` must clip (overflow: hidden) and be positioned.
 */
export function pixelSweep(host, { cell = 4, duration = 1150, width = 0.17, alpha = 215 } = {}) {
  const box = host.getBoundingClientRect();
  const cols = Math.max(1, Math.ceil(box.width / cell));
  const rows = Math.max(1, Math.ceil(box.height / cell));
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  canvas.className = 'fx-sweep';
  // Sized in whole cells rather than stretched, so every pixel block comes out the same size.
  canvas.style.width = cols * cell + 'px';
  canvas.style.height = rows * cell + 'px';
  host.appendChild(canvas);
  const g = canvas.getContext('2d');
  const img = g.createImageData(cols, rows);
  const px = img.data;
  const start = performance.now();
  const frame = now => {
    const t = Math.min(1, (now - start) / duration);
    const head = -0.25 + easeInOut(t) * 1.5;
    const life = Math.sin(Math.PI * Math.min(1, t * 1.08));
    const trail = 0.34 * Math.pow(1 - t, 1.6);
    for (let y = 0; y < rows; y++) {
      const gloss = 0.8 + 0.2 * (1 - y / rows);
      for (let x = 0; x < cols; x++) {
        const u = x / cols;
        const d = (u - head) / width;
        let v = Math.exp(-d * d) * life;
        if (u < head) v = Math.max(v, trail * (0.55 + 0.45 * u / Math.max(head, 0.01)));
        v *= gloss;
        const i = (y * cols + x) * 4;
        px[i] = px[i + 1] = px[i + 2] = 255;
        px[i + 3] = v > (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16 ? alpha : 0;
      }
    }
    g.putImageData(img, 0, 0);
    if (t < 1) requestAnimationFrame(frame);
    else canvas.remove();
  };
  requestAnimationFrame(frame);
}

/** Rolls `el`'s text up to `text`, holds it, and rolls back, on the same curve as the sweep. */
export function roll(el, text, { hold = 1500 } = {}) {
  if (!el || el.dataset.rolling) return;
  el.dataset.rolling = '1';
  const original = el.textContent;
  const h = el.getBoundingClientRect().height;
  el.style.height = h + 'px';
  el.textContent = '';
  const track = document.createElement('span');
  track.className = 'fx-roll';
  for (const s of [original, text]) {
    const line = document.createElement('span');
    line.textContent = s;
    line.style.height = h + 'px';
    line.style.lineHeight = h + 'px';
    track.appendChild(line);
  }
  el.appendChild(track);
  const move = (from, to) => track.animate([{ transform: `translateY(${from}px)` }, { transform: `translateY(${to}px)` }], { duration: 560, easing: EASE, fill: 'forwards' }).finished;
  move(0, -h)
    .then(() => new Promise(r => setTimeout(r, hold)))
    .then(() => move(-h, 0))
    .finally(() => {
      el.textContent = original;
      el.style.height = '';
      delete el.dataset.rolling;
    });
}

/** A short brightness swell that rides under the sweep. */
export function charge(el) {
  el.animate([{ filter: 'brightness(1)' }, { filter: 'brightness(1.14) saturate(1.08)', offset: 0.45 }, { filter: 'brightness(1)' }], { duration: 1150, easing: EASE });
}

export function shake(el) {
  el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }], { duration: 380, easing: 'ease-out' });
}
