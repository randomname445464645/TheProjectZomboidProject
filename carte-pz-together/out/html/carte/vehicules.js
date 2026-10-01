// Vehicules : ceux qui sont autour de toi maintenant, et ceux deja vus.
//
// SOURCES (voir out/html/vehicules.py et outils/agent-monde)
//  - GET /api/vehicules : le releve de l'agent, toutes les 5 s. Les vehicules
//    de la zone chargee par ton client, donc ceux qui sont pres de toi : un
//    vehicule hors de cette zone n'existe pas pour le client.
//  - GET /api/vehicules?connus=1 : tout ce que l'agent a deja vu, tire de son
//    journal (premiere et derniere fois, heure reelle et heure du jeu).
//    vehicles.db, la base de la sauvegarde, n'est pas utilisee : le jeu ne la
//    tient pas a jour, ses positions etaient fausses.
//  - GET /api/vehicules/icone : le modele 3D du vehicule rendu vu de dessus
//    (la pastille) ou de 3/4 (la fiche), voir out/html/icones_vehicules.py.
//
// A L'ECRAN
// Le vehicule vu de dessus, a sa taille reelle, tourne selon son cap et peint
// de sa couleur dans le jeu. Net : il est la maintenant. Pali : vu par
// l'agent, plus dans la zone chargee depuis. Un carre de sa couleur tant que
// l'icone n'est pas arrivee, ou si son modele n'a pas pu etre rendu. Un clic
// ouvre sa fiche.

import { vue, mondeVersEcranX, mondeVersEcranY, empriseMondeVisible,
         echelle } from './vue.js';
import * as joueur from './joueur.js';

const PERIODE = 1000;           // ms, comme l'agent
const SAUT = 60;                // cases : au-dela, pas d'animation (teleportation)
const MON_VEHICULE = 4;         // cases : vehicule le plus proche de toi quand tu conduis
const PERIODE_ABSENT = 15000;   // ms quand l'agent ne repond pas
const PERIODE_CONNUS = 30000;   // ms
const PERIME = 20;              // s : au-dela, le releve n'est plus "en direct"
const CLE = 'pzcarte.vehicules';

export const etat = {
  visible: true,        // interrupteur general (Carte > Calques), au-dessus des deux suivants
  actif: true,          // carres des vehicules presents
  anciens: true,        // carres des vehicules deja vus
  direct: null,         // dernier releve {t, h, hm, jx, jy, liste}
  age: null,
  erreur: '',
  connus: new Map(),    // cle -> fiche agregee du journal
  selection: null,      // cle du vehicule dont la fiche est ouverte
};

let conteneur = null;
let rappel = () => {}, rendre = () => {};
let minuteur = 0, minuteurConnus = 0;
const elements = new Map();
let bulle = null;

