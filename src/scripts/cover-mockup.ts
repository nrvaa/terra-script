/**
 * Cover art: shrinking an uploaded image, and drawing mockups of it on a
 * canvas (vinyl, CD, a phone's "now playing" screen, the cover on its own).
 * Drawn on canvas rather than with CSS so the same picture can be saved as PNG.
 */

export type MockupKind = 'vinyl' | 'cd' | 'phone' | 'cover';
export type MockupBg = 'blur' | 'light' | 'dark';
export const MOCKUP_KINDS: MockupKind[] = ['vinyl', 'cd', 'phone', 'cover'];

export const MOCKUP_W = 1600;
export const MOCKUP_H = 1200;

/**
 * An uploaded picture as cover art: at most 1400 px on its longest side, JPEG.
 * Big phone photos / 3000 px masters shrink to a few hundred KB.
 */
export async function prepareCover(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/')) throw new Error('not-image');
  const img = await loadImage(URL.createObjectURL(file), true);
  const scale = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff'; // transparent PNGs get a white background, not black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.9));
}

export function loadImage(url: string, revoke = false): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      if (revoke) URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      if (revoke) URL.revokeObjectURL(url);
      reject(new Error('image'));
    };
    img.src = url;
  });
}

export interface MockupText {
  title: string;
  artist: string;
  /** "Album", "EP" or "Single". */
  kind: string;
}

type Ctx = CanvasRenderingContext2D;

function rrect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draw the cover into a square, cropping it like CSS object-fit: cover. Without art: a placeholder. */
function drawCover(ctx: Ctx, img: HTMLImageElement | null, x: number, y: number, s: number, text: MockupText) {
  if (img) {
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    ctx.drawImage(img, sx, sy, side, side, x, y, s, s);
    return;
  }
  const g = ctx.createLinearGradient(x, y, x + s, y + s);
  g.addColorStop(0, '#6a2ed8');
  g.addColorStop(0.55, '#a78bfa');
  g.addColorStop(1, '#f0abfc');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, s, s);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = `700 ${Math.round(s * 0.075)}px Inter, sans-serif`;
  ctx.textBaseline = 'bottom';
  wrapText(ctx, text.title, x + s * 0.08, y + s * 0.9, s * 0.84, Math.round(s * 0.085));
}

/** Text wrapped upward from a bottom line (at most three lines). */
function wrapText(ctx: Ctx, s: string, x: number, bottom: number, width: number, lead: number) {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (ctx.measureText(next).width > width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  lines.slice(-3).forEach((l, i, all) => ctx.fillText(l, x, bottom - (all.length - 1 - i) * lead));
}

/** Text cut with "…" to fit a width. */
function fit(ctx: Ctx, s: string, width: number): string {
  if (ctx.measureText(s).width <= width) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(t + '…').width > width) t = t.slice(0, -1);
  return t + '…';
}

function shadow(ctx: Ctx, blur: number, y: number, alpha: number) {
  ctx.shadowColor = `rgba(0,0,0,${alpha})`;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = y;
}
const noShadow = (ctx: Ctx) => shadow(ctx, 0, 0, 0);

