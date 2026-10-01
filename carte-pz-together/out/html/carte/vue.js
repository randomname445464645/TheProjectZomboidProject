// Etat de la vue et moteur de tuiles.
//
// Principe de nettete (objectif numero un) :
//  - l'echelle est TOUJOURS une puissance de deux exacte : echelle = 2^zoom.
//    Un cran de molette double ou divise par deux, jamais 1,25 ou 0,8.
//  - le niveau de pyramide est choisi pour qu'un pixel de tuile tombe sur un
//    pixel PHYSIQUE d'ecran (devicePixelRatio pris en compte).
//  - le rendu source est a 2 px par case (top_view_square_size: 2), donc la
//    pleine resolution est deja un agrandissement x2 : c'est le niveau ou
//    1 px d'image vaut 1 case qui sert de reference, pas le niveau max.
//  - aucune transformation CSS sur le conteneur : chaque tuile est positionnee
//    et dimensionnee directement en pixels CSS. Un transform: scale() sur le
//    calque force une rasterisation intermediaire qui refloute tout.
//  - image-rendering choisi a chaque rendu : pixelated seulement quand on
//    agrandit au-dela du 1:1, filtrage lisse sinon. Jamais de plus proche
//    voisin en reduction, c'est ce qui faisait fourmiller la carte.

import {
  EMPRISE, pyramidesActives, mode,
  mondeVersPlanX, mondeVersPlanY, planVersMondeX, planVersMondeY,
  niveauPour, facteurNiveau, tailleNiveau, urlTuile, tuileExiste, coteCasePlan,
} from './geometrie.js';

// Bornes de zoom par mode. Elles ne sont pas les memes parce qu'une unite de
// plan ne vaut pas la meme chose : une case en vue de dessus, un pixel de
// pyramide en iso, ou une case mesure 128 px de large. L'ecart entre les deux
// jeux de bornes est exactement l'ecartZoomModes de geometrie.js, 7 crans.
// En iso la pleine resolution est atteinte au zoom 0 : une case y mesure alors
// 64 px de cote apparent, contre 2 px seulement en vue de dessus. Le mode iso
// peut donc monter beaucoup plus haut sans rien inventer. On le laisse aller
// deux crans au-dela du 1:1, soit un agrandissement x4, le meme que celui que
// s'autorise deja la vue de dessus (source 2 px/case, maximum 8 px/case).
const BORNES = {
  dessus: { min: -6, max: 3 },    // de 1/64 a 8 px par case
  iso:    { min: -12, max: 2 },   // de 1/64 a 256 px par case
};

export function zoomMin() { return BORNES[mode].min; }
export function zoomMax() { return BORNES[mode].max; }

export const vue = {
  zoom: -2,       // echelle = 2^zoom, en px CSS par unite de plan
  panX: 0,        // position ecran (px CSS) de l'unite de plan x = 0
  panY: 0,
  largeur: 0,     // taille du viewport en px CSS
  hauteur: 0,
};

/** Echelle courante : px CSS par unite de plan. Toujours une puissance de deux. */
export function echelle() {
  return 2 ** vue.zoom;
}

/**
 * Ecran HiDPI : on monte de ceil(log2(dpr)) crans dans la pyramide pour
 * afficher a la resolution native. dpr = 2 -> une tuile dessinee a 0,5 px CSS
 * par pixel de tuile, soit exactement 1 px physique.
 */
export function boostDpr() {
  return Math.max(0, Math.ceil(Math.log2(window.devicePixelRatio || 1)));
}

// --- conversions -----------------------------------------------------------

// --- plan <-> ecran (lineaire, identique dans les deux modes) --------------
export const planVersEcranX = px => vue.panX + px * echelle();
export const planVersEcranY = py => vue.panY + py * echelle();
export const ecranVersPlanX = sx => (sx - vue.panX) / echelle();
export const ecranVersPlanY = sy => (sy - vue.panY) / echelle();

// --- monde <-> ecran (passe par le plan) -----------------------------------
// Attention, ces fonctions prennent MAINTENANT les deux coordonnees : en iso
// l'abscisse ecran depend de x ET de y. Un appel a un seul argument donnerait
// un resultat faux sans rien signaler.
export const mondeVersEcranX = (x, y) => planVersEcranX(mondeVersPlanX(x, y));
export const mondeVersEcranY = (x, y) => planVersEcranY(mondeVersPlanY(x, y));
export const ecranVersMondeX = (sx, sy) => planVersMondeX(ecranVersPlanX(sx), ecranVersPlanY(sy));
export const ecranVersMondeY = (sx, sy) => planVersMondeY(ecranVersPlanX(sx), ecranVersPlanY(sy));

/** Centre de la vue, en coordonnees monde. */
export function centreMonde() {
  const cx = vue.largeur / 2, cy = vue.hauteur / 2;
  return { x: ecranVersMondeX(cx, cy), y: ecranVersMondeY(cx, cy) };
}

/**
 * Boite englobante monde de ce qui est visible a l'ecran.
 * En iso le rectangle de l'ecran devient un losange en coordonnees monde :
 * on prend la boite de ses quatre coins, ce qui est conservateur.
 */