export function initVehicules(element, auChangement, demanderRendu) {
  conteneur = element;
  rappel = auChangement || (() => {});
  rendre = demanderRendu || (() => {});
  try {
    const d = JSON.parse(localStorage.getItem(CLE) || 'null');
    if (d) {
      etat.visible = d.visible !== false;
      etat.actif = d.actif !== false;
      etat.anciens = d.anciens !== false;
    }
  } catch (e) {}
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { planifier(0); planifierConnus(0); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') fermerFiche(); });
  planifier(0);
  planifierConnus(0);
}

export function enregistrer() {
  try {
    localStorage.setItem(CLE, JSON.stringify({
      visible: etat.visible, actif: etat.actif, anciens: etat.anciens,
    }));
  } catch (e) {}
}

export function enDirect() {
  return etat.direct !== null && etat.age !== null && etat.age <= PERIME;
}

function planifier(ms) {
  clearTimeout(minuteur);
  minuteur = setTimeout(interroger, ms);
}

function planifierConnus(ms) {
  clearTimeout(minuteurConnus);
  minuteurConnus = setTimeout(interrogerConnus, ms);
}

async function interroger() {
  if (document.hidden) return;
  try {
    const r = await fetch('/api/vehicules', { headers: { 'X-Carte': 'vehicules' }, cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      etat.erreur = d.erreur || ('erreur ' + r.status);
      etat.age = null;
    } else {
      etat.erreur = '';
      etat.age = d.age;
      const avant = etat.direct;
      if (!avant || d.t !== avant.t) animer(d);
      etat.direct = d;
      // Un vehicule jamais vu vient d'apparaitre : le journal le connait
      // deja, autant rafraichir sa fiche tout de suite.
      if (avant && d.liste.some(v => !etat.connus.has(v.k))) planifierConnus(500);
    }
  } catch (e) {
    etat.erreur = 'serveur de la carte injoignable';
  }
  rappel();
  rendre();
  planifier(enDirect() ? PERIODE : PERIODE_ABSENT);
}

async function interrogerConnus() {
  if (document.hidden) return;
  try {
    const r = await fetch('/api/vehicules?connus=1', { headers: { 'X-Carte': 'vehicules' }, cache: 'no-store' });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.ok) {
      etat.connus = new Map(d.connus.map(f => [f.k, f]));
      rappel();
      rendre();
    }
  } catch (e) {}
  planifierConnus(PERIODE_CONNUS);
}

// --- mouvement -----------------------------------------------------------------
//
// Un releve par seconde : affiche tel quel, un vehicule qui roule saute
// d'un point a l'autre. Comme pour les joueurs (joueur.js), on glisse de la
// position precedente a la nouvelle sur la duree d'une periode, avec au plus
// une seconde de retard sur le jeu. Le cap tourne de la meme facon.
// Ton propre vehicule, lui, suit ta pastille, deja interpolee : les deux
// avancent ensemble au lieu de se decaler.

const mouvements = new Map();   // cle -> {depart, cible, debut}
let anime = false;

function animer(d) {
  const maintenant = performance.now();
  const vus = new Set();
  for (const v of d.liste) {
    vus.add(v.k);
    const cible = { x: v.x, y: v.y, cap: v.cap || null };
    const m = mouvements.get(v.k);
    if (!m) { mouvements.set(v.k, { depart: cible, cible, debut: maintenant }); continue; }
    const saut = Math.hypot(cible.x - m.cible.x, cible.y - m.cible.y);
    m.depart = saut > SAUT ? cible : interpoler(m, maintenant);
    m.cible = cible;
    m.debut = maintenant;
  }
  for (const k of mouvements.keys()) if (!vus.has(k)) mouvements.delete(k);
  if (!anime) { anime = true; requestAnimationFrame(boucle); }
}

function interpoler(m, maintenant) {
  const k = Math.min(1, (maintenant - m.debut) / PERIODE);
  const a = m.depart, b = m.cible;
  let cap = b.cap;
  if (a.cap && b.cap) {
    // Par l'angle, pour tourner du plus court cote.
    const aa = Math.atan2(a.cap[1], a.cap[0]);
    let db = Math.atan2(b.cap[1], b.cap[0]) - aa;
    db = Math.atan2(Math.sin(db), Math.cos(db));
    const r = aa + db * k;
    cap = [Math.cos(r), Math.sin(r)];
  }
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, cap };
}

/** Le vehicule que tu conduis, ou null : le plus proche de toi, a pied pres. */
function monVehicule() {
  const m = joueur.moi();
  if (!m || !m.v || !etat.direct || !joueur.enDirect()) return null;
  let meilleur = null, dmin = MON_VEHICULE;
  for (const v of etat.direct.liste) {
    const dist = Math.hypot(v.x - m.x, v.y - m.y);
    if (dist < dmin) { dmin = dist; meilleur = v.k; }
  }
  return meilleur;
}

function positionAffichee(v) {
  const m = mouvements.get(v.k);
  const p = m ? interpoler(m, performance.now()) : { x: v.x, y: v.y, cap: v.cap };
  if (v.k === monVehicule()) {
    const moi = joueur.positionMoi();
    if (moi) return { x: moi.x, y: moi.y, cap: p.cap };
  }
  return p;
}

/** Vrai si le vehicule a bouge ou tourne entre les deux releves. */
function bouge(m) {
  const a = m.depart, b = m.cible;
  if (Math.hypot(b.x - a.x, b.y - a.y) > 0.05) return true;
  if (!a.cap || !b.cap) return false;
  return Math.abs(a.cap[0] - b.cap[0]) + Math.abs(a.cap[1] - b.cap[1]) > 0.01;
}

function boucle() {
  const maintenant = performance.now();
  let encore = monVehicule() !== null;
  for (const m of mouvements.values()) {
    if (maintenant - m.debut < PERIODE && bouge(m)) {
      encore = true;
      break;
    }
  }
  rendre();
  if (encore && etat.actif) requestAnimationFrame(boucle);
  else anime = false;
}

