// Itineraire : trace manuel point par point, ou calcul automatique.
//
// AUTOMATIQUE
// Le calcul se fait sur une grille de cout produite hors ligne par
// outils/itineraire/construire-grille.py, un PNG en niveaux de gris par carte
// ou la valeur du pixel EST le cout de deplacement, a 8 cases par pixel.
//
// On n'utilise PAS streets/marks.json. Ces polylignes servent a poser les noms
// de rues, pas a circuler : en fusionnant les points a moins de 20 cases, on
// obtient encore 573 composantes dont la plus grosse ne couvre que 18 % des
// noeuds. Mesure faite avant d'ecrire ce module.
//
// MANUEL
// On clique des etapes, elles se relient en ligne droite. Utile pour mesurer
// une distance a vol d'oiseau ou marquer un chemin qu'on connait deja.

import { vue, echelle, mondeVersEcranX, mondeVersEcranY } from './vue.js';

const PAS = 8;              // cases par pixel de grille, fixe par le script
const COUT_MAX = 255;

// Vitesses SUPPOSEES, pas mesurees dans le jeu. Elles servent a donner un
// ordre de grandeur, et l'interface le dit.
export const VITESSES = [
  ['a pied', 1.4],
  ['en courant', 3],
  ['en voiture', 14],
];

let canvas = null, ctx = null;
let grille = null;          // { x0, y0, largeur, hauteur, cout: Uint8Array }
let chargement = null;

export const etat = {
  // Deux reglages distincts. 'mode' dit comment relier les etapes, 'pose' dit
  // si un clic sur la carte en ajoute une. Les confondre faisait qu'Echap,
  // qui coupe la pose, transformait aussi un trajet auto en ligne droite.
  mode: 'auto',             // 'auto' | 'manuel'
  pose: false,
  attenteDepart: false,     // le prochain clic devient l'etape 1, pas la derniere
  etapes: [],               // [{x, y}] poses par l'utilisateur
  trace: null,              // [{x, y}] chemin effectivement dessine
  distance: 0,              // en cases
  message: '',
  calculEnCours: false,
};

let rappelExterne = () => {};

// Le trajet survit a un rechargement : on garde le mode et les etapes, pas
// le trace, qui se recalcule. Sans ca, recharger la page effacait tout ce
// qu'on venait de planifier.
const CLE = 'pzcarte.trajet';

function auChangement() {
  try {
    localStorage.setItem(CLE, JSON.stringify({ mode: etat.mode, etapes: etat.etapes }));
    // 'pose' n'est pas garde : rouvrir la carte en mode "chaque clic ajoute
    // une etape" surprendrait.
  } catch (e) { /* navigation privee */ }
  rappelExterne();
}

export function initItineraire(element, rappel) {
  canvas = element;
  ctx = canvas.getContext('2d');
  rappelExterne = rappel || (() => {});
  try {
    const d = JSON.parse(localStorage.getItem(CLE) || 'null');
    if (d && Array.isArray(d.etapes)) {
      etat.mode = d.mode === 'manuel' ? 'manuel' : 'auto';
      etat.etapes = d.etapes
        .filter(p => p && isFinite(p.x) && isFinite(p.y))
        .map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
    }
  } catch (e) { /* valeur illisible : on repart de zero */ }
  if (etat.etapes.length) recalculer();
}

// --- grille ----------------------------------------------------------------