export function empriseMondeVisible(marge = 0) {
  const c = [[0, 0], [vue.largeur, 0], [0, vue.hauteur], [vue.largeur, vue.hauteur]];
  const xs = c.map(([a, b]) => ecranVersMondeX(a, b));
  const ys = c.map(([a, b]) => ecranVersMondeY(a, b));
  return {
    x0: Math.min(...xs) - marge, x1: Math.max(...xs) + marge,
    y0: Math.min(...ys) - marge, y1: Math.max(...ys) + marge,
  };
}

// --- deplacements ----------------------------------------------------------

/**
 * Le pan est garde en entiers de px CSS : c'est ce qui garantit que les bords
 * de tuiles tombent sur des frontieres de pixels et qu'aucune tuile n'est
 * reechantillonnee lors d'un simple deplacement.
 */
function normaliserPan() {
  vue.panX = Math.round(vue.panX);
  vue.panY = Math.round(vue.panY);
  const e = echelle();
  // On garde toujours un bout de carte a l'ecran, sans interdire le
  // debordement de Raven Creek sous la carte vanilla. EMPRISE est en unites
  // de plan, donc valable dans les deux modes.
  const marge = 200;
  const minX = -EMPRISE.x1 * e + marge, maxX = -EMPRISE.x0 * e + vue.largeur - marge;
  const minY = -EMPRISE.y1 * e + marge, maxY = -EMPRISE.y0 * e + vue.hauteur - marge;
  if (minX < maxX) vue.panX = Math.min(maxX, Math.max(minX, vue.panX));
  if (minY < maxY) vue.panY = Math.min(maxY, Math.max(minY, vue.panY));
}

export function deplacer(dxEcran, dyEcran) {
  vue.panX += dxEcran;
  vue.panY += dyEcran;
  normaliserPan();
}

/** Zoom d'un cran (+1 ou -1) en gardant fixe le point ecran (sx, sy). */
export function zoomer(delta, sx, sy) {
  const nouveau = Math.max(zoomMin(), Math.min(zoomMax(), vue.zoom + delta));
  if (nouveau === vue.zoom) return false;
  const px = ecranVersPlanX(sx), py = ecranVersPlanY(sy);
  vue.zoom = nouveau;
  const e = echelle();
  vue.panX = sx - px * e;
  vue.panY = sy - py * e;
  normaliserPan();
  return true;
}

/** Centre la vue sur une coordonnee MONDE, avec un zoom optionnel. */
export function centrerSur(x, y, zoom) {
  if (zoom !== undefined) vue.zoom = Math.max(zoomMin(), Math.min(zoomMax(), Math.round(zoom)));
  const e = echelle();
  vue.panX = vue.largeur / 2 - mondeVersPlanX(x, y) * e;
  vue.panY = vue.hauteur / 2 - mondeVersPlanY(x, y) * e;
  normaliserPan();
}

/** Plus grand palier de zoom dans lequel le rectangle monde tient entierement. */
export function cadrerSur(x0, y0, x1, y1, marge = 80) {
  const xs = [], ys = [];
  for (const [a, b] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    xs.push(mondeVersPlanX(a, b)); ys.push(mondeVersPlanY(a, b));
  }
  const w = Math.max(1, Math.max(...xs) - Math.min(...xs));
  const h = Math.max(1, Math.max(...ys) - Math.min(...ys));
  const voulu = Math.min(
    (vue.largeur - 2 * marge) / w,
    (vue.hauteur - 2 * marge) / h,
  );
  const z = Math.floor(Math.log2(Math.max(1e-6, voulu)));
  centrerSur((x0 + x1) / 2, (y0 + y1) / 2, z);
}

/** Cadre la vue sur toute l'emprise, exprimee en unites de plan. */
export function cadrerEmprise(marge = 20) {
  const w = Math.max(1, EMPRISE.x1 - EMPRISE.x0);
  const h = Math.max(1, EMPRISE.y1 - EMPRISE.y0);
  const voulu = Math.min((vue.largeur - 2 * marge) / w, (vue.hauteur - 2 * marge) / h);
  vue.zoom = Math.max(zoomMin(), Math.min(zoomMax(), Math.floor(Math.log2(Math.max(1e-9, voulu)))));
  const e = echelle();
  vue.panX = vue.largeur / 2 - ((EMPRISE.x0 + EMPRISE.x1) / 2) * e;
  vue.panY = vue.hauteur / 2 - ((EMPRISE.y0 + EMPRISE.y1) / 2) * e;
  normaliserPan();
}

// --- moteur de tuiles ------------------------------------------------------

const tuiles = new Map();   // cle -> HTMLImageElement
let conteneur = null;

export function initTuiles(element) {
  conteneur = element;
}

/**
 * Vide le cache de tuiles. Indispensable au changement de mode : les URLs, les
 * positions et les tailles changent toutes, et une tuile de l'ancien mode
 * laissee en place resterait affichee au mauvais endroit.
 */
export function viderTuiles() {
  for (const [cle, img] of tuiles) { img.remove(); tuiles.delete(cle); }
}