/** Les vehicules presents, du plus proche du joueur au plus loin. */
export function presents() {
  if (!etat.direct || !enDirect()) return [];
  const { jx, jy } = etat.direct;
  return etat.direct.liste
    .map(v => ({ ...v, distance: Math.round(Math.hypot(v.x - jx, v.y - jy)) }))
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Tout ce qui se dessine : {cle, x, y, sorte, v (fiche), connu (agregat)}.
 * sorte = 'present' | 'vu'. Un vehicule present n'apparait qu'une
 * fois, avec sa fiche du releve en direct, plus fraiche que celle du journal.
 */
function aDessiner() {
  const l = [];
  if (!etat.visible) return l;
  const ici = new Set();
  if (etat.actif) {
    for (const v of presents()) {
      ici.add(v.k);
      const p = positionAffichee(v);
      l.push({ cle: v.k, x: p.x, y: p.y, sorte: 'present', v: p.cap ? { ...v, cap: p.cap } : v,
               connu: etat.connus.get(v.k) });
    }
  }
  if (etat.anciens) {
    for (const f of etat.connus.values()) {
      if (ici.has(f.k) || !f.dernier) continue;
      l.push({ cle: f.k, x: f.dernier.x, y: f.dernier.y, sorte: 'vu', v: f.fiche, connu: f });
    }
  }
  return l;
}

export function nombres() {
  const p = presents().length;
  const ici = new Set(presents().map(v => v.k));
  let vus = 0;
  for (const k of etat.connus.keys()) if (!ici.has(k)) vus++;
  return { presents: p, vus };
}

// --- couleur ------------------------------------------------------------------

/** Couleur du jeu (teinte, saturation, valeur entre 0 et 1) en CSS. */
export function couleur(c) {
  if (!Array.isArray(c)) return '#9aa3b2';
  let [h, s, v] = c;
  // La valeur est souvent tres basse (vehicules sombres) : a l'ecran le carre
  // disparaitrait sur la route. On garde la teinte, on eclaircit un peu.
  v = 0.35 + 0.65 * Math.min(1, Math.max(0, v));
  const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

// --- icones -------------------------------------------------------------------

// Le serveur rend chaque modele une fois : deux images empilees, la texture
// en haut, en bas la part de peinture (rouge) et l'eclairage (vert). La
// peinture se fait ici, avec la couleur de CHAQUE vehicule, comme le shader
// du jeu (media/shaders/vehicle_multiuv.frag) :
//   hsv = (teinte, s_tex + saturation - 0.5, v_tex + valeur - 0.5)
//   couleur = mix(texture, hsv2rgb(hsv), peinture) * eclairage
const bruts = new Map();     // 's|peau|vue' -> Promise<{donnees, l, h, longueur, largeur} | null>
const peints = new Map();    // 's|peau|vue|couleur' -> {url, longueur, largeur} | null (en cours : undefined)

function brut(s, peau, vueIcone) {
  const cle = `${s}|${peau}|${vueIcone}`;
  if (!bruts.has(cle)) {
    bruts.set(cle, (async () => {
      try {
        const r = await fetch(`/api/vehicules/icone?s=${encodeURIComponent(s)}&p=${peau}&v=${vueIcone}`,
                              { headers: { 'X-Carte': 'vehicules' } });
        if (!r.ok) return null;
        const img = await createImageBitmap(await r.blob());
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return {
          donnees: ctx.getImageData(0, 0, c.width, c.height).data,
          l: c.width, h: c.height / 2,
          longueur: parseFloat(r.headers.get('X-Longueur')) || 4.5,
          largeur: parseFloat(r.headers.get('X-Largeur')) || 2,
        };
      } catch (e) {
        return null;
      }
    })());
  }
  return bruts.get(cle);
}

function rgbHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6; if (h < 0) h += 1;
  }
  return [h, max > 0 ? d / max : 0, max];
}

function hsvRgb(h, s, v) {
  const i = Math.floor(h * 6) % 6, f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
}

/**
 * L'icone peinte, ou undefined si elle n'est pas encore prete (le rappel
 * redessine quand elle l'est), ou null si le modele n'a pas pu etre rendu.
 */
