/**
 * The harbourmaster's terrace, on the roof of the harbour office: half under an awning, half open. Under the awning,
 * the harbour board, a screen showing how much of the usage windows is used, today's spend, what waits for you, what
 * is stuck and when the next watch is due. On the open half, the radio cabinet with a light for the Mac helper's state.
 * By the boardwalk, the signal mast hoists a flag for each standing condition: all work paused,
 * notifications muted, the usage guard holding new work. Everything repaints on each poll.
 */
import * as THREE from 'three';
import { clock } from '../lib/format';
import type { Harbour } from '../lib/office';
import { lettering, type Yard } from './fittings';
import { painted } from './paint';
import type { Vec } from './parts';

export interface Harbourmaster {
  update(h: Harbour): void;
  /** Things with a tip on hover: the board, the cabinet, the mast. */
  props: THREE.Object3D[];
  ticks: ((t: number, dt: number) => void)[];
}

const INK = { bg: '#0B2233', title: '#F4E6BC', label: '#8CC4EA', value: '#E4EDF3', you: '#E268B4', stuck: '#F06A55', ok: '#62C6D2', warn: '#E3B23C', bad: '#F06A55', off: '#4F6B80' };
const level = (p: number) => (p >= 90 ? INK.bad : p >= 70 ? INK.warn : INK.ok);

function drawBoard(h: Harbour): (g: CanvasRenderingContext2D, w: number, hh: number) => void {
  return (g, w) => {
    g.fillStyle = INK.bg;
    g.fillRect(0, 0, w, 360);
    g.fillStyle = INK.title;
    g.font = '600 34px "Literata", Georgia, serif';
    g.fillText('Harbour board', 24, 48);
    g.fillStyle = '#1D3B52';
    g.fillRect(24, 62, w - 48, 2);
    const row = (y: number, label: string, value: string, ink: string, bar?: number) => {
      g.fillStyle = INK.label;
      g.font = '500 24px "Archivo", system-ui, sans-serif';
      g.fillText(label, 24, y);
      g.fillStyle = ink;
      g.font = '600 26px "JetBrains Mono", ui-monospace, monospace';
      g.textAlign = 'right';
      g.fillText(value, w - 24, y);
      g.textAlign = 'left';
      if (bar !== undefined) {
        g.fillStyle = '#1D3B52';
        g.fillRect(210, y - 14, 180, 10);
        g.fillStyle = ink;
        g.fillRect(210, y - 14, 1.8 * Math.min(100, bar), 10);
      }
    };
    row(104, 'Usage, 5 h', h.fiveHour === null ? '…' : `${h.fiveHour}%`, h.fiveHour === null ? INK.off : level(h.fiveHour), h.fiveHour ?? undefined);
    row(146, 'Usage, 7 d', h.sevenDay === null ? '…' : `${h.sevenDay}%`, h.sevenDay === null ? INK.off : level(h.sevenDay), h.sevenDay ?? undefined);
    row(188, 'Spent today', `$${h.spendToday.toFixed(2)}`, INK.value);
    row(230, 'Waiting for you', String(h.waiting), h.waiting ? INK.you : INK.value);
    row(272, 'Stuck', String(h.stuck), h.stuck ? INK.stuck : INK.value);
    row(314, 'Next watch', h.nextRound ? clock(h.nextRound) : 'none due', INK.value);
  };
}

