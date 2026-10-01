// Itineraire : GPS sur le reseau routier, trace manuel, routes dessinees.
//
// GPS
// Le reseau vient de outils/itineraire/construire-routes.py : un PNG ou
// chaque pixel couvre 4 x 4 cases et vaut 1 (bitume), 2 (gravier), 3 (terre)
// ou 0 (pas une route). Chaque pixel de route est un noeud, relie a ses 8
// voisins de route. Rien d'autre n'existe : le trajet ne peut ni couper un
// champ ni traverser un batiment, seulement rejoindre la route a pied depuis
// une etape posee hors chaussee, et ce bout-la est dessine en pointilles.
//
// L'ancienne grille rendait franchissables l'herbe, le sable et les sols
// interieurs, d'ou les raccourcis a travers les maisons.
//
// VILLES
// Le meme script decoupe les zones baties (densite de murs par bloc de 64
// cases) et les nomme d'apres les points d'apparition du jeu. Une ville
// evitee n'est pas interdite : ses routes coutent EVITEMENT fois plus cher.
// Une etape posee en ville reste donc atteignable, le trajet y entre
// seulement quand il n'a pas le choix.
//
// MANUEL
// On clique des etapes, elles se relient en ligne droite.
//
// ROUTES DESSINEES
// On clique les points d'une route que la carte ne connait pas (un chemin
// dans les bois, une breche dans une cloture). Une fois enregistree, elle
// entre dans le reseau et le GPS peut l'emprunter.

import { vue, echelle, mondeVersEcranX, mondeVersEcranY } from './vue.js';

const BITUME = 1, GRAVIER = 2, TERRE = 3, PERSO = 4;
// Cout par case parcourue selon la chaussee. Le bitume sert de reference.
// Le gravier et la terre sont chers expres : en ville ce sont surtout des
// allees de garage et des cours, qui mises bout a bout formaient de faux
// raccourcis a travers les jardins. A la campagne, quand il n'y a qu'eux,
// le GPS les prend quand meme.
const COUT_CLASSE = [0, 1, 2.5, 4, 1.6];
const EVITEMENT = 15;
// Rayon de recherche de la route la plus proche d'une etape, en pixels de
// reseau (4 cases). Au-dela, l'etape est vraiment loin de tout.
const RAYON_ACCROCHE = 80;

// Vitesses SUPPOSEES, pas mesurees dans le jeu. Elles servent a donner un
// ordre de grandeur, et l'interface le dit.
export const VITESSES = [
  ['a pied', 1.4],
  ['en courant', 3],
  ['en voiture', 14],
];

let canvas = null, ctx = null;
let reseau = null;
let chargement = null;

export const etat = {
  // 'mode' dit comment relier les etapes, 'pose' dit si un clic sur la carte
  // en ajoute une. Les confondre faisait qu'Echap, qui coupe la pose,
  // transformait aussi un trajet auto en ligne droite.
  mode: 'auto',             // 'auto' | 'manuel' | 'route'
  pose: false,
  attenteDepart: false,     // le prochain clic devient l'etape 1, pas la derniere
  etapes: [],               // [{x, y}] poses par l'utilisateur
  trace: null,              // [{x, y}] chemin effectivement dessine
  acces: [],                // [[{x,y},{x,y}]] bouts a pied etape -> route
  distance: 0,              // en cases
  distanceAcces: 0,         // dont hors route
  message: '',
  calculEnCours: false,
  // Evitement : noms des villes evitees.
  evitees: [],
  // Routes dessinees a la main : [{nom, points:[{x,y}]}]
  routes: [],
  brouillon: [],            // points de la route en cours de dessin
  zones: [],                // [{nom, blocs}] groupees par nom, une fois charge
  // Guidage : suit ta position en direct et recalcule si tu sors du trajet.
  guidage: false,
  prochaine: 1,             // indice de la prochaine etape a atteindre
  recalculs: 0,
  guide: '',                // dernier evenement du guidage, pour le panneau
};

// Guidage. Au-dela de HORS_TRAJET cases du trace pendant HORS_LECTURES
// lectures de suite, la sortie est consideree comme loupee. Deux lectures et
// pas une : une position lue au milieu d'un carrefour, ou une voiture qui
// coupe un virage, ne doit pas declencher de recalcul. ATTENTE_RECALCUL evite
// d'en enchainer pendant que le joueur rejoint le nouveau trace.
const HORS_TRAJET = 24;       // cases
const HORS_LECTURES = 2;
const ATTENTE_RECALCUL = 5000; // ms
const ETAPE_ATTEINTE = 16;    // cases
let horsDepuis = 0, dernierRecalcul = 0, dernierePos = null;
// Derniere position recue EN DIRECT, sinon null. Sert de depart par defaut :
// une position perimee (jeu ferme) ne doit pas devenir le depart en silence.
let posDirecte = null;

