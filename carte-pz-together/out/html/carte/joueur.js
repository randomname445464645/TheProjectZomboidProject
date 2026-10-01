// Joueurs en direct : toi, et les autres que ton client connait.
//
// Source : GET /api/position, que serveur.py lit dans
// ~/Zomboid/pz-export/position.json. Ce fichier est ecrit chaque seconde par
// l'agent Java charge dans le jeu (outils/agent-monde, thread
// pz-export-position), avec l'heure a laquelle la position a ete lue.
//
// LES AUTRES
// L'agent les prend a deux endroits du jeu. Les joueurs PROCHES, que ton
// client simule, arrivent avec toutes leurs donnees ("p":1) : etage,
// orientation, vehicule. Les autres viennent de la carte du monde du jeu
// ("p":0) : position et nom seulement, et seulement si le serveur le permet
// (option MapRemotePlayerVisibility). Un joueur qui n'est dans aucune des deux
// listes n'existe pas pour ton client : il ne peut pas apparaitre ici.
//
// FLUIDITE
// Une position par seconde, c'est un saut par seconde si on l'affiche telle
// quelle. On interpole entre la position precedente et la nouvelle sur la
// duree d'une periode : pastilles et camera glissent, avec au plus une seconde
// de retard sur le jeu.
//
// DIRECTION
// En mouvement : le deplacement reel entre deux positions, qui ne peut pas
// mentir. A l'arret : l'orientation donnee par le jeu quand elle existe (toi
// et les joueurs proches), sinon la derniere direction connue.
// Convention de l'angle, lue dans le code du jeu (projectzomboid.jar) :
// IsoGameCharacter.getDirectionAngleRadians() = forwardDirection.getDirection()
// = atan2(y, x). Le vecteur en coordonnees du monde est donc (cos a, sin a).

import { vue, mondeVersEcranX, mondeVersEcranY, centrerSur } from './vue.js';

const PERIODE_FRAIS = 1000;    // ms entre deux lectures quand le jeu tourne
const PERIODE_ABSENT = 5000;   // ms quand il n'y a rien : jeu ferme, menu
const PERIME = 6;              // s : au-dela, la position n'est plus "en direct"
const SEUIL_CAP = 0.3;         // cases : en dessous, c'est un arret
const OUBLI = 120;             // s : un joueur absent des listes reste grise ce temps
const MOI = 'moi';

export const etat = {
  actif: true,        // interrogation en cours
  suivre: false,      // la camera suit quelqu'un
  cible: MOI,         // qui : MOI ou l'id reseau d'un autre joueur
  age: null,          // secondes depuis la lecture dans le jeu
  erreur: '',
  t: null,            // horodatage de la derniere lecture recue
  joueurs: new Map(), // cle (MOI ou id) -> fiche, voir fiche()
};

let conteneur = null;
let rappel = () => {}, rendre = () => {};
let minuteur = 0;
let anime = false;

export function initJoueur(element, auChangement, demanderRendu) {
  conteneur = element;
  rappel = auChangement || (() => {});
  rendre = demanderRendu || (() => {});
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && etat.actif) planifier(0);
  });
  planifier(0);
}

export function activer(v) {
  etat.actif = v;
  if (!v) { etat.suivre = false; clearTimeout(minuteur); }
  else planifier(0);
  rappel();
  rendre();
}

/** Suit un joueur (MOI par defaut), ou bascule le suivi en cours. */
export function basculerSuivi(v, cible) {
  if (cible !== undefined) etat.cible = cible;
  etat.suivre = (v === undefined) ? !etat.suivre : v;
  if (etat.suivre) {
    if (!etat.actif) activer(true);
    if (!etat.joueurs.has(etat.cible)) etat.cible = MOI;
    const p = positionCourante(etat.joueurs.get(etat.cible));
    if (p) centrerSur(p.x, p.y);
  }
  rappel();
  rendre();
}

export function enDirect() {
  return etat.t !== null && etat.age !== null && etat.age <= PERIME;
}

export function moi() { return etat.joueurs.get(MOI) || null; }

/**
 * Oublie les autres joueurs vus il y a plus de OUBLI secondes, selon
 * l'HORLOGE, pas selon les lectures : jeu ferme, plus aucune lecture
 * n'arrive, et les 28 joueurs de la derniere partie restaient affiches des
 * heures. Toi, jamais : ta derniere position reste utile.
 */