function iconePeinte(v, vueIcone) {
  if (!v || !v.s) return null;
  const c = Array.isArray(v.c) ? v.c : [0, 0.5, 0.5];
  const peau = v.skin > 0 ? v.skin : 0;
  const cle = `${v.s}|${peau}|${vueIcone}|${c.map(x => x.toFixed(2)).join(',')}`;
  if (peints.has(cle)) return peints.get(cle);
  peints.set(cle, undefined);
  brut(v.s, peau, vueIcone).then(b => {
    if (!b) { peints.set(cle, null); rendre(); return; }
    const [H, S, V] = c;
    const sortie = new ImageData(b.l, b.h);
    const o = sortie.data, d = b.donnees, bas = b.l * b.h * 4;
    for (let i = 0; i < bas; i += 4) {
      const a = d[i + 3];
      if (!a) continue;
      let r = d[i] / 255, g = d[i + 1] / 255, bl = d[i + 2] / 255;
      const peinture = d[bas + i] / 255, lum = d[bas + i + 1] / 255 * 1.2;
      if (peinture > 0) {
        const [, st, vt] = rgbHsv(r, g, bl);
        const [pr, pg, pb] = hsvRgb(H, Math.min(0.9999, Math.max(0, st + S - 0.5)),
                                       Math.min(0.9999, Math.max(0, vt + V - 0.5)));
        r += (pr - r) * peinture; g += (pg - g) * peinture; bl += (pb - bl) * peinture;
      }
      o[i] = Math.min(255, r * lum * 255);
      o[i + 1] = Math.min(255, g * lum * 255);
      o[i + 2] = Math.min(255, bl * lum * 255);
      o[i + 3] = a;
    }
    const cv = document.createElement('canvas');
    cv.width = b.l; cv.height = b.h;
    cv.getContext('2d').putImageData(sortie, 0, 0);
    peints.set(cle, { url: cv.toDataURL(), longueur: b.longueur, largeur: b.largeur });
    rendre();
    majFiche();
  });
  return undefined;
}

// --- dessin -------------------------------------------------------------------

const LONGUEUR_MIN = 18;   // px : en dessous, une voiture n'est plus lisible

export function dessinerVehicules() {
  if (!conteneur) return;
  const marge = 40 / echelle();
  const { x0, y0, x1, y1 } = empriseMondeVisible(marge);
  const pxCase = Math.hypot(mondeVersEcranX(1, 0) - mondeVersEcranX(0, 0),
                            mondeVersEcranY(1, 0) - mondeVersEcranY(0, 0));
  const gardes = new Set();
  for (const d of aDessiner()) {
    if (d.x < x0 || d.x > x1 || d.y < y0 || d.y > y1) continue;
    gardes.add(d.cle);
    let el = elements.get(d.cle);
    if (!el) {
      el = document.createElement('div');
      el.addEventListener('mousedown', e => e.stopPropagation());
      el.addEventListener('click', e => {
        e.stopPropagation();
        ouvrirFiche(el.dataset.cle);
      });
      elements.set(d.cle, el);
      conteneur.appendChild(el);
    }
    const sx = mondeVersEcranX(d.x, d.y), sy = mondeVersEcranY(d.x, d.y);
    const ic = iconePeinte(d.v, 'dessus');
    el.dataset.cle = d.cle;
    el.className = 'vh ' + d.sorte + (ic ? ' icone' : '') + (etat.selection === d.cle ? ' selection' : '');
    el.style.left = Math.round(sx) + 'px';
    el.style.top = Math.round(sy) + 'px';
    el.title = (d.v && (d.v.n || d.v.s)) || 'vehicule';
    if (ic) {
      // Taille reelle, sans descendre sous LONGUEUR_MIN pour rester visible.
      const k = Math.max(pxCase, LONGUEUR_MIN / ic.longueur);
      el.style.width = Math.round(ic.largeur * k) + 'px';
      el.style.height = Math.round(ic.longueur * k) + 'px';
      el.style.backgroundImage = `url(${ic.url})`;
      // L'icone a l'avant en haut. Le cap est un vecteur du monde : on le
      // projette comme la carte, ce qui vaut aussi en vue isometrique.
      const cap = d.v && d.v.cap;
      let angle = 0;
      if (cap && (cap[0] || cap[1])) {
        const bx = mondeVersEcranX(d.x + cap[0], d.y + cap[1]) - sx;
        const by = mondeVersEcranY(d.x + cap[0], d.y + cap[1]) - sy;
        angle = Math.atan2(by, bx) + Math.PI / 2;
      }
      el.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
      el.style.removeProperty('--teinte');
    } else {
      const cote = Math.round(Math.min(26, Math.max(9, pxCase * 4)));
      el.style.width = el.style.height = cote + 'px';
      el.style.backgroundImage = '';
      el.style.transform = '';
      el.style.setProperty('--teinte', couleur(d.v && d.v.c));
    }
  }
  for (const [cle, el] of elements) {
    if (!gardes.has(cle)) { el.remove(); elements.delete(cle); }
  }
  if (bulle && bulle.classList.contains('visible')) placerFiche();
}

