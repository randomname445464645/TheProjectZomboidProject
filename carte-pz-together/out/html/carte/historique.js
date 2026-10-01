// Historique des deplacements, facon appli de suivi pour chats.
//
// Source : GET /api/traces (jours) et /api/traces?jour=... (points), que
// serveur.py lit dans ~/Zomboid/pz-export/traces/, ou l'agent Java note les
// deplacements de chacun (outils/agent-monde, classe Journal) :
//   - un point tous les 2 cases parcourues au plus ;
//   - un point a chaque changement d'etage ou de vehicule ;
//   - un point par minute a l'arret.
//
// Ce que la carte en tire :
//   - un trace par joueur, coupe la ou il manque des donnees (jeu ferme) ou la
//     ou le joueur saute (teleportation, reapparition) ;
//   - les ARRETS : au moins ARRET_MIN minutes dans un rayon de ARRET_RAYON
//     cases. Le point par minute a l'arret est la pour ca ;
//   - des statistiques sur la plage choisie, et une relecture acceleree.

import { vue, echelle, mondeVersEcranX, mondeVersEcranY, empriseMondeVisible,
         cadrerSur } from './vue.js';

const TROU = 150;            // s sans point : le jeu etait ferme, on coupe
const SAUT = 40;             // cases/s au-dela : teleportation, on coupe
const ARRET_MIN = 3;         // min
const ARRET_RAYON = 8;       // cases
const RAFRAICHIR = 30000;    // ms, pour le jour en cours
const COULEURS = ['#59b7ff', '#5fbf72', '#e0a33c', '#c98bdc', '#e8735f',
                  '#4fc3d9', '#f2d05c', '#9fe0c0', '#ff8fb1', '#b0b0ff'];

export const etat = {
  jours: [],
  jour: null,
  joueurs: [],          // [{id, n, couleur, visible, pts: [{t,x,y,z,v}], arrets}]
  debut: null,          // ms, bornes de la plage affichee
  fin: null,
  tMin: null, tMax: null,
  lecture: null,        // ms courant pendant une relecture, sinon null
  vitesse: 60,
  affiche: false,       // dessine seulement quand l'onglet est ouvert ou epingle
  erreur: '',
};

let canvas = null, ctx = null;
let rappel = () => {}, rendre = () => {};
let minuteurJour = 0, idLecture = 0, derniereImage = 0;

export function initHistorique(element, auChangement, demanderRendu) {
  canvas = element;
  ctx = canvas.getContext('2d');
  rappel = auChangement || (() => {});
  rendre = demanderRendu || (() => {});
}

export function afficher(v) {
  etat.affiche = v;
  rendre();
}

async function api(url) {
  const r = await fetch(url, { headers: { 'X-Carte': 'traces' }, cache: 'no-store' });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok) throw new Error(d.erreur || ('erreur ' + r.status));
  return d;
}

export async function chargerJours() {
  try {
    etat.jours = (await api('/api/traces')).jours;
    etat.erreur = etat.jours.length ? '' :
      "aucun deplacement enregistre : l'agent note tes trajets des que tu joues avec lui";
  } catch (e) {
    etat.erreur = e.message;
  }
  rappel();
  return etat.jours;
}

export function aujourdhui() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function chargerJour(jour, garderPlage = false) {
  clearTimeout(minuteurJour);
  let d;
  try {
    d = await api('/api/traces?jour=' + encodeURIComponent(jour));
  } catch (e) {
    etat.erreur = e.message;
    rappel();
    return;
  }
  const ancien = new Map(etat.joueurs.map(j => [j.id, j]));
  const finAuMax = etat.fin !== null && etat.fin >= (etat.tMax || 0);
  etat.jour = jour;
  etat.erreur = '';
  etat.joueurs = d.joueurs.map((j, i) => ({
    id: j.id, n: j.n,
    couleur: j.id === 'moi' ? COULEURS[0] : COULEURS[1 + (i % (COULEURS.length - 1))],
    visible: ancien.has(j.id) ? ancien.get(j.id).visible : j.id === 'moi',
    pts: [], arrets: [],
  }));
  for (const [t, k, x, y, z, v] of d.points) etat.joueurs[k].pts.push({ t, x, y, z, v });
  let tMin = Infinity, tMax = -Infinity;
  for (const j of etat.joueurs) {
    j.pts.sort((a, b) => a.t - b.t);
    j.arrets = trouverArrets(j.pts);
    if (j.pts.length) {
      tMin = Math.min(tMin, j.pts[0].t);
      tMax = Math.max(tMax, j.pts[j.pts.length - 1].t);
    }
  }
  // Si personne n'est coche (toi absent ce jour-la), on coche le premier.
  if (!etat.joueurs.some(j => j.visible) && etat.joueurs.length) etat.joueurs[0].visible = true;
  etat.tMin = isFinite(tMin) ? tMin : null;
  etat.tMax = isFinite(tMax) ? tMax : null;
  if (!garderPlage || etat.debut === null) {
    etat.debut = etat.tMin;
    etat.fin = etat.tMax;
  } else if (finAuMax) {
    etat.fin = etat.tMax;          // on suivait le bout du trace : on le suit encore
  }
  // Jour en cours : le trace s'allonge pendant que tu joues.
  if (jour === aujourdhui()) {
    minuteurJour = setTimeout(() => {
      if (etat.jour === jour && !document.hidden) chargerJour(jour, true);
    }, RAFRAICHIR);
  }
  rappel();
  rendre();
}