/** Charge les PNG de cout et les fusionne en une seule grille. */
export function chargerGrille() {
  if (grille) return Promise.resolve(grille);
  if (chargement) return chargement;
  chargement = fetch('map_data/itineraire/index.json')
    .then(r => (r.ok ? r.json() : null))
    .then(async index => {
      if (!index) throw new Error('grille absente');
      const cartes = Object.entries(index.cartes);
      if (!cartes.length) throw new Error('grille vide');
      // Emprise commune, en pixels de grille.
      let gx0 = Infinity, gy0 = Infinity, gx1 = -Infinity, gy1 = -Infinity;
      for (const [, c] of cartes) {
        const x = c.x0 / PAS, y = c.y0 / PAS;
        if (x < gx0) gx0 = x;
        if (y < gy0) gy0 = y;
        if (x + c.largeur > gx1) gx1 = x + c.largeur;
        if (y + c.hauteur > gy1) gy1 = y + c.hauteur;
      }
      const largeur = gx1 - gx0, hauteur = gy1 - gy0;
      const cout = new Uint8Array(largeur * hauteur);
      // Les cartes moddees passent apres la vanilla : elles la recouvrent,
      // comme dans le rendu.
      cartes.sort((a, b) => (a[0] === 'default' ? -1 : b[0] === 'default' ? 1 : 0));
      for (const [, c] of cartes) {
        // fetch + createImageBitmap plutot que new Image() + decode() :
        // decode() attend que la page soit peinte, et au rechargement le
        // trajet restaure restait bloque sur "calcul..." tant que rien ne
        // forcait un rendu. createImageBitmap decode hors du fil de rendu.
        const url = 'map_data/itineraire/' + c.fichier + '?v=' + (index.version || 0);
        const rep = await fetch(url);
        if (!rep.ok) throw new Error('grille ' + c.fichier + ' : ' + rep.status);
        const img = await createImageBitmap(await rep.blob());
        const cv = document.createElement('canvas');
        cv.width = c.largeur; cv.height = c.hauteur;
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0);
        const px = cx.getImageData(0, 0, c.largeur, c.hauteur).data;
        const ox = c.x0 / PAS - gx0, oy = c.y0 / PAS - gy0;
        for (let y = 0; y < c.hauteur; y++) {
          const dst = (oy + y) * largeur + ox;
          const src = y * c.largeur * 4;
          for (let x = 0; x < c.largeur; x++) {
            const v = px[src + x * 4];
            if (v) cout[dst + x] = v;
          }
        }
      }
      grille = { x0: gx0 * PAS, y0: gy0 * PAS, largeur, hauteur, cout };
      return grille;
    })
    .catch(e => { chargement = null; throw e; });
  return chargement;
}

export function grillePrete() { return !!grille; }

function indice(gx, gy) {
  if (gx < 0 || gy < 0 || gx >= grille.largeur || gy >= grille.hauteur) return -1;
  return gy * grille.largeur + gx;
}

/** Cout d'un pixel de grille, 0 si infranchissable ou hors carte. */
function coutPixel(gx, gy) {
  const i = indice(gx, gy);
  return i < 0 ? 0 : grille.cout[i];
}

/**
 * Cherche le pixel franchissable le plus proche, en spirale carree.
 * Un clic tombe souvent dans un batiment ou sur l'eau ; sans ca le calcul
 * echouerait sur un depart parfaitement legitime.
 */
function accrocher(gx, gy, rayonMax = 60) {
  if (coutPixel(gx, gy)) return [gx, gy];
  for (let r = 1; r <= rayonMax; r++) {
    for (let d = -r; d <= r; d++) {
      const essais = [[gx + d, gy - r], [gx + d, gy + r],
                      [gx - r, gy + d], [gx + r, gy + d]];
      for (const [x, y] of essais) if (coutPixel(x, y)) return [x, y];
    }
  }
  return null;
}

// --- A* --------------------------------------------------------------------