let rappelExterne = () => {};

// Le trajet survit a un rechargement : on garde le mode, les etapes, les
// villes evitees et les routes dessinees. Le trace se recalcule.
const CLE = 'pzcarte.trajet';
const CLE_ROUTES = 'pzcarte.routesPerso';

function enregistrer() {
  try {
    localStorage.setItem(CLE, JSON.stringify({
      mode: etat.mode, etapes: etat.etapes, evitees: etat.evitees,
      guidage: etat.guidage,
    }));
    localStorage.setItem(CLE_ROUTES, JSON.stringify(etat.routes));
  } catch (e) { /* navigation privee */ }
}

function auChangement() {
  enregistrer();
  rappelExterne();
}

function pointsValides(liste) {
  return (Array.isArray(liste) ? liste : [])
    .filter(p => p && isFinite(p.x) && isFinite(p.y))
    .map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
}

export function initItineraire(element, rappel) {
  canvas = element;
  ctx = canvas.getContext('2d');
  rappelExterne = rappel || (() => {});
  try {
    const d = JSON.parse(localStorage.getItem(CLE) || 'null');
    if (d) {
      etat.mode = ['manuel', 'route'].includes(d.mode) ? d.mode : 'auto';
      etat.etapes = pointsValides(d.etapes);
      etat.evitees = Array.isArray(d.evitees) ? d.evitees.filter(n => typeof n === 'string') : [];
      etat.guidage = d.guidage === true;
    }
    const r = JSON.parse(localStorage.getItem(CLE_ROUTES) || '[]');
    if (Array.isArray(r)) {
      etat.routes = r.map((x, i) => ({
        nom: typeof x.nom === 'string' ? x.nom : 'route ' + (i + 1),
        points: pointsValides(x.points),
      })).filter(x => x.points.length > 1);
    }
  } catch (e) { /* valeur illisible : on repart de zero */ }
  // Le reseau est charge tout de suite : la liste des villes en depend, et
  // le premier calcul n'attend plus.
  chargerReseau().then(() => rappelExterne()).catch(() => {});
  if (etat.etapes.length) recalculer();
}

// --- reseau ----------------------------------------------------------------

async function decoderPng(url, largeur, hauteur) {
  // fetch + createImageBitmap plutot que new Image() + decode() : decode()
  // attend que la page soit peinte, et au rechargement le trajet restaure
  // restait bloque sur "calcul..." tant que rien ne forcait un rendu.
  const rep = await fetch(url);
  if (!rep.ok) throw new Error(url + ' : ' + rep.status);
  const img = await createImageBitmap(await rep.blob());
  // Lecture par bandes : l'image entiere en RGBA ferait 90 Mo d'un coup.
  const BANDE = 256;
  const cv = document.createElement('canvas');
  cv.width = largeur; cv.height = Math.min(BANDE, hauteur);
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const out = new Uint8Array(largeur * hauteur);
  for (let y0 = 0; y0 < hauteur; y0 += BANDE) {
    const h = Math.min(BANDE, hauteur - y0);
    cx.clearRect(0, 0, largeur, cv.height);
    cx.drawImage(img, 0, -y0);
    const px = cx.getImageData(0, 0, largeur, h).data;
    for (let i = 0, n = largeur * h; i < n; i++) out[y0 * largeur + i] = px[i * 4];
  }
  img.close && img.close();
  return out;
}

/**
 * Charge le reseau et le range en tableaux compacts : les noeuds sont tries
 * par ligne puis par colonne, debutLigne[y] donne le premier noeud de la
 * ligne y. Trouver le noeud d'un pixel est une recherche dichotomique dans
 * sa ligne. Une table pixel -> noeud pleine ferait 90 Mo.
 */
