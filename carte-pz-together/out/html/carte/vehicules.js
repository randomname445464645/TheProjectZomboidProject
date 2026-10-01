// Vehicules : ceux qui sont autour de toi maintenant, et ceux deja vus.
//
// SOURCES (voir out/html/vehicules.py et outils/agent-monde)
//  - GET /api/vehicules : le releve de l'agent, toutes les 5 s. Les vehicules
//    de la zone chargee par ton client, donc ceux qui sont pres de toi : un
//    vehicule hors de cette zone n'existe pas pour le client.
//  - GET /api/vehicules?connus=1 : tout ce que l'agent a deja vu, tire de son
//    journal (premiere et derniere fois, heure reelle et heure du jeu), plus
//    les vehicules de vehicles.db, la base que le client tient dans la
//    sauvegarde, qui n'en donne que le modele et la position.
//
// A L'ECRAN
// Un carre par vehicule, de sa couleur dans le jeu. Plein : il est la
// maintenant. Creux : vu par l'agent, plus dans la zone chargee depuis.
// Pointille gris : connu seulement par vehicles.db. Un clic ouvre sa fiche.

import { vue, mondeVersEcranX, mondeVersEcranY, empriseMondeVisible,
         echelle } from './vue.js';

const PERIODE = 5000;           // ms, comme l'agent
const PERIODE_ABSENT = 15000;   // ms quand l'agent ne repond pas
const PERIODE_CONNUS = 30000;   // ms
const PERIME = 20;              // s : au-dela, le releve n'est plus "en direct"
const CLE = 'pzcarte.vehicules';

export const etat = {
  actif: true,          // carres des vehicules presents
  anciens: true,        // carres des vehicules deja vus
  amorce: true,         // carres de vehicles.db
  direct: null,         // dernier releve {t, h, hm, jx, jy, liste}
  age: null,
  erreur: '',
  connus: new Map(),    // cle -> fiche agregee du journal
  amorceListe: [],
  amorceDate: null,
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
      etat.actif = d.actif !== false;
      etat.anciens = d.anciens !== false;
      etat.amorce = d.amorce !== false;
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
      actif: etat.actif, anciens: etat.anciens, amorce: etat.amorce,
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
      etat.amorceListe = d.amorce || [];
      etat.amorceDate = d.amorce_date;
      rappel();
      rendre();
    }
  } catch (e) {}
  planifierConnus(PERIODE_CONNUS);
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
 * sorte = 'present' | 'vu' | 'amorce'. Un vehicule present n'apparait qu'une
 * fois, avec sa fiche du releve en direct, plus fraiche que celle du journal.
 */
function aDessiner() {
  const l = [];
  const ici = new Set();
  if (etat.actif) {
    for (const v of presents()) {
      ici.add(v.k);
      l.push({ cle: v.k, x: v.x, y: v.y, sorte: 'present', v, connu: etat.connus.get(v.k) });
    }
  }
  if (etat.anciens) {
    for (const f of etat.connus.values()) {
      if (ici.has(f.k) || !f.dernier) continue;
      l.push({ cle: f.k, x: f.dernier.x, y: f.dernier.y, sorte: 'vu', v: f.fiche, connu: f });
    }
  }
  if (etat.amorce) {
    for (const a of etat.amorceListe) {
      l.push({ cle: a.k, x: a.x, y: a.y, sorte: 'amorce', v: a, connu: null });
    }
  }
  return l;
}

export function nombres() {
  const p = presents().length;
  const ici = new Set(presents().map(v => v.k));
  let vus = 0;
  for (const k of etat.connus.keys()) if (!ici.has(k)) vus++;
  return { presents: p, vus, amorce: etat.amorceListe.length };
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

// --- dessin -------------------------------------------------------------------

export function dessinerVehicules() {
  if (!conteneur) return;
  const marge = 40 / echelle();
  const { x0, y0, x1, y1 } = empriseMondeVisible(marge);
  // Taille : environ la longueur d'une voiture (4 cases), entre 9 et 26 px.
  const pxCase = Math.hypot(mondeVersEcranX(1, 0) - mondeVersEcranX(0, 0),
                            mondeVersEcranY(1, 0) - mondeVersEcranY(0, 0));
  const cote = Math.round(Math.min(26, Math.max(9, pxCase * 4)));
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
    el.dataset.cle = d.cle;
    el.className = 'vehicule ' + d.sorte + (etat.selection === d.cle ? ' selection' : '');
    el.style.setProperty('--teinte', d.sorte === 'amorce' ? '#9aa3b2' : couleur(d.v && d.v.c));
    el.style.width = el.style.height = cote + 'px';
    el.style.left = Math.round(mondeVersEcranX(d.x, d.y)) + 'px';
    el.style.top = Math.round(mondeVersEcranY(d.x, d.y)) + 'px';
    el.title = (d.v && (d.v.n || d.v.s)) || 'vehicule';
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
      if (etat.selection && !bulle.contains(e.target) && !e.target.closest('.vehicule')) fermerFiche();
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

  const statut = document.createElement('div');
  statut.className = 'mq-bulle-attendu';
  if (d.sorte === 'present') {
    statut.textContent = `la, pres de toi · a ${v.distance ?? '?'} cases`;
  } else if (d.sorte === 'vu') {
    statut.textContent = 'plus dans ta zone depuis ' + dureeCourte((maintenant - d.connu.dernier.t) / 1000)
      + ' : position et etat de ce moment-la';
  } else {
    statut.textContent = 'connu par la sauvegarde de ton client (vehicles.db, ecrite le '
      + (etat.amorceDate ? new Date(etat.amorceDate).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '?')
      + '). Modele et position seulement ; il a pu bouger depuis.';
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
  if (d.sorte !== 'amorce') for (const [k, val] of lignesEtat(v)) ligne(k, val);

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
    if (d.sorte !== 'amorce') b.appendChild(entete);
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