function background(ctx: Ctx, img: HTMLImageElement | null, bg: MockupBg) {
  const W = MOCKUP_W;
  const H = MOCKUP_H;
  if (bg === 'blur' && img && 'filter' in ctx) {
    // The cover itself, blurred and dimmed, as the backdrop.
    ctx.save();
    ctx.filter = 'blur(70px) saturate(1.25)';
    const s = Math.max(W, H) * 1.3;
    drawCover(ctx, img, (W - s) / 2, (H - s) / 2, s, { title: '', artist: '', kind: '' });
    ctx.restore();
    ctx.fillStyle = 'rgba(10,8,16,0.28)';
    ctx.fillRect(0, 0, W, H);
    return;
  }
  const dark = bg !== 'light';
  const g = ctx.createRadialGradient(W * 0.5, H * 0.42, 80, W * 0.5, H * 0.5, W * 0.75);
  g.addColorStop(0, dark ? '#2a2438' : '#ffffff');
  g.addColorStop(1, dark ? '#0f0d15' : '#e7e3ee');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function vinyl(ctx: Ctx, img: HTMLImageElement | null, text: MockupText) {
  const S = 760;
  const x = 250;
  const y = (MOCKUP_H - S) / 2;
  // The record, sliding out of the sleeve to the right.
  const cx = x + S / 2 + 320;
  const cy = y + S / 2;
  const R = S / 2 - 14;
  shadow(ctx, 50, 20, 0.45);
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = '#111';
  ctx.fill();
  noShadow(ctx);
  // grooves
  for (let r = R - 18; r > 140; r -= 7) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = r % 3 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  // light catching the vinyl
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  // soft sheen: several thin wedges fading in and out instead of one hard slice
  for (const [a, w] of [[-0.6, 0.35], [2.55, 0.25]] as const) {
    for (let k = 0; k < 6; k++) {
      const f = k / 5;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a + w * f * 0.5, a + w * (1 - f * 0.5));
      ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,0.016)';
      ctx.fill();
    }
  }
  ctx.restore();
  // label: the cover, round
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, 130, 0, Math.PI * 2);
  ctx.clip();
  drawCover(ctx, img, cx - 130, cy - 130, 260, text);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, 9, 0, Math.PI * 2);
  ctx.fillStyle = '#e8e6e1';
  ctx.fill();
  // the sleeve
  shadow(ctx, 60, 28, 0.5);
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, S, S);
  noShadow(ctx);
  drawCover(ctx, img, x, y, S, text);
  const sheen = ctx.createLinearGradient(x, y, x + S, y + S);
  sheen.addColorStop(0, 'rgba(255,255,255,0.12)');
  sheen.addColorStop(0.4, 'rgba(255,255,255,0)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = sheen;
  ctx.fillRect(x, y, S, S);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, S - 2, S - 2);
}

function cd(ctx: Ctx, img: HTMLImageElement | null, text: MockupText) {
  const S = 660;
  const hinge = 46;
  const x = 300;
  const y = (MOCKUP_H - S) / 2;
  // the disc, half out of the case
  const cx = x + hinge + S / 2 + 270;
  const cy = y + S / 2;
  const R = S / 2 - 20;
  shadow(ctx, 40, 16, 0.4);
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.fillStyle = '#d9dbe0';
  ctx.fill();
  noShadow(ctx);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, R, 0, Math.PI * 2);
  ctx.clip();
  if ('createConicGradient' in ctx) {
    // the rainbow shimmer of a CD
    const g = ctx.createConicGradient(0.4, cx, cy);
    [['#e6e8ee', 0], ['#c9f2ff', 0.12], ['#fbe1ff', 0.25], ['#fff7cf', 0.38], ['#e6e8ee', 0.5], ['#d2fff0', 0.62], ['#e7d8ff', 0.78], ['#e6e8ee', 1]].forEach(([c, o]) => g.addColorStop(o as number, c as string));
    ctx.fillStyle = g;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, 110, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 52, 0, Math.PI * 2);
  ctx.fillStyle = '#b9bcc4';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, 24, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(20,18,26,0.55)';
  ctx.fill();
  // the jewel case: hinge on the left, cover behind clear plastic
  shadow(ctx, 50, 24, 0.45);
  ctx.fillStyle = '#1b1b1f';
  ctx.fillRect(x, y, S + hinge, S);
  noShadow(ctx);
  drawCover(ctx, img, x + hinge, y, S, text);
  const hg = ctx.createLinearGradient(x, 0, x + hinge, 0);
  hg.addColorStop(0, '#2b2b31');
  hg.addColorStop(0.5, '#4a4a52');
  hg.addColorStop(1, '#202024');
  ctx.fillStyle = hg;
  ctx.fillRect(x, y, hinge, S);
  for (let i = 1; i < 6; i++) {
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x + 8 * i - 2, y, 1, S);
  }
  const plastic = ctx.createLinearGradient(x, y, x + S, y + S);
  plastic.addColorStop(0, 'rgba(255,255,255,0.28)');
  plastic.addColorStop(0.3, 'rgba(255,255,255,0.04)');
  plastic.addColorStop(0.55, 'rgba(255,255,255,0)');
  plastic.addColorStop(0.75, 'rgba(255,255,255,0.08)');
  plastic.addColorStop(1, 'rgba(255,255,255,0.02)');
  ctx.fillStyle = plastic;
  ctx.fillRect(x, y, S + hinge, S);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 1, y + 1, S + hinge - 2, S - 2);
}