function oublierAnciens() {
  const maintenant = Date.now();
  for (const [cle, j] of etat.joueurs) {
    if (cle === MOI || (maintenant - j.vuA) / 1000 <= OUBLI) continue;
    if (j.el) j.el.remove();
    etat.joueurs.delete(cle);
    if (etat.cible === cle) { etat.cible = MOI; etat.suivre = false; }
  }
}

/** Les autres joueurs, du plus proche de toi au plus loin. */
export function autres() {
  oublierAnciens();
  const m = moi();
  const l = [...etat.joueurs.values()].filter(j => j.cle !== MOI);
  for (const j of l) j.distance = m ? Math.round(Math.hypot(j.x - m.x, j.y - m.y)) : null;
  return l.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
}

function planifier(ms) {
  clearTimeout(minuteur);
  minuteur = setTimeout(interroger, ms);
}

async function interroger() {
  if (!etat.actif) return;
  if (document.hidden) return;          // repris par visibilitychange
  try {
    const r = await fetch('/api/position', {
      headers: { 'X-Carte': 'position' }, cache: 'no-store',
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.ok) {
      etat.erreur = d.erreur || ('erreur ' + r.status);
      etat.age = null;
    } else {
      etat.erreur = '';
      etat.age = d.age;
      if (d.t !== etat.t) recevoir(d);
    }
  } catch (e) {
    etat.erreur = 'serveur de la carte injoignable';
  }
  rappel();
  rendre();
  planifier(enDirect() ? PERIODE_FRAIS : PERIODE_ABSENT);
}

/** Integre une lecture : toi, puis chaque autre joueur. */
function recevoir(d) {
  etat.t = d.t;
  mettreAJour(MOI, { n: null, x: d.x, y: d.y, z: d.z, a: d.a, v: d.v, m: d.m, p: 1 }, d.t);
  const presents = new Set([MOI]);
  for (const o of (d.autres || [])) {
    if (o == null || o.id === undefined) continue;
    const cle = 'j' + o.id;
    presents.add(cle);
    mettreAJour(cle, o, d.t);
  }
  // Absents de cette lecture : deconnexion, ou sortis de ce que ton client
  // connait. On les garde grises un moment, puis on les oublie.
  oublierAnciens();
  if (!anime) { anime = true; requestAnimationFrame(animer); }
}

function mettreAJour(cle, o, t) {
  let j = etat.joueurs.get(cle);
  const p = { x: o.x, y: o.y };
  if (!j) {
    j = { cle, id: o.id, depart: p, cible: p, debut: performance.now(), cap: null, el: null };
    etat.joueurs.set(cle, j);
  } else {
    const dx = p.x - j.cible.x, dy = p.y - j.cible.y;
    const dist = Math.hypot(dx, dy);
    if (dist >= SEUIL_CAP) j.cap = [dx, dy];
    // Un saut de plus de 60 cases (teleportation, reapparition) ne s'anime
    // pas : on y va directement.
    j.depart = dist > 60 ? p : (positionCourante(j) || j.cible);
    j.cible = p;
    j.debut = performance.now();
    j.bouge = dist >= SEUIL_CAP;
  }
  j.n = o.n ?? j.n ?? null;
  j.x = o.x; j.y = o.y;
  j.z = (o.z !== undefined) ? o.z : null;          // inconnu pour les lointains
  j.a = (o.a !== undefined) ? o.a : null;
  j.v = !!o.v; j.m = !!o.m; j.proche = o.p === 1;
  j.vuA = t;
}

/** Position affichee maintenant, interpolee entre deux lectures. */
function positionCourante(j) {
  if (!j || !j.cible) return null;
  const k = Math.min(1, (performance.now() - j.debut) / PERIODE_FRAIS);
  return { x: j.depart.x + (j.cible.x - j.depart.x) * k,
           y: j.depart.y + (j.cible.y - j.depart.y) * k };
}

function animer() {
  let encore = false;
  const maintenant = performance.now();
  for (const j of etat.joueurs.values()) if (maintenant - j.debut < PERIODE_FRAIS) encore = true;
  if (etat.suivre) {
    const p = positionCourante(etat.joueurs.get(etat.cible));
    if (p) centrerSur(p.x, p.y);
  }
  rendre();
  if (encore) requestAnimationFrame(animer);
  else anime = false;
}

/** Direction a afficher, en coordonnees du monde, ou null. */
function direction(j) {
  if (j.bouge && j.cap) return j.cap;                         // en mouvement
  if (j.a !== null && j.a !== undefined) return [Math.cos(j.a), Math.sin(j.a)];  // arret, angle du jeu
  return j.cap;                                              // arret, derniere direction
}

function creerElement(j) {
  const el = document.createElement('div');
  el.className = 'joueur' + (j.cle === MOI ? '' : ' autre');
  el.innerHTML = '<i class="halo"></i><i class="fleche"></i><b class="point"></b><span></span>';
  if (j.cle !== MOI) {
    el.title = 'Clic : suivre ce joueur';
    el.addEventListener('mousedown', e => e.stopPropagation());
    el.addEventListener('click', e => {
      e.stopPropagation();
      basculerSuivi(true, j.cle);
    });
  }
  conteneur.appendChild(el);
  return el;
}

export function dessinerJoueur() {
  if (!conteneur) return;
  oublierAnciens();
  const live = enDirect();
  for (const j of etat.joueurs.values()) {
    if (!j.el) j.el = creerElement(j);
    const el = j.el;
    const p = positionCourante(j);
    if (!etat.actif || !p) { el.hidden = true; continue; }
    el.hidden = false;
    const sx = mondeVersEcranX(p.x, p.y), sy = mondeVersEcranY(p.x, p.y);
    el.style.left = Math.round(sx) + 'px';
    el.style.top = Math.round(sy) + 'px';

    // Direction a l'ecran, par la meme projection que la carte : valable en
    // vue de dessus comme en iso.
    const d = direction(j);
    const fl = el.querySelector('.fleche');
    if (d) {
      const bx = mondeVersEcranX(p.x + d[0], p.y + d[1]) - sx;
      const by = mondeVersEcranY(p.x + d[0], p.y + d[1]) - sy;
      fl.style.transform = `rotate(${Math.atan2(by, bx)}rad)`;
      fl.hidden = false;
    } else {
      fl.hidden = true;
    }
    const absent = etat.t !== null && j.vuA !== etat.t;
    const eteint = !live || absent;
    el.classList.toggle('perime', eteint);
    el.classList.toggle('vehicule', j.v);
    el.classList.toggle('mort', j.m);
    el.classList.toggle('loin', j.cle !== MOI && !j.proche);
    el.classList.toggle('suivi', etat.suivre && etat.cible === j.cle);

    const bouts = [j.cle === MOI ? 'toi' : (j.n || 'joueur ' + j.id)];
    if (j.z !== null) {
      const z = Math.floor(j.z + 1e-3);
      if (z) bouts.push(z > 0 ? 'etage ' + z : 'sous-sol ' + (-z));
    }
    if (absent) bouts.push('vu il y a ' + dureeCourte((etat.t - j.vuA) / 1000));
    else if (!live && etat.age !== null) bouts.push(dureeCourte(etat.age));
    el.querySelector('span').textContent = bouts.join(' · ');
  }
}

/** Texte d'etat pour le panneau. */
export function texteEtat() {
  if (!etat.actif) return 'desactive';
  if (etat.erreur) return etat.erreur;
  const m = moi();
  if (!m) return 'en attente de la premiere position...';
  const ou = `x ${Math.round(m.x)} y ${Math.round(m.y)} z ${Math.floor((m.z || 0) + 1e-3)}`;
  if (enDirect()) return `en direct · ${ou}${m.v ? ' · en vehicule' : ''}`;
  return `derniere position il y a ${dureeCourte(etat.age)} · ${ou} (jeu ferme ou en pause ?)`;
}

export function nomSuivi() {
  if (!etat.suivre) return null;
  if (etat.cible === MOI) return 'toi';
  const j = etat.joueurs.get(etat.cible);
  return j ? (j.n || 'joueur ' + j.id) : null;
}

export function dureeCourte(s) {
  if (s === null || s === undefined) return '?';
  if (s < 90) return Math.round(s) + ' s';
  if (s < 5400) return Math.round(s / 60) + ' min';
  if (s < 172800) return Math.round(s / 3600) + ' h';
  return Math.round(s / 86400) + ' j';
}