/**
 * Arrets : une suite de points qui restent a moins de ARRET_RAYON cases de
 * leur premier point pendant au moins ARRET_MIN minutes.
 */
function trouverArrets(pts) {
  const arrets = [];
  let i = 0;
  while (i < pts.length) {
    let k = i + 1;
    while (k < pts.length
           && pts[k].t - pts[k - 1].t <= TROU * 1000
           && Math.hypot(pts[k].x - pts[i].x, pts[k].y - pts[i].y) <= ARRET_RAYON) k++;
    const duree = (pts[k - 1].t - pts[i].t) / 60000;
    if (duree >= ARRET_MIN) {
      let sx = 0, sy = 0;
      for (let m = i; m < k; m++) { sx += pts[m].x; sy += pts[m].y; }
      arrets.push({ x: sx / (k - i), y: sy / (k - i), debut: pts[i].t, fin: pts[k - 1].t });
      i = k;
    } else {
      i++;
    }
  }
  return arrets;
}

/** Deux points consecutifs appartiennent-ils au meme trajet ? */
function continu(a, b) {
  const dt = (b.t - a.t) / 1000;
  if (dt > TROU) return false;
  return Math.hypot(b.x - a.x, b.y - a.y) / Math.max(dt, 1) <= SAUT;
}

/** Statistiques d'un joueur sur la plage affichee. */
export function stats(j) {
  const fin = etat.lecture ?? etat.fin;
  let pied = 0, vehicule = 0, bouge = 0, n = 0;
  let premier = null, dernier = null;
  for (let i = 0; i < j.pts.length; i++) {
    const p = j.pts[i];
    if (p.t < etat.debut || p.t > fin) continue;
    n++;
    if (premier === null) premier = p.t;
    dernier = p.t;
    const a = j.pts[i - 1];
    if (!a || a.t < etat.debut || !continu(a, p)) continue;
    const d = Math.hypot(p.x - a.x, p.y - a.y);
    if (p.v && a.v) vehicule += d; else pied += d;
    if (d >= 1) bouge += (p.t - a.t);
  }
  const arrets = j.arrets.filter(s => s.fin >= etat.debut && s.debut <= fin);
  return { points: n, pied: Math.round(pied), vehicule: Math.round(vehicule),
           bouge: Math.round(bouge / 1000), arrets: arrets.length, premier, dernier };
}