function phone(ctx: Ctx, img: HTMLImageElement | null, text: MockupText) {
  const PW = 540;
  const PH = 1100;
  const x = (MOCKUP_W - PW) / 2;
  const y = (MOCKUP_H - PH) / 2;
  shadow(ctx, 70, 30, 0.5);
  rrect(ctx, x, y, PW, PH, 86);
  ctx.fillStyle = '#0b0b0e';
  ctx.fill();
  noShadow(ctx);
  ctx.strokeStyle = '#3a3a42';
  ctx.lineWidth = 3;
  ctx.stroke();
  // screen: the cover blurred behind the player
  const sx = x + 18;
  const sy = y + 18;
  const sw = PW - 36;
  const sh = PH - 36;
  ctx.save();
  rrect(ctx, sx, sy, sw, sh, 70);
  ctx.clip();
  ctx.fillStyle = '#16131f';
  ctx.fillRect(sx, sy, sw, sh);
  if (img && 'filter' in ctx) {
    ctx.save();
    ctx.filter = 'blur(50px) saturate(1.3)';
    drawCover(ctx, img, sx - 200, sy - 100, sh + 300, text);
    ctx.restore();
  }
  const dim = ctx.createLinearGradient(0, sy, 0, sy + sh);
  dim.addColorStop(0, 'rgba(0,0,0,0.25)');
  dim.addColorStop(1, 'rgba(0,0,0,0.65)');
  ctx.fillStyle = dim;
  ctx.fillRect(sx, sy, sw, sh);
  // status bar + island
  ctx.fillStyle = '#fff';
  ctx.font = '600 26px Inter, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.fillText('9:41', sx + 48, sy + 44);
  rrect(ctx, x + PW / 2 - 70, sy + 22, 140, 42, 21);
  ctx.fillStyle = '#000';
  ctx.fill();
  // artwork
  const A = sw - 80;
  const ax = sx + 40;
  const ay = sy + 130;
  shadow(ctx, 40, 18, 0.5);
  rrect(ctx, ax, ay, A, A, 18);
  ctx.fillStyle = '#000';
  ctx.fill();
  noShadow(ctx);
  ctx.save();
  rrect(ctx, ax, ay, A, A, 18);
  ctx.clip();
  drawCover(ctx, img, ax, ay, A, text);
  ctx.restore();
  // title / artist
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.font = '700 38px Inter, sans-serif';
  ctx.fillText(fit(ctx, text.title, A), ax, ay + A + 74);
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.font = '500 28px Inter, sans-serif';
  ctx.fillText(fit(ctx, text.artist || text.kind, A), ax, ay + A + 116);
  // progress
  const py = ay + A + 170;
  rrect(ctx, ax, py, A, 8, 4);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fill();
  rrect(ctx, ax, py, A * 0.36, 8, 4);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.font = '500 22px Inter, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText('1:12', ax, py + 40);
  ctx.textAlign = 'right';
  ctx.fillText('-2:31', ax + A, py + 40);
  ctx.textAlign = 'left';
  // controls: previous, play, next
  const cy = py + 130;
  const mid = x + PW / 2;
  ctx.fillStyle = '#fff';
  const tri = (tx: number, dir: 1 | -1, s: number) => {
    ctx.beginPath();
    ctx.moveTo(tx, cy - s);
    ctx.lineTo(tx + dir * s * 1.4, cy);
    ctx.lineTo(tx, cy + s);
    ctx.closePath();
    ctx.fill();
  };
  ctx.beginPath();
  ctx.arc(mid, cy, 52, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#16131f';
  tri(mid - 14, 1, 22);
  ctx.fillStyle = '#fff';
  tri(mid - 150, -1, 20);
  tri(mid - 178, -1, 20);
  tri(mid + 150, 1, 20);
  tri(mid + 122, 1, 20);
  ctx.restore();
}

function coverOnly(ctx: Ctx, img: HTMLImageElement | null, text: MockupText) {
  const S = 860;
  const x = (MOCKUP_W - S) / 2;
  const y = (MOCKUP_H - S) / 2 - 20;
  shadow(ctx, 80, 36, 0.5);
  ctx.fillStyle = '#000';
  ctx.fillRect(x, y, S, S);
  noShadow(ctx);
  drawCover(ctx, img, x, y, S, text);
}

/** Draw a mockup of the cover art onto `canvas` (MOCKUP_W × MOCKUP_H). */
export function drawMockup(canvas: HTMLCanvasElement, img: HTMLImageElement | null, kind: MockupKind, bg: MockupBg, text: MockupText) {
  canvas.width = MOCKUP_W;
  canvas.height = MOCKUP_H;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, MOCKUP_W, MOCKUP_H);
  background(ctx, img, bg);
  ({ vinyl, cd, phone, cover: coverOnly })[kind](ctx, img, text);
}