function drawCabinet(h: Harbour): (g: CanvasRenderingContext2D, w: number, hh: number) => void {
  return (g, w, hh) => {
    g.fillStyle = '#16232E';
    g.fillRect(0, 0, w, hh);
    g.fillStyle = INK.title;
    g.font = '600 26px "Literata", Georgia, serif';
    g.fillText('Radio', 18, 38);
    const ink = h.helper === 'ok' ? '#5BD38A' : h.helper === 'old' ? INK.warn : INK.bad;
    g.fillStyle = ink;
    g.beginPath();
    g.arc(30, 74, 8, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = INK.value;
    g.font = '500 18px "Archivo", system-ui, sans-serif';
    g.fillText(h.helper === 'ok' ? 'Mac helper running' : h.helper === 'old' ? 'Mac helper out of date' : 'Mac helper not reachable', 48, 80);
  };
}

export function buildHarbourmaster(y: Yard, scene: THREE.Scene, office: Vec, roofTop: number): Harbourmaster {
  const { s, p, bin, glows } = y;
  const ticks: Harbourmaster['ticks'] = [];
  const props: THREE.Object3D[] = [];
  const g = new THREE.Group();
  g.position.set(office[0], roofTop, office[2]);
  scene.add(g);

  /* The terrace: teak decking, a white rail round the open half, an awning in the department-neutral navy over the rest */
  s.box(g, [3.5, 0.04, 4.7], p.teak, [0, 0.02, 0], 0.01);
  for (const x of [-1.7, 1.7]) {
    s.bar(g, [x, 0.75, -0.1], [x, 0.75, 2.3], 0.03, p.white);
    for (let z = -0.1; z <= 2.3; z += 0.6) s.post(g, 0.02, 0.02, 0.75, p.white, [x, 0.38, z], 6);
  }
  s.bar(g, [-1.7, 0.75, 2.3], [1.7, 0.75, 2.3], 0.03, p.white);
  // A short striped awning shades the back of the terrace; the board stands in front of it, tilted up to the viewer.
  for (const x of [-1.65, 1.65]) s.post(g, 0.035, 0.035, 3.0, p.white, [x, 1.5, -2.3], 8);
  const awning = bin.keep(new THREE.MeshStandardMaterial({ color: '#1B4F72', roughness: 0.85, side: THREE.DoubleSide }));
  const shade = new THREE.Group();
  shade.position.set(0, 3.0, -2.3);
  shade.rotation.x = 0.5;
  g.add(shade);
  for (let k = 0; k < 3; k++) s.box(shade, [3.6, 0.04, 0.3], k % 2 ? p.white : awning, [0, 0, k * 0.3 + 0.15], 0.005);
  s.box(g, [0.5, 0.42, 0.5], p.darkTeak, [-1.25, 0.21, 1.85], 0.03);
  for (let f = 0; f < 5; f++) s.ball(g, 0.1, p.yellow, [-1.25 + ((f % 3) - 1) * 0.13, 0.48, 1.85 + (f > 2 ? 0.12 : -0.08)]);

  /* The harbour board, facing the water under the awning */
  const board = new THREE.Group();
  board.position.set(-0.3, 0, -1.55);
  board.rotation.x = -0.42;
  g.add(board);
  s.box(board, [3.0, 2.1, 0.12], p.iron, [0, 1.35, 0], 0.04);
  s.post(board, 0.05, 0.07, 0.3, p.iron, [0, 0.15, 0], 8);
  const boardPic = painted(bin, 512, 360, () => undefined);
  const boardGlass = bin.keep(new THREE.MeshStandardMaterial({ map: boardPic.tex, emissive: '#FFFFFF', emissiveMap: boardPic.tex, emissiveIntensity: 0.5, roughness: 0.3 }));
  glows.screens.push(boardGlass);
  s.sign(board, 2.86, 2.0, boardGlass, [0, 1.35, 0.065]);
  board.userData.prop = 'board';
  props.push(board);

  /* The radio cabinet: a rack with the Mac helper's light, a mast with a blinking light on top */
  const cab = new THREE.Group();
  cab.position.set(1.05, 0, 0.75);
  g.add(cab);
  s.box(cab, [1.0, 1.6, 0.6], bin.keep(new THREE.MeshStandardMaterial({ color: '#2B333B', roughness: 0.5, metalness: 0.3 })), [0, 0.8, 0], 0.04);
  const cabPic = painted(bin, 256, 400, () => undefined);
  const cabGlass = bin.keep(new THREE.MeshStandardMaterial({ map: cabPic.tex, emissive: '#FFFFFF', emissiveMap: cabPic.tex, emissiveIntensity: 0.5, roughness: 0.35 }));
  glows.screens.push(cabGlass);
  s.sign(cab, 0.86, 1.34, cabGlass, [0, 0.86, 0.305]);
  for (let k = 0; k < 4; k++) s.box(cab, [0.06, 0.02, 0.5], p.iron, [0.53, 0.3 + k * 0.35, 0], 0.005);
  // The radio aerial stands at the back corner, clear of the board behind.
  s.post(cab, 0.02, 0.03, 1.3, p.white, [0.42, 2.25, -0.25], 6);
  for (let k = 0; k < 3; k++) s.bar(cab, [0.42, 1.85 + k * 0.3, -0.25], [0.42 + 0.3 - k * 0.08, 1.85 + k * 0.3, -0.25], 0.012, p.white);
  const blink = bin.keep(new THREE.MeshStandardMaterial({ color: '#FF5A4A', emissive: '#FF3A2A', emissiveIntensity: 1 }));
  s.ball(cab, 0.06, blink, [0.42, 2.94, -0.25]);
  ticks.push((t) => void (blink.emissiveIntensity = Math.sin(t * 3) > 0.6 ? 2.2 : 0.15));
  cab.userData.prop = 'helper';
  props.push(cab);
  lettering(y, g, 'Harbourmaster', [1.76, -0.32, -1.0], 2.3, '#1B4F72', false).rotation.y = Math.PI / 2;

  /* The signal mast by the boardwalk: a flag hoisted for each standing condition */
  const mast = new THREE.Group();
  mast.position.set(office[0] + 2.7, office[1], office[2] - 4.6);
  scene.add(mast);
  s.post(mast, 0.05, 0.08, 6.2, p.white, [0, 3.1, 0], 10);
  s.bar(mast, [0, 5.2, -1.0], [0, 5.2, 1.0], 0.03, p.white);
  s.ball(mast, 0.1, p.brass, [0, 6.25, 0]);
  const flag = (colour: string, z: number, pennant: boolean) => {
    const shape = pennant ? new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.9, -0.22), new THREE.Vector2(0, -0.44)]) : new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.7, 0), new THREE.Vector2(0.7, -0.5), new THREE.Vector2(0, -0.5)]);
    const m = new THREE.Mesh(bin.keep(new THREE.ShapeGeometry(shape)), bin.keep(new THREE.MeshStandardMaterial({ color: colour, roughness: 0.8, side: THREE.DoubleSide })));
    m.rotation.y = Math.PI / 2;
    m.position.set(0, 5.15, z);
    mast.add(m);
    return m;
  };
  const flags = { paused: flag('#C8321F', -0.95, false), quiet: flag('#1B4F72', 0.05, true), guarded: flag('#E3B23C', 0.95, false) };
  ticks.push((t) => {
    for (const [i, f] of Object.values(flags).entries()) f.rotation.x = Math.sin(t * 2.4 + i) * 0.18;
  });
  mast.userData.prop = 'signals';
  props.push(mast);

  return {
    props,
    ticks,
    update(h) {
      boardPic.paint(drawBoard(h));
      cabPic.paint(drawCabinet(h));
      flags.paused.visible = h.paused;
      flags.quiet.visible = h.quiet;
      flags.guarded.visible = h.guarded;
      board.userData.tip = ['Harbour board', `Usage ${h.fiveHour ?? '…'}% of 5 h, ${h.sevenDay ?? '…'}% of 7 days; $${h.spendToday.toFixed(2)} today. Open Muster for sessions and spend.`];
      cab.userData.tip = ['Radio cabinet', `Mac helper ${h.helper === 'ok' ? 'running' : h.helper === 'old' ? 'out of date' : 'not reachable'}.`];
      const raised = [h.paused && 'all work paused (red)', h.quiet && 'notifications muted (navy)', h.guarded && 'usage guard holding new work (yellow)'].filter(Boolean);
      mast.userData.tip = ['Signal mast', raised.length ? `Flying: ${raised.join(', ')}.` : 'No signals flying: work is running as usual.'];
    },
  };
}