// Tas binaire minimal. Sans lui, chercher le meilleur noeud dans un tableau
// coute O(n) par iteration et le calcul prend des secondes.
class Tas {
  constructor() { this.a = []; }
  get taille() { return this.a.length; }
  pousser(cle, valeur) {
    const a = this.a;
    a.push([cle, valeur]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  tirer() {
    const a = this.a;
    const haut = a[0];
    const dernier = a.pop();
    if (a.length) {
      a[0] = dernier;
      let i = 0;
      for (;;) {
        const g = 2 * i + 1, d = g + 1;
        let m = i;
        if (g < a.length && a[g][0] < a[m][0]) m = g;
        if (d < a.length && a[d][0] < a[m][0]) m = d;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return haut;
  }
}

const VOISINS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.4142], [1, -1, 1.4142], [-1, 1, 1.4142], [-1, -1, 1.4142],
];

// Plafond d'exploration. Une destination inatteignable ferait sinon tourner
// le navigateur jusqu'a epuiser la memoire.
const NOEUDS_MAX = 1200000;

/** A* d'un point monde a un autre. Retourne [{x,y}] ou null. */
function chercher(depart, arrivee) {
  const gxa = Math.floor((depart.x - grille.x0) / PAS);
  const gya = Math.floor((depart.y - grille.y0) / PAS);
  const gxb = Math.floor((arrivee.x - grille.x0) / PAS);
  const gyb = Math.floor((arrivee.y - grille.y0) / PAS);
  const a = accrocher(gxa, gya), b = accrocher(gxb, gyb);
  if (!a) return { erreur: 'le depart n est sur aucune carte connue' };
  if (!b) return { erreur: 'l arrivee n est sur aucune carte connue' };

  const L = grille.largeur;
  const depart_i = a[1] * L + a[0], arrivee_i = b[1] * L + b[0];
  const g = new Map([[depart_i, 0]]);
  const de = new Map();
  const vus = new Set();
  const tas = new Tas();
  const h = (i) => {
    const x = i % L, y = (i / L) | 0;
    return Math.hypot(x - b[0], y - b[1]);
  };
  tas.pousser(h(depart_i), depart_i);
  let explores = 0;

  while (tas.taille) {
    const [, i] = tas.tirer();
    if (vus.has(i)) continue;
    vus.add(i);
    if (i === arrivee_i) return { chemin: remonter(de, i, L) };
    if (++explores > NOEUDS_MAX) {
      return { erreur: 'trop loin : exploration arretee a ' + NOEUDS_MAX + ' points' };
    }
    const x = i % L, y = (i / L) | 0;
    const gi = g.get(i);
    for (const [dx, dy, poids] of VOISINS) {
      const nx = x + dx, ny = y + dy;
      const c = coutPixel(nx, ny);
      if (!c) continue;
      const ni = ny * L + nx;
      if (vus.has(ni)) continue;
      const cand = gi + poids * c;
      const ancien = g.get(ni);
      if (ancien === undefined || cand < ancien) {
        g.set(ni, cand);
        de.set(ni, i);
        tas.pousser(cand + h(ni), ni);
      }
    }
  }
  return { erreur: 'aucun chemin : les deux points ne communiquent pas' };
}

function remonter(de, i, L) {
  const out = [];
  let cur = i;
  while (cur !== undefined) {
    out.push({
      x: (cur % L) * PAS + grille.x0 + PAS / 2,
      y: (((cur / L) | 0)) * PAS + grille.y0 + PAS / 2,
    });
    cur = de.get(cur);
  }
  return out.reverse();
}

/**
 * Simplifie le trace : Douglas-Peucker. Un chemin A* est un escalier de
 * pixels, 3000 points pour traverser une ville. Le dessiner tel quel coute
 * cher et ne montre rien de plus.
 */
function simplifier(points, tolerance) {
  if (points.length < 3) return points;
  const garde = new Uint8Array(points.length);
  garde[0] = garde[points.length - 1] = 1;
  const pile = [[0, points.length - 1]];
  while (pile.length) {
    const [a, b] = pile.pop();
    let pire = 0, iPire = -1;
    const ax = points[a].x, ay = points[a].y;
    const bx = points[b].x, by = points[b].y;
    const dx = bx - ax, dy = by - ay;
    const norme = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i].x - ax) * dy - (points[i].y - ay) * dx) / norme;
      if (d > pire) { pire = d; iPire = i; }
    }
    if (pire > tolerance && iPire > 0) {
      garde[iPire] = 1;
      pile.push([a, iPire], [iPire, b]);
    }
  }
  return points.filter((_, i) => garde[i]);
}

// --- pilotage ---------------------------------------------------------------

/** Choisit la facon de relier les etapes et active la pose au clic. */
export function definirMode(m) {
  const avant = etat.mode;
  etat.mode = m === 'manuel' ? 'manuel' : 'auto';
  etat.pose = true;
  if (etat.mode !== avant && etat.etapes.length > 1) {
    recalculer();
    return;
  }
  auChangement();
}

/** Coupe la pose au clic. Le trajet reste affiche tel quel. */
export function arreterPose() {
  etat.pose = false;
  etat.attenteDepart = false;
  auChangement();
}

export function vider() {
  etat.etapes = [];
  etat.trace = null;
  etat.distance = 0;
  etat.message = '';
  auChangement();
}

export function ajouterEtape(x, y) {
  const p = { x: Math.round(x), y: Math.round(y) };
  if (etat.attenteDepart) {
    etat.etapes.unshift(p);
    etat.attenteDepart = false;
    etat.pose = false;
  } else {
    etat.etapes.push(p);
  }
  recalculer();
}