export function emprise() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const j of etat.joueurs) {
    if (!j.visible) continue;
    for (const p of j.pts) {
      if (p.t < etat.debut || p.t > etat.fin) continue;
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
  }
  return isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

export function cadrer() {
  const b = emprise();
  if (b) cadrerSur(b.x0, b.y0, b.x1, b.y1, 60);
  rendre();
}

// --- relecture ---------------------------------------------------------------

export function lire(vitesse) {
  if (vitesse) etat.vitesse = vitesse;
  if (etat.debut === null) return;
  if (etat.lecture === null || etat.lecture >= etat.fin) etat.lecture = etat.debut;
  derniereImage = performance.now();
  const id = ++idLecture;
  const pas = () => {
    if (id !== idLecture || etat.lecture === null) return;
    const maintenant = performance.now();
    etat.lecture += (maintenant - derniereImage) * etat.vitesse;
    derniereImage = maintenant;
    if (etat.lecture >= etat.fin) { etat.lecture = etat.fin; rappel(); rendre(); arreter(false); return; }
    rappel();
    rendre();
    requestAnimationFrame(pas);
  };
  requestAnimationFrame(pas);
}

export function arreter(effacer = true) {
  idLecture++;
  if (effacer) etat.lecture = null;
  rappel();
  rendre();
}

// --- dessin ------------------------------------------------------------------

export function dessinerHistorique() {
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
  if (!etat.affiche || etat.debut === null) return;

  const fin = etat.lecture ?? etat.fin;
  const marge = 40 / echelle();
  const { x0: vx0, y0: vy0, x1: vx1, y1: vy1 } = empriseMondeVisible(marge);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  for (const j of etat.joueurs) {
    if (!j.visible || !j.pts.length) continue;
    // Deux passes : le trace a pied, puis en vehicule en pointilles.
    for (const enVehicule of [false, true]) {
      const chemin = new Path2D();
      let ouvert = false, px = null, py = null, prec = null;
      for (const p of j.pts) {
        if (p.t < etat.debut) { prec = p; continue; }
        if (p.t > fin) break;
        // Le segment qui arrive sur p est trace dans le style de p : monter en
        // voiture ou en descendre ne laisse pas de trou dans le trace.
        const lie = prec && prec.t >= etat.debut && continu(prec, p) && (!!p.v === enVehicule);
        const dedans = p.x >= vx0 && p.x <= vx1 && p.y >= vy0 && p.y <= vy1;
        const sx = mondeVersEcranX(p.x, p.y), sy = mondeVersEcranY(p.x, p.y);
        if (lie && (dedans || (prec.x >= vx0 && prec.x <= vx1 && prec.y >= vy0 && prec.y <= vy1))) {
          if (!ouvert) {
            chemin.moveTo(mondeVersEcranX(prec.x, prec.y), mondeVersEcranY(prec.x, prec.y));
            ouvert = true;
          }
          // Decimation a l'ecran : un point a moins de 1,5 px du dernier trace
          // n'apporte rien et coute un segment.
          if (px === null || Math.abs(sx - px) + Math.abs(sy - py) >= 1.5) {
            chemin.lineTo(sx, sy);
            px = sx; py = sy;
          }
        } else {
          ouvert = false;
          px = null;
        }
        prec = p;
      }
      ctx.setLineDash(enVehicule ? [7, 6] : []);
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.stroke(chemin);
      ctx.lineWidth = 3;
      ctx.strokeStyle = j.couleur;
      ctx.stroke(chemin);
    }
    ctx.setLineDash([]);

    // Arrets : cercle et duree.
    ctx.font = '600 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const s of j.arrets) {
      if (s.fin < etat.debut || s.debut > fin) continue;
      const sx = mondeVersEcranX(s.x, s.y), sy = mondeVersEcranY(s.x, s.y);
      if (sx < -40 || sy < -40 || sx > vue.largeur + 40 || sy > vue.hauteur + 40) continue;
      const minutes = Math.round((Math.min(s.fin, fin) - s.debut) / 60000);
      ctx.beginPath();
      ctx.arc(sx, sy, 9, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20,20,24,0.85)';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = j.couleur;
      ctx.stroke();
      const txt = duree(minutes * 60);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(txt, sx, sy - 17);
      ctx.fillStyle = '#fff';
      ctx.fillText(txt, sx, sy - 17);
    }

    // Depart, et position au bout de la plage (ou de la relecture).
    const visibles = j.pts.filter(p => p.t >= etat.debut && p.t <= fin);
    if (visibles.length) {
      const a = visibles[0], b = visibles[visibles.length - 1];
      point(a, '#ffffff', j.couleur, 5);
      point(b, j.couleur, '#ffffff', etat.lecture !== null ? 8 : 6);
      if (etat.lecture !== null) {
        const sx = mondeVersEcranX(b.x, b.y), sy = mondeVersEcranY(b.x, b.y);
        const txt = (j.id === 'moi' ? 'toi' : (j.n || j.id)) + ' · ' + heure(etat.lecture);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.strokeText(txt, sx, sy + 18);
        ctx.fillStyle = '#fff';
        ctx.fillText(txt, sx, sy + 18);
      }
    }
  }
}

function point(p, fond, bord, r) {
  const sx = mondeVersEcranX(p.x, p.y), sy = mondeVersEcranY(p.x, p.y);
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fillStyle = fond;
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = bord;
  ctx.stroke();
}

export function heure(t) {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function duree(s) {
  if (s < 60) return Math.round(s) + ' s';
  if (s < 3600) return Math.round(s / 60) + ' min';
  return Math.floor(s / 3600) + ' h ' + String(Math.round((s % 3600) / 60)).padStart(2, '0');
}