export function chargerReseau() {
  if (reseau) return Promise.resolve(reseau);
  if (chargement) return chargement;
  chargement = (async () => {
    const rep = await fetch('map_data/routes/index.json', { cache: 'no-cache' });
    if (!rep.ok) throw new Error('reseau absent');
    const index = await rep.json();
    const v = '?v=' + (index.version || 0);
    const L = index.largeur, H = index.hauteur;
    const grille = await decoderPng('map_data/routes/' + index.fichier + v, L, H);
    let n = 0;
    for (let i = 0; i < grille.length; i++) if (grille[i]) n++;
    const debutLigne = new Int32Array(H + 1);
    const colonne = new Uint16Array(n);
    const classe = new Uint8Array(n);
    let k = 0;
    for (let y = 0; y < H; y++) {
      debutLigne[y] = k;
      const base = y * L;
      for (let x = 0; x < L; x++) {
        const c = grille[base + x];
        if (c) { colonne[k] = x; classe[k] = c; k++; }
      }
    }
    debutLigne[H] = k;

    const V = index.villes;
    const villes = await decoderPng('map_data/routes/' + V.fichier + v, V.largeur, V.hauteur);
    reseau = {
      pas: index.pas, x0: index.x0, y0: index.y0, L, H, n,
      debutLigne, colonne, classe,
      villes: { pas: V.pas, L: V.largeur, H: V.hauteur, ids: villes, zones: V.zones },
      // Pixels ajoutes par les routes dessinees : cle y*L+x -> id >= n.
      extra: new Map(), extraX: [], extraY: [],
      composante: null,
    };
    regrouperZones();
    integrerRoutesPerso();
    return reseau;
  })().catch(e => { chargement = null; throw e; });
  return chargement;
}

export function reseauPret() { return !!reseau; }

/** Regroupe les morceaux de ville par nom, les plus grandes d'abord. */
function regrouperZones() {
  const parNom = new Map();
  for (const z of reseau.villes.zones) {
    const g = parNom.get(z.nom) || { nom: z.nom, blocs: 0 };
    g.blocs += z.blocs;
    parNom.set(z.nom, g);
  }
  etat.zones = [...parNom.values()]
    .filter(z => z.nom !== 'zone isolee')
    .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));
  if (parNom.has('zone isolee')) etat.zones.push(parNom.get('zone isolee'));
}

/** Noeud du pixel (x, y), -1 si ce n'est pas une route. */
function noeud(x, y) {
  const R = reseau;
  if (x < 0 || y < 0 || x >= R.L || y >= R.H) return -1;
  let a = R.debutLigne[y], b = R.debutLigne[y + 1] - 1;
  const col = R.colonne;
  while (a <= b) {
    const m = (a + b) >> 1, c = col[m];
    if (c === x) return m;
    if (c < x) a = m + 1; else b = m - 1;
  }
  if (R.extra.size) {
    const e = R.extra.get(y * R.L + x);
    if (e !== undefined) return e;
  }
  return -1;
}

function px(id) { return id < reseau.n ? reseau.colonne[id] : reseau.extraX[id - reseau.n]; }
function py(id) {
  if (id >= reseau.n) return reseau.extraY[id - reseau.n];
  // Ligne d'un noeud de base : dichotomie sur debutLigne.
  const d = reseau.debutLigne;
  let a = 0, b = reseau.H - 1;
  while (a < b) {
    const m = (a + b + 1) >> 1;
    if (d[m] <= id) a = m; else b = m - 1;
  }
  return a;
}
function classeDe(id) { return id < reseau.n ? reseau.classe[id] : PERSO; }
function total() { return reseau.n + reseau.extraX.length; }

function versMonde(x, y) {
  const p = reseau.pas;
  return { x: reseau.x0 + x * p + p / 2, y: reseau.y0 + y * p + p / 2 };
}
function versPixel(m) {
  return [Math.floor((m.x - reseau.x0) / reseau.pas), Math.floor((m.y - reseau.y0) / reseau.pas)];
}

/** Nom de la ville sous un point monde, '' hors ville. */
function villeSous(xm, ym) {
  const V = reseau.villes;
  const bx = Math.floor((xm - reseau.x0) / V.pas), by = Math.floor((ym - reseau.y0) / V.pas);
  if (bx < 0 || by < 0 || bx >= V.L || by >= V.H) return '';
  const id = V.ids[by * V.L + bx];
  return id ? V.zones[id - 1].nom : '';
}

/**
 * Ajoute aux noeuds les pixels des routes dessinees. Chaque bout de route
 * qui ne touche pas la chaussee y est raccorde en ligne droite, vers la route
 * la plus proche : on dessine rarement au pixel pres, et une route qui
 * s'arrete a deux cases du bitume ne servirait a rien.
 */
