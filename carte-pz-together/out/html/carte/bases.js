// Bases posees par le joueur.
//
// Rien a voir avec markers.json, qui est extrait du jeu et regenere a chaque
// passage de l'extracteur. Une base est une donnee de l'utilisateur : elle vit
// dans localStorage, elle ne part pas avec un nouveau rendu, et elle n'est
// jamais ecrasee par un outil.
//
// Elles ont leur propre couche DOM, au-dessus des pastilles : une base doit
// rester trouvable meme au milieu d'un paquet de marqueurs.

import { vue, mondeVersEcranX, mondeVersEcranY, empriseMondeVisible,
         echelle } from './vue.js';

const CLE = 'pzcarte.bases';

export const COULEURS = [
  ['#4fc3d9', 'bleu'], ['#8fd14f', 'vert'], ['#e0a33c', 'orange'],
  ['#e8735f', 'rouge'], ['#c98bdc', 'violet'], ['#e8e8ea', 'blanc'],
];

export const etat = {
  liste: [],            // [{id, nom, x, y, z, couleur, note}]
  visible: true,
  pose: false,          // true = le prochain clic sur la carte pose une base
  selection: null,      // id
};

let conteneur = null;
let auChangement = () => {};
const elements = new Map();

export function initBases(element, rappel) {
  conteneur = element;
  auChangement = rappel || (() => {});
  charger();
}

function charger() {
  try {
    const brut = localStorage.getItem(CLE);
    etat.liste = brut ? JSON.parse(brut) : [];
  } catch (e) {
    etat.liste = [];
  }
  if (!Array.isArray(etat.liste)) etat.liste = [];
}

function enregistrer() {
  try {
    localStorage.setItem(CLE, JSON.stringify(etat.liste));
  } catch (e) { /* navigation privee : on garde en memoire seulement */ }
}

export function ajouter(x, y, z, nom) {
  const base = {
    id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    nom: nom || 'Base ' + (etat.liste.length + 1),
    x: Math.round(x), y: Math.round(y), z: z || 0,
    couleur: COULEURS[etat.liste.length % COULEURS.length][0],
    note: '',
  };
  etat.liste.push(base);
  enregistrer();
  auChangement();
  return base;
}

export function modifier(id, champs) {
  const b = etat.liste.find(v => v.id === id);
  if (!b) return;
  Object.assign(b, champs);
  enregistrer();
  auChangement();
}

export function supprimer(id) {
  const i = etat.liste.findIndex(v => v.id === id);
  if (i < 0) return;
  etat.liste.splice(i, 1);
  const el = elements.get(id);
  if (el) { el.remove(); elements.delete(id); }
  if (etat.selection === id) etat.selection = null;
  enregistrer();
  auChangement();
}

export function trouver(id) {
  return etat.liste.find(v => v.id === id) || null;
}

/** Export/import en JSON, pour passer ses bases d'une machine a l'autre. */
export function exporterJSON() {
  return JSON.stringify(etat.liste, null, 2);
}

export function importerJSON(texte) {
  const d = JSON.parse(texte);
  if (!Array.isArray(d)) throw new Error('ce n est pas une liste de bases');
  const vus = new Set(etat.liste.map(b => b.id));
  let ajoutees = 0;
  for (const b of d) {
    if (typeof b.x !== 'number' || typeof b.y !== 'number') continue;
    if (vus.has(b.id)) continue;
    etat.liste.push({
      id: b.id || ('b' + Math.random().toString(36).slice(2, 10)),
      nom: String(b.nom || 'Base'),
      x: Math.round(b.x), y: Math.round(b.y), z: b.z || 0,
      couleur: b.couleur || COULEURS[0][0],
      note: String(b.note || ''),
    });
    ajoutees++;
  }
  enregistrer();
  auChangement();
  return ajoutees;
}

export function dessinerBases() {
  if (!conteneur) return;
  const marge = 60 / echelle();
  const { x0, y0, x1, y1 } = empriseMondeVisible(marge);
  const gardes = new Set();
  if (etat.visible) {
    for (const b of etat.liste) {
      if (b.x < x0 || b.x > x1 || b.y < y0 || b.y > y1) continue;
      gardes.add(b.id);
      let el = elements.get(b.id);
      if (!el) {
        el = creer(b);
        elements.set(b.id, el);
        conteneur.appendChild(el);
      }
      el.querySelector('span').textContent = b.nom;
      el.querySelector('i').style.borderColor = b.couleur;
      el.classList.toggle('selection', etat.selection === b.id);
      el.style.left = Math.round(mondeVersEcranX(b.x, b.y)) + 'px';
      el.style.top = Math.round(mondeVersEcranY(b.x, b.y)) + 'px';
    }
  }
  for (const [id, el] of elements) {
    if (!gardes.has(id)) { el.remove(); elements.delete(id); }
  }
}

function creer(b) {
  const el = document.createElement('div');
  el.className = 'base';
  el.dataset.id = b.id;
  el.innerHTML = '<i></i><span></span>';
  el.addEventListener('mousedown', e => e.stopPropagation());
  el.addEventListener('click', e => {
    e.stopPropagation();
    etat.selection = b.id;
    auChangement();
  });
  return el;
}
