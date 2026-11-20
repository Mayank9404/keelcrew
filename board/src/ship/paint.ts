/**
 * Pictures painted on canvases for the ship: deck planks, jersey stripes, console screens, dials, the telegraph face,
 * lettering, the chart on the chart table, and the soft pools lanterns throw at night. Some can be repainted when the
 * crew changes.
 */
import * as THREE from 'three';
import type { Mood } from '../lib/office';
import type { Bin } from './parts';

type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;

/** A texture drawn once, or again with `paint` when what it shows changes. */
export interface Painted {
  tex: THREE.CanvasTexture;
  paint(draw: Draw): void;
}

export function painted(bin: Bin, w: number, h: number, draw: Draw, repeat?: [number, number]): Painted {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  const tex = bin.keep(new THREE.CanvasTexture(c));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (repeat) {
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeat[0], repeat[1]);
  }
  const paint = (d: Draw) => {
    g.clearRect(0, 0, w, h);
    d(g, w, h);
    tex.needsUpdate = true;
  };
  paint(draw);
  return { tex, paint };
}

/** A small repeatable pseudo-random sequence, so the planks look the same on every load. */
function seq(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Teak planks along x with caulked seams, butt joints with plugs, and faint grain. */
export const planks = (bin: Bin, rx: number, ry: number) =>
  painted(bin, 512, 512, (g, w) => {
    const r = seq(91);
    for (let i = 0; i < 8; i++) {
      const y = i * 64;
      const k = 0.9 + r() * 0.18;
      g.fillStyle = `rgb(${(212 * k) | 0},${(176 * k) | 0},${(122 * k) | 0})`;
      g.fillRect(0, y, w, 64);
      g.fillStyle = 'rgba(90,61,28,0.08)';
      for (let n = 0; n < 8; n++) g.fillRect(r() * w, y + 8 + r() * 48, 50 + r() * 170, 1.5);
      g.fillStyle = '#5C4126';
      g.fillRect(0, y, w, 3);
      const joint = r() * w;
      g.fillRect(joint, y, 3, 64);
      g.fillStyle = '#80603A';
      for (const dx of [-10, 10]) for (const dy of [16, 48]) g.fillRect(joint + dx, y + dy, 3, 3);
    }
  }, [rx, ry]).tex;

/** Navy stripes on white, for the engineers' jerseys. */
export const stripes = (bin: Bin) =>
  painted(bin, 8, 128, (g, w, h) => {
    g.fillStyle = '#F7F5EF';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#1B4F72';
    for (let i = 0; i < 6; i++) g.fillRect(0, 20 + i * 17, w, 7);
  }).tex;

/** A console screen: the task key and some lines of work, or a dark screen with a cursor when the console is free. */
export function drawScreen(key: string | null): Draw {
  return (g, w, h) => {
    g.fillStyle = '#0B2233';
    g.fillRect(0, 0, w, h);
    if (!key) {
      g.fillStyle = '#2D4B60';
      g.fillRect(16, 26, 14, 22);
      return;
    }
    g.fillStyle = '#62C6D2';
    g.font = '600 30px "JetBrains Mono", ui-monospace, monospace';
    g.fillText(key.slice(0, 14), 16, 40);
    const r = seq([...key].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
    const inks = ['#8CC4EA', '#E4EDF3', '#F4E6BC', '#62C6D2'];
    for (let i = 0; i < 7; i++) {
      let x = 16 + (r() < 0.4 ? 24 : 0);
      for (let n = 0; n < 3 && x < w - 60; n++) {
        const len = 22 + r() * 84;
        g.fillStyle = inks[(r() * inks.length) | 0];
        g.fillRect(x, 60 + i * 18, len, 7);
        x += len + 10;
      }
    }
  };
}

/** A round gauge with a red band near the top of its range. */
export const dial = (bin: Bin, value: number, label: string) =>
  painted(bin, 128, 128, (g, w) => {
    const c = w / 2;
    const at = (v: number) => Math.PI * 0.75 + v * Math.PI * 1.5;
    g.fillStyle = '#F7F1DD';
    g.beginPath();
    g.arc(c, c, c, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#C8321F';
    g.lineWidth = 7;
    g.beginPath();
    g.arc(c, c, 49, at(0.85), at(1));
    g.stroke();
    g.strokeStyle = '#17181C';
    g.lineWidth = 3;
    for (let i = 0; i <= 10; i++) {
      g.beginPath();
      g.moveTo(c + Math.cos(at(i / 10)) * 44, c + Math.sin(at(i / 10)) * 44);
      g.lineTo(c + Math.cos(at(i / 10)) * 54, c + Math.sin(at(i / 10)) * 54);
      g.stroke();
    }
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(c, c);
    g.lineTo(c + Math.cos(at(value)) * 40, c + Math.sin(at(value)) * 40);
    g.stroke();
    g.fillStyle = '#17181C';
    g.beginPath();
    g.arc(c, c, 7, 0, Math.PI * 2);
    g.fill();
    g.font = '600 15px "Archivo", sans-serif';
    g.textAlign = 'center';
    g.fillText(label, c, c + 38);
  }).tex;

/** What the telegraph points to for a mood: Stop when stuck, Stand by when waiting, Ahead when busy, Finished otherwise. */
export const ORDER: Record<Mood, number> = { stuck: 0, waiting: 1, working: 2, thinking: 2, done: 3, idle: 3 };
const ORDERS: [string, string][] = [['STOP', '#C8321F'], ['STAND BY', '#B4237F'], ['AHEAD', '#2E8C9E'], ['FINISHED', '#4E9BD0']];

export function drawTelegraph(order: number): Draw {
  return (g, w) => {
    const c = w / 2;
    g.fillStyle = '#F7F1DD';
    g.beginPath();
    g.arc(c, c, c - 2, 0, Math.PI * 2);
    g.fill();
    ORDERS.forEach(([label, ink], i) => {
      const a0 = Math.PI + i * (Math.PI / 4), a1 = a0 + Math.PI / 4;
      const on = i === order;
      g.fillStyle = on ? ink : '#F7F1DD';
      g.strokeStyle = '#17181C';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(c, c);
      g.arc(c, c, c - 2, a0, a1);
      g.closePath();
      g.fill();
      g.stroke();
      g.save();
      g.translate(c, c);
      g.rotate((a0 + a1) / 2 + Math.PI / 2);
      g.fillStyle = on ? '#FFFFFF' : '#17181C';
      g.font = '700 11px "Archivo", sans-serif';
      g.textAlign = 'center';
      g.fillText(label, 0, -c + 24);
      g.restore();
    });
  };
}

/** Lettering in the display face, for name boards, the hull and the deck. */
export function drawWords(text: string, ink: string): Draw {
  return (g, w, h) => {
    g.fillStyle = ink;
    g.font = '600 64px "Literata", Georgia, serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, w / 2, h / 2 + 4, w - 16);
  };
}

/** The ship's clock at Rounds, with the time of the next round under the hands. */
export function drawClock(next: string): Draw {
  return (g, w) => {
    const c = w / 2;
    g.fillStyle = '#F7F1DD';
    g.beginPath();
    g.arc(c, c, c, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#17181C';
    g.lineCap = 'round';
    g.lineWidth = 4;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * 58, c + Math.sin(a) * 58);
      g.lineTo(c + Math.cos(a) * 70, c + Math.sin(a) * 70);
      g.stroke();
    }
    g.lineWidth = 7;
    g.beginPath();
    g.moveTo(c, c);
    g.lineTo(c + 34, c - 20);
    g.stroke();
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(c, c);
    g.lineTo(c - 30, c - 48);
    g.stroke();
    g.fillStyle = '#17181C';
    g.font = '700 15px "Archivo", sans-serif';
    g.textAlign = 'center';
    g.fillText(next ? `NEXT ${next}` : 'NO ROUNDS', c, c + 44);
  };
}

/** The ensign at the stern: a navy cross on buff. */
export const ensign = (bin: Bin) =>
  painted(bin, 200, 120, (g, w, h) => {
    g.fillStyle = '#F4E6BC';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#1B4F72';
    g.fillRect(0, h * 0.42, w, h * 0.16);
    g.fillRect(w * 0.3, 0, w * 0.1, h);
  }).tex;

/** A soft white spot, tinted by the material, for the pools of lantern light on deck. */
export const softSpot = (bin: Bin) =>
  painted(bin, 128, 128, (g, w) => {
    const grad = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, w);
  }).tex;