function integrerRoutesPerso() {
  const R = reseau;
  R.extra = new Map(); R.extraX = []; R.extraY = [];
  R.composante = null;
  const tracer = (ax, ay, bx, by) => {
    // Bresenham a 4 voisins : pas de diagonale par un coin, comme dans A*.
    let x = ax, y = ay;
    const dx = Math.abs(bx - ax), dy = -Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
    let err = dx + dy;
    const poser = () => {
      if (x >= 0 && y >= 0 && x < R.L && y < R.H && noeud(x, y) < 0) {
        R.extra.set(y * R.L + x, R.n + R.extraX.length);
        R.extraX.push(x); R.extraY.push(y);
      }
    };
    poser();
    while (x !== bx || y !== by) {
      const e2 = 2 * err;
      if (y === by || (x !== bx && e2 - dy > dx - e2)) { err += dy; x += sx; } else { err += dx; y += sy; }
      poser();
    }
  };
  const raccords = [];
  for (const route of etat.routes) {
    const pts = route.points.map(versPixel);
    for (let i = 1; i < pts.length; i++) tracer(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    raccords.push(route.points[0], route.points[route.points.length - 1]);
  }
  for (const m of raccords) {
    const [x, y] = versPixel(m);
    let touche = false;
    for (let dy = -1; dy <= 1 && !touche; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const j = noeud(x + dx, y + dy);
        if (j >= 0 && j < R.n) { touche = true; break; }
      }
    }
    if (touche) continue;
    const j = accrocherBase(x, y);
    if (j >= 0) tracer(x, y, px(j), py(j));
  }
}

/** Noeud du reseau du jeu (hors routes dessinees) le plus proche d'un pixel. */
function accrocherBase(gx, gy) {
  let meilleur = -1, dMeilleur = Infinity;
  for (let r = 1; r <= RAYON_ACCROCHE; r++) {
    if (meilleur >= 0 && r > Math.ceil(Math.sqrt(dMeilleur)) + 1) break;
    for (let d = -r; d <= r; d++) {
      for (const [x, y] of [[gx + d, gy - r], [gx + d, gy + r], [gx - r, gy + d], [gx + r, gy + d]]) {
        const j = noeud(x, y);
        if (j < 0 || j >= reseau.n) continue;
        const dd = (x - gx) ** 2 + (y - gy) ** 2;
        if (dd < dMeilleur) { dMeilleur = dd; meilleur = j; }
      }
    }
  }
  return meilleur;
}

/** Numero de composante connexe de chaque noeud, calcule a la demande. */
function composantes() {
  const R = reseau;
  if (R.composante) return R.composante;
  const N = total();
  const comp = new Int32Array(N).fill(-1);
  const pile = new Int32Array(N);
  let c = 0;
  for (let s = 0; s < N; s++) {
    if (comp[s] >= 0) continue;
    let h = 0;
    pile[h++] = s; comp[s] = c;
    while (h) {
      const i = pile[--h];
      const x = px(i), y = py(i);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const j = noeud(x + dx, y + dy);
          if (j < 0 || comp[j] >= 0) continue;
          if (dx && dy && noeud(x + dx, y) < 0 && noeud(x, y + dy) < 0) continue;
          comp[j] = c; pile[h++] = j;
        }
      }
    }
    c++;
  }
  R.composante = comp;
  return comp;
}

/**
 * Noeud de route le plus proche d'un point monde, en anneaux carres. Avec
 * 'dans', ne retient qu'un noeud de cette composante : un depart pose pres
 * d'un bout de parking isole se raccroche alors au vrai reseau.
 */
function accrocher(m, dans = -1, rayon = RAYON_ACCROCHE) {
  const [gx, gy] = versPixel(m);
  const comp = dans >= 0 ? composantes() : null;
  let meilleur = -1, dMeilleur = Infinity;
  for (let r = 0; r <= rayon; r++) {
    // Un noeud trouve a l'anneau r peut etre battu par un noeud de l'anneau
    // r+1 plus proche en diagonale ; on finit donc l'anneau suivant.
    if (meilleur >= 0 && r > Math.ceil(Math.sqrt(dMeilleur)) + 1) break;
    for (let d = -r; d <= r; d++) {
      const essais = r === 0 ? [[gx, gy]]
        : [[gx + d, gy - r], [gx + d, gy + r], [gx - r, gy + d], [gx + r, gy + d]];
      for (const [x, y] of essais) {
        const j = noeud(x, y);
        if (j < 0 || (comp && comp[j] !== dans)) continue;
        const dd = (x - gx) ** 2 + (y - gy) ** 2;
        if (dd < dMeilleur) { dMeilleur = dd; meilleur = j; }
      }
    }
  }
  return meilleur;
}

// --- A* --------------------------------------------------------------------

// Tas binaire sur tableaux types. Sans lui, chercher le meilleur noeud coute
// O(n) par iteration et le calcul prend des secondes.
class Tas {
  constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  pousser(cle, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.n * 2); v.set(this.v); this.v = v;
    }
    const K = this.k, V = this.v;
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= cle) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = cle; V[i] = val;
  }
  tirer() {
    const K = this.k, V = this.v;
    const haut = V[0];
    const n = --this.n;
    if (n > 0) {
      const cle = K[n], val = V[n];
      let i = 0;
      for (;;) {
        let m = 2 * i + 1;
        if (m >= n) break;
        if (m + 1 < n && K[m + 1] < K[m]) m++;
        if (K[m] >= cle) break;
        K[i] = K[m]; V[i] = V[m]; i = m;
      }
      K[i] = cle; V[i] = val;
    }
    return haut;
  }
}