// --- fiche --------------------------------------------------------------------

/** Ce que l'on sait d'un vehicule, quelle que soit sa source. */
export function trouver(cle) {
  return aDessiner().find(d => d.cle === cle)
    || (etat.connus.get(cle) && { cle, sorte: 'vu', v: etat.connus.get(cle).fiche,
                                   connu: etat.connus.get(cle),
                                   x: etat.connus.get(cle).dernier.x, y: etat.connus.get(cle).dernier.y })
    || null;
}

export function ouvrirFiche(cle) {
  etat.selection = cle;
  remplirFiche();
  rendre();
}

export function fermerFiche() {
  etat.selection = null;
  if (bulle) bulle.classList.remove('visible');
  rendre();
}

function bulleElement() {
  if (!bulle) {
    bulle = document.createElement('div');
    bulle.className = 'mq-bulle vh-bulle';
    bulle.addEventListener('mousedown', e => e.stopPropagation());
    bulle.addEventListener('wheel', e => e.stopPropagation());
    document.body.appendChild(bulle);
    // Un clic ailleurs sur la carte ferme la fiche.
    document.addEventListener('mousedown', e => {
      if (etat.selection && !bulle.contains(e.target) && !e.target.closest('.vh')) fermerFiche();
    });
  }
  return bulle;
}

function placerFiche() {
  const d = etat.selection && trouver(etat.selection);
  if (!d) { fermerFiche(); return; }
  const r = conteneur.getBoundingClientRect();
  const sx = r.left + mondeVersEcranX(d.x, d.y), sy = r.top + mondeVersEcranY(d.x, d.y);
  const b = bulle.getBoundingClientRect();
  let x = sx + 18, y = sy - 20;
  if (x + b.width > window.innerWidth - 8) x = sx - 18 - b.width;
  if (y + b.height > window.innerHeight - 8) y = window.innerHeight - 8 - b.height;
  bulle.style.left = Math.max(8, x) + 'px';
  bulle.style.top = Math.max(8, y) + 'px';
}

function quand(vu, maintenant) {
  if (!vu) return '?';
  const date = new Date(vu.t);
  const reel = date.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const il = dureeCourte((maintenant - vu.t) / 1000);
  return `${reel} (il y a ${il})` + (vu.h ? ` · en jeu ${heureJeu(vu.h)}` : '');
}

/** "1993-07-10 08:05" -> "10/07/1993 08:05" */
function heureJeu(h) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2})$/.exec(h || '');
  return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : h;
}

function dureeCourte(s) {
  if (s < 90) return Math.round(s) + ' s';
  if (s < 5400) return Math.round(s / 60) + ' min';
  if (s < 172800) return Math.round(s / 3600) + ' h';
  return Math.round(s / 86400) + ' j';
}

function pourcent(a, b) { return b > 0 ? Math.round(a / b * 100) : null; }

/** Les lignes "etiquette : valeur" d'une fiche du releve. */
function lignesEtat(v) {
  const l = [];
  if (v.etat >= 0) l.push(['etat general', v.etat + ' %']);
  if (v.moteur !== undefined) {
    l.push(['moteur', `${v.moteur} %` + (v.qualite ? ` · qualite ${v.qualite}` : '')
      + (v.puissance ? ` · ${Math.round(v.puissance / 10)} ch` : '')]);
  }
  if (v.reservoir > 0) {
    l.push(['essence', `${v.essence.toFixed(1)} / ${Math.round(v.reservoir)} L (${pourcent(v.essence, v.reservoir)} %)`]);
  } else if (v.reservoir !== undefined) {
    l.push(['essence', 'pas de reservoir']);
  }
  if (v.batterie !== undefined) l.push(['batterie', v.batterie < 0 ? 'absente' : Math.round(v.batterie * 100) + ' %']);
  if (v.pneus) l.push(['pneus', `${v.pneus[0]} / ${v.pneus[1]}`]);
  const cles = [];
  if (v.macle) cles.push('tu as la cle');
  if (v.contact) cles.push('cle sur le contact');
  if (v.porte) cles.push('cle sur la portiere');
  if (v.cable) cles.push('demarre aux fils');
  if (v.contact !== undefined) l.push(['cles', cles.length ? cles.join(', ') : 'aucune cle en vue']);
  if (v.verr !== undefined) {
    l.push(['portes', (['non verrouillees', 'certaines verrouillees', 'toutes verrouillees'][v.verr] || '?')
      + (v.coffre ? ', coffre verrouille' : '')]);
  }
  if (v.alarme) l.push(['alarme', 'oui']);
  if (v.objets !== undefined) l.push(['contenu', v.objets ? `${v.objets} objet${v.objets > 1 ? 's' : ''} recus par ton client` : 'rien de recu par ton client']);
  if (v.marche) l.push(['en marche', 'oui' + (v.vit ? ` · ${v.vit} km/h` : '')]);
  if (v.cond) l.push(['conducteur', v.cond]);
  if (v.remorque) l.push(['remorque', 'en tire une']);
  return l;
}