/** Pose l'arrivee seule ; le prochain clic sur la carte sera le depart. */
export function attendreDepart(arrivee) {
  etat.etapes = [{ x: Math.round(arrivee.x), y: Math.round(arrivee.y) }];
  etat.attenteDepart = true;
  etat.pose = true;
  recalculer();
}

export function retirerEtape(i) {
  etat.etapes.splice(i, 1);
  recalculer();
}

export function definirEtapes(liste) {
  etat.etapes = liste.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  recalculer();
}

export async function recalculer() {
  if (etat.etapes.length < 2) {
    etat.trace = etat.etapes.length ? etat.etapes.slice() : null;
    etat.distance = 0;
    etat.message = etat.etapes.length !== 1 ? ''
      : etat.attenteDepart ? 'arrivee posee : clique ton point de depart sur la carte'
      : 'pose une deuxieme etape';
    auChangement();
    return;
  }
  if (etat.mode !== 'auto') {
    etat.trace = etat.etapes.slice();
    etat.distance = longueur(etat.trace);
    etat.message = 'ligne droite, sans tenir compte du terrain';
    auChangement();
    return;
  }
  etat.calculEnCours = true;
  etat.message = 'calcul...';
  auChangement();
  try {
    await chargerGrille();
  } catch (e) {
    etat.calculEnCours = false;
    etat.message = 'grille de deplacement absente : lance '
      + 'outils/itineraire/construire-grille.py';
    etat.trace = etat.etapes.slice();
    etat.distance = longueur(etat.trace);
    auChangement();
    return;
  }
  const morceaux = [];
  let erreur = '';
  for (let i = 1; i < etat.etapes.length; i++) {
    const r = chercher(etat.etapes[i - 1], etat.etapes[i]);
    if (r.erreur) { erreur = r.erreur; break; }
    morceaux.push(i === 1 ? r.chemin : r.chemin.slice(1));
  }
  etat.calculEnCours = false;
  if (erreur) {
    etat.message = erreur + ' (trace en ligne droite)';
    etat.trace = etat.etapes.slice();
  } else {
    const plein = [].concat(...morceaux);
    etat.trace = simplifier(plein, PAS / 2);
    etat.message = 'suit les routes quand elles aident';
  }
  etat.distance = longueur(etat.trace);
  auChangement();
}

function longueur(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return Math.round(d);
}

/** Duree estimee, en secondes, pour chaque vitesse supposee. */
export function durees() {
  return VITESSES.map(([nom, v]) => [nom, Math.round(etat.distance / v)]);
}

// --- dessin -----------------------------------------------------------------

export function dessinerItineraire() {
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
  if (!etat.trace || etat.trace.length < 1) return;

  const e = echelle();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  if (etat.trace.length > 1) {
    const chemin = new Path2D();
    for (let i = 0; i < etat.trace.length; i++) {
      const p = etat.trace[i];
      const sx = mondeVersEcranX(p.x, p.y), sy = mondeVersEcranY(p.x, p.y);
      if (i === 0) chemin.moveTo(sx, sy); else chemin.lineTo(sx, sy);
    }
    ctx.lineWidth = Math.max(5, 9 * e);
    ctx.strokeStyle = 'rgba(0,0,0,0.65)';
    ctx.stroke(chemin);
    ctx.lineWidth = Math.max(2.5, 5 * e);
    ctx.strokeStyle = etat.mode === 'auto' ? '#59b7ff' : '#ffd24a';
    if (etat.mode !== 'auto') ctx.setLineDash([10, 7]);
    ctx.stroke(chemin);
    ctx.setLineDash([]);
  }

  // Etapes : un disque numerote.
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  etat.etapes.forEach((p, i) => {
    const sx = mondeVersEcranX(p.x, p.y), sy = mondeVersEcranY(p.x, p.y);
    ctx.beginPath();
    ctx.arc(sx, sy, 9, 0, Math.PI * 2);
    ctx.fillStyle = i === 0 ? '#5fbf72'
      : (i === etat.etapes.length - 1 ? '#e8735f' : '#2b2b33');
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.fillText(String(i + 1), sx, sy + 0.5);
  });
}