/** Facteur de cout de chaque noeud : chaussee et ville evitee. */
function facteurs() {
  const N = total();
  const f = new Float32Array(N);
  const evite = new Set(etat.evitees);
  const V = reseau.villes;
  const zonesEvitees = new Uint8Array(V.zones.length + 1);
  V.zones.forEach((z, i) => { if (evite.has(z.nom)) zonesEvitees[i + 1] = 1; });
  const rapport = reseau.pas / V.pas;
  for (let y = 0, id = 0; y < reseau.H; y++) {
    const fin = reseau.debutLigne[y + 1];
    const by = Math.floor(y * rapport);
    for (; id < fin; id++) {
      let c = COUT_CLASSE[reseau.classe[id]];
      if (evite.size) {
        const z = V.ids[by * V.L + Math.floor(reseau.colonne[id] * rapport)];
        if (z && zonesEvitees[z]) c *= EVITEMENT;
      }
      f[id] = c;
    }
  }
  for (let i = reseau.n; i < N; i++) f[i] = COUT_CLASSE[PERSO];
  return f;
}

/** A* entre deux noeuds. Retourne la liste des noeuds ou null. */
function chercher(a, b, f) {
  const N = total();
  const g = new Float32Array(N).fill(Infinity);
  const de = new Int32Array(N).fill(-1);
  const ferme = new Uint8Array(N);
  const tas = new Tas(4096);
  const bx = px(b), by = py(b);
  g[a] = 0;
  tas.pousser(Math.hypot(px(a) - bx, py(a) - by), a);
  while (tas.n) {
    const i = tas.tirer();
    if (ferme[i]) continue;
    ferme[i] = 1;
    if (i === b) {
      const out = [];
      for (let c = b; c >= 0; c = de[c]) out.push(c);
      return out.reverse();
    }
    const x = px(i), y = py(i), gi = g[i];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const j = noeud(x + dx, y + dy);
        if (j < 0 || ferme[j]) continue;
        // Pas de diagonale par un coin : deux allees qui se touchent par
        // l'angle ne font pas une route.
        if (dx && dy && noeud(x + dx, y) < 0 && noeud(x, y + dy) < 0) continue;
        const pas = (dx && dy) ? Math.SQRT2 : 1;
        const cand = gi + pas * 0.5 * (f[i] + f[j]);
        if (cand < g[j]) {
          g[j] = cand; de[j] = i;
          // Heuristique : distance a vol d'oiseau au cout minimal (1). Elle
          // ne surestime jamais, le chemin trouve est donc le meilleur.
          tas.pousser(cand + Math.hypot(x + dx - bx, y + dy - by), j);
        }
      }
    }
  }
  return null;
}

/** Vrai si le segment entre deux pixels reste sur la route. */
function aVue(ax, ay, bx, by) {
  const n = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2);
  for (let k = 1; k < n; k++) {
    const t = k / n;
    if (noeud(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t)) < 0) return false;
  }
  return true;
}

/**
 * Lisse l'escalier de pixels : depuis chaque point retenu, on saute au point
 * le plus lointain visible EN RESTANT SUR LA ROUTE. Un Douglas-Peucker
 * classique coupait les virages et repassait sur les bas-cotes.
 */
function lisser(ids) {
  if (ids.length < 3) return ids.map(i => [px(i), py(i)]);
  const pts = ids.map(i => [px(i), py(i)]);
  const out = [pts[0]];
  let a = 0;
  const PORTEE = 60;
  while (a < pts.length - 1) {
    let b = a + 1;
    const lim = Math.min(pts.length - 1, a + PORTEE);
    for (let j = lim; j > a + 1; j--) {
      if (aVue(pts[a][0], pts[a][1], pts[j][0], pts[j][1])) { b = j; break; }
    }
    out.push(pts[b]);
    a = b;
  }
  return out;
}

// --- pilotage ---------------------------------------------------------------