/**
 * Redessine toutes les tuiles visibles. Retourne le facteur de rendu courant
 * (pixels physiques d'ecran par pixel de tuile) pour information.
 */
export function dessinerTuiles() {
  const e = echelle();
  const boost = boostDpr();
  const dpr = window.devicePixelRatio || 1;
  const gardees = new Set();
  const actives = pyramidesActives();

  // Pixels physiques d'ecran par pixel de tuile. Vaut 1 quand le niveau n'est
  // pas sature et que dpr est une puissance de deux. Calcule une fois sur la
  // pyramide de base : toutes partagent le meme sqr, donc le meme comportement,
  // et cette valeur reste juste meme si la vanilla n'est pas a l'ecran.
  const reference = actives.find(p => !p.calque) || actives[0];
  const facteurRendu = reference
    ? facteurNiveau(reference, niveauPour(reference, vue.zoom, boost)) * e * dpr
    : 1;

  for (const p of actives) {
    if (p.masque) continue;             // calque decoche
    const niveau = niveauPour(p, vue.zoom, boost);
    const f = facteurNiveau(p, niveau);          // unites de plan par px d'image
    const taille = tailleNiveau(p, niveau);
    const spanPlan = p.tailleTuile * f;          // unites de plan par tuile

    // Fenetre visible, en unites de plan, ramenee dans la pyramide.
    const vx0 = Math.max(p.planX, ecranVersPlanX(0));
    const vy0 = Math.max(p.planY, ecranVersPlanY(0));
    const vx1 = Math.min(p.planX1, ecranVersPlanX(vue.largeur));
    const vy1 = Math.min(p.planY1, ecranVersPlanY(vue.hauteur));
    if (vx1 <= vx0 || vy1 <= vy0) continue;

    const tx0 = Math.floor((vx0 - p.planX) / spanPlan);
    const ty0 = Math.floor((vy0 - p.planY) / spanPlan);
    const tx1 = Math.floor((vx1 - 1e-6 - p.planX) / spanPlan);
    const ty1 = Math.floor((vy1 - 1e-6 - p.planY) / spanPlan);

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (tx < 0 || ty < 0) continue;
        if (tx * p.tailleTuile >= taille.w || ty * p.tailleTuile >= taille.h) continue;
        if (!tuileExiste(p, niveau, tx, ty)) continue;

        // La version du calque entre dans la cle : apres une synchronisation,
        // une tuile deja a l'ecran doit etre remplacee, pas gardee.
        const cle = `${p.nom}|${p.version || ''}|${niveau}|${tx}|${ty}`;
        gardees.add(cle);

        // Le dernier rang de tuiles d'un niveau est rogne : sa taille reelle
        // en pixels d'image est inferieure a p.tailleTuile, ne pas l'etirer.
        const largeurImg = Math.min(p.tailleTuile, taille.w - tx * p.tailleTuile);
        const hauteurImg = Math.min(p.tailleTuile, taille.h - ty * p.tailleTuile);
        const gauche = vue.panX + (p.planX + tx * spanPlan) * e;
        const haut = vue.panY + (p.planY + ty * spanPlan) * e;

        let img = tuiles.get(cle);
        if (!img) {
          img = new Image();
          img.draggable = false;          // sinon le navigateur lance son
          img.className = 'tuile';        // glisser-deposer natif et le pan
          img.alt = '';                   // se bloque
          img.decoding = 'async';
          // Le calque des constructions passe devant les cartes, qui passent
          // elles-memes devant la vanilla.
          img.style.zIndex = p.calque ? 3 : (p.mod ? 2 : 1);
          img.src = urlTuile(p, niveau, tx, ty);
          img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
          tuiles.set(cle, img);
          conteneur.appendChild(img);
        }
        img.style.left = gauche + 'px';
        img.style.top = haut + 'px';
        img.style.width = (largeurImg * f * e) + 'px';
        img.style.height = (hauteurImg * f * e) + 'px';
      }
    }
  }

  for (const [cle, img] of tuiles) {
    if (!gardees.has(cle)) { img.remove(); tuiles.delete(cle); }
  }

  // pixelated uniquement en agrandissement : en reduction le plus proche
  // voisin jette des pixels et produit le fourmillement.
  conteneur.classList.toggle('net', facteurRendu > 1.001);
  return facteurRendu;
}

/** Diagnostic : etat du rendu, utilise par le bandeau d'information. */
export function infoRendu() {
  const boost = boostDpr();
  const dpr = window.devicePixelRatio || 1;
  const base = pyramidesActives()[0];
  if (!base) return null;
  const niveau = niveauPour(base, vue.zoom, boost);
  const f = facteurNiveau(base, niveau);
  // Cote apparent d'une case, en px CSS : la seule grandeur comparable entre
  // les deux modes. Voir coteCasePlan dans geometrie.js.
  const tailleCase = coteCasePlan() * echelle();
  return {
    zoom: vue.zoom,
    mode,
    tailleCase,
    echelle: echelle(),
    niveau,
    niveauMax: base.niveauMax,
    sqr: base.sqr,
    dpr,
    facteurRendu: f * echelle() * dpr,
    tuiles: tuiles.size,
  };
}
