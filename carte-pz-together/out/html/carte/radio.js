// Calque optionnel des portees radio : un cercle par modele de talkie-walkie
// (et par poste emetteur), centre sur toi, sur une base ou sur un point epingle.
//
// LES PORTEES
// Recopiees de media/scripts/generated/items/radio.txt (build 42), champ
// TransmitRange de chaque objet qui a TwoWay = true. Les noms sont ceux de
// media/lua/shared/Translate/FR/ItemName.json.
//
// COMMENT LE JEU MESURE (lu dans projectzomboid.jar, zombie.radio.ZomboidRadio)
//  - GetDistance : distance euclidienne en cases, sqrt(dx^2 + dy^2), tronquee.
//    C'est donc bien un cercle, pas un carre.
//  - La portee est celle de l'EMETTEUR : on entend quelqu'un si on est a moins
//    de SA TransmitRange. Le cercle montre jusqu'ou porte ta voix avec ce
//    modele ; pour entendre l'autre, c'est le cercle de son modele qui compte.
//  - doDeviceRangeDistortion : au-dela de 90 % de la portee, le message est
//    brouille, de 0 % a 90 % puis jusqu'a 100 % au bord. D'ou le trait
//    interieur en pointilles.
//  - En dessous de 4 cases, aucune transmission : on est a portee de voix.

import { vue, mondeVersEcranX, mondeVersEcranY } from './vue.js';

export const MODELES = [
  { id: 'WalkieTalkie1',         nom: 'Toys-R-Mine',          portee: 750,   couleur: '#e8e8ea' },
  { id: 'WalkieTalkieMakeShift', nom: 'artisanal',            portee: 1000,  couleur: '#b9a37a' },
  { id: 'WalkieTalkie2',         nom: 'ValuTech',             portee: 2000,  couleur: '#4fc3d9' },
  { id: 'WalkieTalkie3',         nom: 'Premium Technologies', portee: 4000,  couleur: '#8fd14f' },
  { id: 'WalkieTalkie4',         nom: 'tactique',             portee: 8000,  couleur: '#e0a33c' },
  { id: 'WalkieTalkie5',         nom: 'Armee americaine',     portee: 16000, couleur: '#e8735f' },
  { id: 'ManPackRadio',          nom: 'poste nomade militaire', portee: 20000, couleur: '#c98bdc', poste: true },
  { id: 'HamRadioMakeShift',     nom: 'radioamateur artisanale', portee: 6000, couleur: '#9aa3b2', poste: true, fixe: true },
  { id: 'HamRadio1',             nom: 'radioamateur Premium', portee: 7500,  couleur: '#7fa7e8', poste: true, fixe: true },
  { id: 'HamRadio2',             nom: 'radioamateur militaire', portee: 20000, couleur: '#d97fb0', poste: true, fixe: true },
];

const CLE = 'pzcarte.radio';
const SEGMENTS = 160;
const SEUIL_BROUILLAGE = 0.9;

export const etat = {
  actif: false,
  modeles: new Set(['WalkieTalkie2']),
  centre: 'moi',        // 'moi', 'epingle', ou l'id d'une base
  epingle: null,        // {x, y}
};

let canvas = null, ctx = null;
let sourceCentre = () => null;

/**
 * resoudre(centre) rend {x, y, nom} ou null : c'est app.js qui sait ou sont
 * le joueur et les bases, ce module ne fait que dessiner.
 */
export function initRadio(element, resoudre) {
  canvas = element;
  ctx = canvas.getContext('2d');
  sourceCentre = resoudre;
  try {
    const d = JSON.parse(localStorage.getItem(CLE) || 'null');
    if (d) {
      etat.actif = !!d.actif;
      if (Array.isArray(d.modeles)) etat.modeles = new Set(d.modeles.filter(id => MODELES.some(m => m.id === id)));
      if (d.centre) etat.centre = d.centre;
      if (d.epingle && typeof d.epingle.x === 'number') etat.epingle = d.epingle;
    }
  } catch (e) {}
}

export function enregistrer() {
  try {
    localStorage.setItem(CLE, JSON.stringify({
      actif: etat.actif, modeles: [...etat.modeles], centre: etat.centre, epingle: etat.epingle,
    }));
  } catch (e) {}
}

/** Le centre courant, ou null s'il n'existe pas (jeu ferme, base supprimee). */
export function centre() {
  return sourceCentre(etat.centre);
}

/** Plus grande portee cochee, pour cadrer. */
export function porteeMax() {
  let r = 0;
  for (const m of MODELES) if (etat.modeles.has(m.id)) r = Math.max(r, m.portee);
  return r;
}

function cercle(cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = (i / SEGMENTS) * 2 * Math.PI;
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
    const sx = mondeVersEcranX(x, y), sy = mondeVersEcranY(x, y);
    if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
  }
  ctx.closePath();
}

export function dessinerRadio() {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const lp = Math.round(vue.largeur * dpr), hp = Math.round(vue.hauteur * dpr);
  if (canvas.width !== lp || canvas.height !== hp) {
    canvas.width = lp; canvas.height = hp;
    canvas.style.width = vue.largeur + 'px';
    canvas.style.height = vue.hauteur + 'px';
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, vue.largeur, vue.hauteur);
  if (!etat.actif || !etat.modeles.size) return;
  const c = centre();
  if (!c) return;

  // Du plus grand au plus petit : chaque voile ajoute une teinte, le centre
  // est donc le plus marque, la ou tous les modeles portent.
  const choisis = MODELES.filter(m => etat.modeles.has(m.id)).sort((a, b) => b.portee - a.portee);
  for (const m of choisis) {
    cercle(c.x, c.y, m.portee);
    ctx.globalAlpha = 0.07;
    ctx.fillStyle = m.couleur;
    ctx.fill();
    ctx.globalAlpha = 0.9;
    ctx.setLineDash([]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = m.couleur;
    ctx.stroke();

    cercle(c.x, c.y, m.portee * SEUIL_BROUILLAGE);
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  // Etiquettes en haut de chaque cercle (cote y negatif, le nord du jeu).
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  for (const m of choisis) {
    const sx = mondeVersEcranX(c.x, c.y - m.portee), sy = mondeVersEcranY(c.x, c.y - m.portee) - 4;
    if (sx < -200 || sx > vue.largeur + 200 || sy < 0 || sy > vue.hauteur + 20) continue;
    const texte = `${m.nom} · ${m.portee.toLocaleString('fr-FR')} cases`;
    ctx.fillStyle = m.couleur;
    ctx.strokeText(texte, sx, sy);
    ctx.fillText(texte, sx, sy);
  }

  // Le centre lui-meme, pour un point epingle ou une base hors de vue.
  const px = mondeVersEcranX(c.x, c.y), py = mondeVersEcranY(c.x, c.y);
  ctx.beginPath();
  ctx.arc(px, py, 4, 0, 2 * Math.PI);
  ctx.fillStyle = '#fff';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.8)';
  ctx.stroke();
}