/** Choisit la facon de relier les etapes et active la pose au clic. */
export function definirMode(m) {
  const avant = etat.mode;
  etat.mode = ['manuel', 'route'].includes(m) ? m : 'auto';
  etat.pose = true;
  etat.attenteDepart = false;
  if (etat.mode !== avant && etat.mode !== 'route' && etat.etapes.length > 1) {
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
  reprendreGuidage();
  etat.etapes = [];
  etat.trace = null;
  etat.acces = [];
  etat.distance = 0;
  etat.distanceAcces = 0;
  etat.message = '';
  auChangement();
}

/** Clic sur la carte en mode pose. */
export function ajouterEtape(x, y) {
  const p = { x: Math.round(x), y: Math.round(y) };
  if (etat.mode === 'route') {
    etat.brouillon.push(p);
    auChangement();
    return;
  }
  if (!etat.etapes.length && !etat.attenteDepart && posDirecte) {
    // Premier clic avec le jeu lance : c'est l'arrivee, le depart est toi.
    etat.etapes.push({ x: Math.round(posDirecte.x), y: Math.round(posDirecte.y) }, p);
  } else if (etat.attenteDepart) {
    etat.etapes.unshift(p);
    etat.attenteDepart = false;
    etat.pose = false;
  } else {
    etat.etapes.push(p);
  }
  reprendreGuidage();
  recalculer();
}

/** Pose l'arrivee seule ; le prochain clic sur la carte sera le depart. */
export function attendreDepart(arrivee) {
  etat.etapes = [{ x: Math.round(arrivee.x), y: Math.round(arrivee.y) }];
  etat.attenteDepart = true;
  etat.pose = true;
  if (etat.mode === 'route') etat.mode = 'auto';
  recalculer();
}

/** Ta position en direct, ou null si le jeu n'envoie rien de frais. */
export function positionDirecte() { return posDirecte ? { ...posDirecte } : null; }

/**
 * Remplace le depart par ta position en direct. Avec une seule etape, celle-ci
 * devient l'arrivee. Sans position en direct, ne fait rien.
 */
export function partirDeMoi() {
  if (!posDirecte) return false;
  const moi = { x: Math.round(posDirecte.x), y: Math.round(posDirecte.y) };
  const suite = etat.etapes.length > 1 ? etat.etapes.slice(1) : etat.etapes.slice();
  etat.attenteDepart = false;
  definirEtapes([moi, ...suite]);
  return true;
}

export function retirerEtape(i) {
  etat.etapes.splice(i, 1);
  reprendreGuidage();
  recalculer();
}

export function definirEtapes(liste) {
  etat.etapes = liste.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }));
  reprendreGuidage();
  if (etat.mode === 'route') etat.mode = 'auto';
  recalculer();
}

/** Ajoute ou retire une ville de la liste des villes evitees. */
export function eviterVille(nom, oui) {
  const s = new Set(etat.evitees);
  if (oui) s.add(nom); else s.delete(nom);
  etat.evitees = [...s];
  recalculer();
}

export function eviterToutes(oui) {
  etat.evitees = oui ? etat.zones.map(z => z.nom) : [];
  recalculer();
}

// Guidage ---------------------------------------------------------------------

function reprendreGuidage() {
  etat.prochaine = 1;
  etat.recalculs = 0;
  etat.guide = '';
  horsDepuis = 0;
}

export function activerGuidage(oui) {
  etat.guidage = !!oui;
  reprendreGuidage();
  if (oui && dernierePos) suivrePosition(dernierePos, true);
  auChangement();
}

/** Distance d'un point a un segment, en cases. */
function distSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

function distTrace(p) {
  const tr = etat.trace;
  let d = Infinity;
  for (let i = 1; i < tr.length; i++) d = Math.min(d, distSegment(p, tr[i - 1], tr[i]));
  // Les bouts a pied comptent aussi : on les suit pour rejoindre la route.
  for (const [a, b] of etat.acces) d = Math.min(d, distSegment(p, a, b));
  return d;
}

/**
 * Appelee a chaque position recue du jeu. Fait avancer les etapes atteintes
 * et, si le joueur s'est ecarte du trace, recalcule depuis sa position vers
 * les etapes qui restent. Ne fait rien hors mode GPS, ni sans position en
 * direct : une position vieille de dix minutes n'a pas loupe de sortie.
 */
export function suivrePosition(p, direct) {
  if (p) dernierePos = { x: p.x, y: p.y };
  posDirecte = direct && p ? { x: p.x, y: p.y } : null;
  if (!etat.guidage || !direct || !p || etat.mode !== 'auto') return;
  if (etat.calculEnCours || !etat.trace || etat.trace.length < 2) return;
  const n = etat.etapes.length;
  if (n < 2) return;
  // Etapes atteintes : on passe a la suivante.
  while (etat.prochaine < n
         && Math.hypot(p.x - etat.etapes[etat.prochaine].x, p.y - etat.etapes[etat.prochaine].y) <= ETAPE_ATTEINTE) {
    etat.prochaine++;
    etat.guide = etat.prochaine >= n ? 'arrive a destination'
      : 'etape ' + etat.prochaine + ' atteinte';
    auChangement();
  }
  if (etat.prochaine >= n) return;
  if (distTrace(p) <= HORS_TRAJET) { horsDepuis = 0; return; }
  if (++horsDepuis < HORS_LECTURES) return;
  const maintenant = Date.now();
  if (maintenant - dernierRecalcul < ATTENTE_RECALCUL) return;
  dernierRecalcul = maintenant;
  horsDepuis = 0;
  const restantes = etat.etapes.slice(etat.prochaine);
  etat.etapes = [{ x: Math.round(p.x), y: Math.round(p.y) }, ...restantes];
  etat.prochaine = 1;
  etat.recalculs++;
  etat.guide = 'sortie loupee : itineraire recalcule depuis ta position'
    + (etat.recalculs > 1 ? ' (' + etat.recalculs + 'e fois)' : '');
  recalculer();
}