function remplirFiche() {
  const d = etat.selection && trouver(etat.selection);
  const b = bulleElement();
  if (!d) { b.classList.remove('visible'); return; }
  b.textContent = '';
  const v = d.v || {};
  const maintenant = Date.now();

  const titre = document.createElement('strong');
  titre.textContent = v.n || (v.s ? v.s.replace(/^Base\./, '') : 'vehicule');
  b.appendChild(titre);

  const sous = document.createElement('div');
  sous.className = 'mq-bulle-sous';
  const bouts = [];
  if (v.ty) bouts.push(v.ty);
  if (v.s) bouts.push(v.s);
  bouts.push(`x=${Math.round(d.x)} y=${Math.round(d.y)}` + (v.z >= 1 ? ` z=${Math.floor(v.z)}` : ''));
  sous.textContent = bouts.join(' · ');
  b.appendChild(sous);

  const apercu = iconePeinte(v, '34');
  if (apercu) {
    const img = document.createElement('img');
    img.className = 'vh-apercu';
    img.src = apercu.url;
    img.alt = '';
    b.appendChild(img);
  }

  const statut = document.createElement('div');
  statut.className = 'mq-bulle-attendu';
  if (d.sorte === 'present') {
    statut.textContent = `la, pres de toi · a ${v.distance ?? '?'} cases`;
  } else {
    statut.textContent = 'plus dans ta zone depuis ' + dureeCourte((maintenant - d.connu.dernier.t) / 1000)
      + ' : position et etat de ce moment-la';
  }
  b.appendChild(statut);

  const table = document.createElement('table');
  const ligne = (k, val) => {
    const tr = document.createElement('tr');
    const a = document.createElement('td'); a.className = 'vh-cle'; a.textContent = k;
    const c = document.createElement('td'); c.textContent = val;
    tr.append(a, c);
    table.appendChild(tr);
  };
  for (const [k, val] of lignesEtat(v)) ligne(k, val);

  const f = d.connu;
  if (f) {
    ligne('vu la 1re fois', quand(f.premier, maintenant));
    if (d.sorte !== 'present') ligne('vu la derniere', quand(f.dernier, maintenant));
    ligne('passages', String(f.passages)
      + (f.lieux && f.lieux.length > 1 ? ` · ${f.lieux.length} endroits differents` : ''));
  }
  if (table.rows.length) {
    const entete = document.createElement('div');
    entete.className = 'mq-bulle-entete';
    entete.textContent = d.sorte === 'present' ? 'maintenant' : 'au dernier releve';
    b.appendChild(entete);
    b.appendChild(table);
  }

  const fermer = document.createElement('button');
  fermer.className = 'mq-bulle-tout';
  fermer.textContent = 'fermer';
  fermer.addEventListener('click', fermerFiche);
  b.appendChild(fermer);

  b.classList.add('visible');
  placerFiche();
}

/** Rafraichit la fiche ouverte quand un nouveau releve arrive. */
export function majFiche() {
  if (etat.selection && bulle && bulle.classList.contains('visible')) remplirFiche();
}

/** Texte d'etat pour le panneau. */
export function texteEtat() {
  if (etat.erreur) return etat.erreur;
  if (!etat.direct) return 'en attente du premier releve...';
  if (enDirect()) return `en direct${etat.direct.h ? ' · en jeu ' + heureJeu(etat.direct.h) : ''}`;
  return `dernier releve il y a ${dureeCourte(etat.age)} (jeu ferme ou en pause ?)`;
}