// Routes dessinees ------------------------------------------------------------

export function annulerPointBrouillon() {
  etat.brouillon.pop();
  auChangement();
}

export function abandonnerBrouillon() {
  etat.brouillon = [];
  auChangement();
}

/** Enregistre le brouillon comme route ; le GPS peut l'emprunter aussitot. */
export function enregistrerBrouillon(nom) {
  if (etat.brouillon.length < 2) return false;
  etat.routes.push({
    nom: (nom || '').trim() || 'route ' + (etat.routes.length + 1),
    points: etat.brouillon.slice(),
  });
  etat.brouillon = [];
  if (reseau) integrerRoutesPerso();
  recalculer();
  return true;
}

export function supprimerRoute(i) {
  etat.routes.splice(i, 1);
  if (reseau) integrerRoutesPerso();
  recalculer();
}

export function longueurRoute(r) { return longueur(r.points); }

// Calcul ----------------------------------------------------------------------

let numeroCalcul = 0;

export async function recalculer() {
  const numero = ++numeroCalcul;
  etat.acces = [];
  etat.distanceAcces = 0;
  if (etat.etapes.length < 2) {
    etat.trace = etat.etapes.length ? etat.etapes.slice() : null;
    etat.distance = 0;
    etat.message = etat.etapes.length !== 1 ? ''
      : etat.attenteDepart ? 'arrivee posee : clique ton point de depart sur la carte'
      : 'pose une deuxieme etape';
    auChangement();
    return;
  }
  if (etat.mode === 'manuel') {
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
    await chargerReseau();
  } catch (e) {
    etat.calculEnCours = false;
    etat.message = 'reseau routier absent : lance outils/itineraire/construire-routes.py';
    etat.trace = null;
    etat.distance = 0;
    auChangement();
    return;
  }
  // Laisse le navigateur peindre "calcul..." avant le calcul, qui bloque.
  await new Promise(r => setTimeout(r, 0));
  if (numero !== numeroCalcul) return;

  const f = facteurs();
  const comp = composantes();
  // Accroche chaque etape a la route ; toutes sur la composante de la
  // premiere qui tombe dans le grand reseau, sinon une etape posee pres d'un
  // bout de route isole rendrait tout le trajet impossible.
  let accroches = etat.etapes.map(p => accrocher(p));
  if (accroches.some(a => a < 0)) {
    finCalcul(null, 'une etape est a plus de ' + RAYON_ACCROCHE * reseau.pas
      + ' cases de toute route');
    return;
  }
  const taille = new Map();
  for (const a of accroches) taille.set(comp[a], (taille.get(comp[a]) || 0) + 1);
  if (taille.size > 1) {
    // Composante la plus grande parmi celles touchees, en nombre de noeuds.
    let cible = -1, max = -1;
    const compte = new Map();
    for (let i = 0; i < comp.length; i++) {
      if (taille.has(comp[i])) compte.set(comp[i], (compte.get(comp[i]) || 0) + 1);
    }
    for (const [c, n] of compte) if (n > max) { max = n; cible = c; }
    accroches = accroches.map((a, i) => (comp[a] === cible ? a
      : accrocher(etat.etapes[i], cible, RAYON_ACCROCHE * 3)));
    if (accroches.some(a => a < 0)) {
      finCalcul(null, 'une etape n\'est reliee au reste par aucune route');
      return;
    }
  }

  const trace = [];
  const acces = [];
  for (let i = 0; i < etat.etapes.length; i++) {
    const m = versMonde(px(accroches[i]), py(accroches[i]));
    if (Math.hypot(m.x - etat.etapes[i].x, m.y - etat.etapes[i].y) > reseau.pas) {
      acces.push([etat.etapes[i], m]);
    }
  }
  for (let i = 1; i < accroches.length; i++) {
    const ids = chercher(accroches[i - 1], accroches[i], f);
    if (!ids) { finCalcul(null, 'aucune route ne relie les etapes ' + i + ' et ' + (i + 1)); return; }
    const lisse = lisser(ids).map(([x, y]) => versMonde(x, y));
    trace.push(...(trace.length ? lisse.slice(1) : lisse));
  }
  if (numero !== numeroCalcul) return;
  etat.acces = acces;
  etat.distanceAcces = acces.reduce((s, [a, b]) => s + Math.hypot(a.x - b.x, a.y - b.y), 0);
  let villes = '';
  if (etat.evitees.length) {
    // Une ville ou l'on pose une etape est forcement traversee : on ne la
    // signale pas, seulement celles que le trajet n'a pas pu contourner.
    const chezSoi = new Set(etat.etapes.map(p => villeSous(p.x, p.y)));
    const traversees = new Set();
    for (const p of trace) {
      const v = villeSous(p.x, p.y);
      if (v && etat.evitees.includes(v) && !chezSoi.has(v)) traversees.add(v);
    }
    villes = traversees.size
      ? ' ; passe quand meme par ' + [...traversees].join(', ') + ' (contournement impossible ou trop long)'
      : ' ; villes evitees contournees';
  }
  finCalcul(trace, 'sur les routes uniquement' + villes);
}

function finCalcul(trace, message) {
  etat.calculEnCours = false;
  etat.trace = trace;
  etat.message = trace ? message : message + '. Aucun trace.';
  etat.distance = trace ? Math.round(longueur(trace) + etat.distanceAcces) : 0;
  if (!trace) { etat.acces = []; etat.distanceAcces = 0; }
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

function ligne(points) {
  const chemin = new Path2D();
  points.forEach((p, i) => {
    const sx = mondeVersEcranX(p.x, p.y), sy = mondeVersEcranY(p.x, p.y);
    if (i === 0) chemin.moveTo(sx, sy); else chemin.lineTo(sx, sy);
  });
  return chemin;
}

function trait(chemin, couleur, e, pointille) {
  ctx.lineWidth = Math.max(5, 9 * e);
  ctx.strokeStyle = 'rgba(0,0,0,0.65)';
  ctx.setLineDash(pointille ? [2, 6] : []);
  ctx.stroke(chemin);
  ctx.lineWidth = Math.max(2.5, 5 * e);
  ctx.strokeStyle = couleur;
  ctx.setLineDash(pointille ? [6, 7] : []);
  ctx.stroke(chemin);
  ctx.setLineDash([]);
}

/** Voile rouge sur les blocs des villes evitees. */
function dessinerVillesEvitees() {
  if (!reseau || !etat.evitees.length) return;
  const V = reseau.villes;
  const evite = new Set(etat.evitees);
  const ok = new Uint8Array(V.zones.length + 1);
  V.zones.forEach((z, i) => { if (evite.has(z.nom)) ok[i + 1] = 1; });
  ctx.fillStyle = 'rgba(232,90,70,0.28)';
  ctx.beginPath();
  for (let by = 0; by < V.H; by++) {
    for (let bx = 0; bx < V.L; bx++) {
      if (!ok[V.ids[by * V.L + bx]]) continue;
      const x0 = reseau.x0 + bx * V.pas, y0 = reseau.y0 + by * V.pas;
      const x1 = x0 + V.pas, y1 = y0 + V.pas;
      ctx.moveTo(mondeVersEcranX(x0, y0), mondeVersEcranY(x0, y0));
      ctx.lineTo(mondeVersEcranX(x1, y0), mondeVersEcranY(x1, y0));
      ctx.lineTo(mondeVersEcranX(x1, y1), mondeVersEcranY(x1, y1));
      ctx.lineTo(mondeVersEcranX(x0, y1), mondeVersEcranY(x0, y1));
      ctx.closePath();
    }
  }
  ctx.fill();
}

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

  const e = echelle();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  dessinerVillesEvitees();

  // Routes dessinees : toujours visibles, vert pale.
  for (const r of etat.routes) trait(ligne(r.points), '#9be37a', e * 0.7, false);
  if (etat.brouillon.length) {
    trait(ligne(etat.brouillon), '#d6ff5a', e * 0.8, true);
    for (const p of etat.brouillon) {
      ctx.beginPath();
      ctx.arc(mondeVersEcranX(p.x, p.y), mondeVersEcranY(p.x, p.y), 4, 0, Math.PI * 2);
      ctx.fillStyle = '#d6ff5a';
      ctx.fill();
    }
  }

  if (etat.trace && etat.trace.length > 1) {
    trait(ligne(etat.trace), etat.mode === 'manuel' ? '#ffd24a' : '#59b7ff', e, etat.mode === 'manuel');
  }
  // Bouts a pied entre une etape et la route.
  for (const [a, b] of etat.acces) trait(ligne([a, b]), '#e6e6e6', e * 0.6, true);

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
