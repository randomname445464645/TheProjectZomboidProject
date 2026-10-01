// Chargement, filtrage, affichage et liste des marqueurs.
//
// markers.json contient 2212 entrees {x, y, z, cat, t, d}, en coordonnees
// MONDE (celles que le jeu affiche). Verifie contre rooms/marks.json de
// pzmap2dzi : les rectangles de pieces tombent exactement sur les batiments,
// et les marqueurs tombent dans les bonnes pieces.
//
// Placement : la pastille est centree EXACTEMENT sur la case. L'ancien viewer
// utilisait translate(-50%, -100%) sur un bloc dont la hauteur variait avec
// l'etiquette, ce qui remontait l'icone d'une demi-pastille plus la hauteur du
// texte, et la faisait sauter quand les etiquettes apparaissaient.

import { vue, echelle, mondeVersEcranX, mondeVersEcranY, centreMonde,
         empriseMondeVisible } from './vue.js';
import * as loot from './loot.js';
import { initTableLoot, ouvrirPiece, ouvrirContenant } from './loot-table.js';

const VERSION_ICONES = 4;   // le cache des icones est tenace, on le contourne

// Ordre d'affichage dans le panneau et libelles francais.
export const CATEGORIES = [
  { cle: 'top',     nom: 'loot exceptionnel',  couleur: '#ff4d3d' },
  { cle: 'or',      nom: 'or',                 couleur: '#d8a24a' },
  { cle: 'billets', nom: 'billets',            couleur: '#5fbf72' },
  { cle: 'valeur',  nom: 'banques, bijoux',    couleur: '#c98bdc' },
  { cle: 'metal',   nom: 'métal, plaques',     couleur: '#8fa8bf' },
  { cle: 'armes',   nom: 'armes, militaire',   couleur: '#d05a4a' },
  { cle: 'medical', nom: 'medical',            couleur: '#e86f9e' },
  { cle: 'outils',  nom: 'outils, quincaille', couleur: '#e0a33c' },
  { cle: 'bouffe',  nom: 'nourriture',         couleur: '#8fd14f' },
  { cle: 'essence', nom: 'essence',            couleur: '#4fc3d9' },
  { cle: 'labo',    nom: 'laboratoires',       couleur: '#9fe0c0' },
];

// Categories cochees a la premiere ouverture : les rares, sinon l'ecran est
// noir de pastilles.
const FILTRES_DEFAUT = ['top', 'or', 'billets', 'valeur', 'metal', 'armes'];

// Les etiquettes se chevauchent vite dans les zones denses : on ne les affiche
// en masse qu'a partir de 4 px par case. Les categories rares (201 marqueurs en
// tout) restent nommees bien plus tot, c'est le cas ou on veut lire le nom.
const ZOOM_ETIQUETTES = 2;
const ZOOM_ETIQUETTES_RARES = -1;
const CATEGORIES_RARES = new Set(['top', 'or', 'billets']);

// Priorite de dessin. L'ordre de CATEGORIES va du plus rare au plus courant :
// 'top' (24 marqueurs), 'or' (79), 'billets' (98)... 'labo' (76). On s'en sert
// comme z-index.
//
// Necessaire parce que 117 positions portent plusieurs marqueurs exactement aux
// memes coordonnees, dont 109 paires or + valeur et 21 billets + valeur.
// Sans priorite c'est l'ordre du fichier qui tranche, et 'valeur' (155
// entrees) y arrive apres, donc masque systematiquement la categorie rare.
// Exemple : le labo de drogue en x=11617 y=9294, ou le butin de billets
// disparaissait sous la pastille de la piece.
const PRIORITE = new Map(CATEGORIES.map((c, i) => [c.cle, CATEGORIES.length - i]));

// Doublons de position. 117 endroits portent plusieurs marqueurs aux memes
// coordonnees exactes : on les ecarte lateralement et on pose derriere eux une
// boite noire translucide, pour qu'on voie d'un coup d'oeil qu'il y en a
// plusieurs et lesquels.
const ECART_DOUBLON = 32;   // distance entre CENTRES ; la pastille fait 30 px
                            // bordure comprise, 32 laisse donc 2 px de jour
const MARGE_BOITE = 5;      // px autour du groupe
const boites = new Map();   // cle de position -> element de la boite

export const etat = {
  tous: [],           // tous les marqueurs, dans l'ordre du fichier
  filtres: {},        // cle de categorie -> booleen
  selection: -1,      // index du marqueur selectionne, -1 si aucun
  compteurs: {},      // cle -> nombre total
  visibles: 0,        // nombre effectivement dessine au dernier rendu
};

let conteneur = null;
const elements = new Map();     // index de marqueur -> element DOM
let auClic = () => {};
// Branche par app.js : marqueurs.js ne connait ni les bases ni le trajet.
let actionTrajet = null;
export function definirActionTrajet(fn) { actionTrajet = fn; }

// Piece -> objets qui peuvent y apparaitre, produit par
// outils/marqueurs/extraire-loot.py depuis les tables de loot du jeu.
// 309 Ko, charge en parallele des marqueurs. L'infobulle s'en passe s'il
// manque : elle affiche juste le nom et les coordonnees, comme avant. Le
// detail complet est dans loot-tables.json, 1,1 Mo, charge seulement quand on
// ouvre la fenetre (voir loot-table.js).
let loots = null;
// Le nom de piece est le premier champ de la description : "gunstore · 10x5 ·
// vanilla". Les marqueurs ecrits a la main ne suivent pas ce format, ils
// portent le nom dans un champ 'p' que l'extracteur leur recopie depuis le
// marqueur extrait tombant sur la meme case. Sans ca le labo de drogue en
// 11617,9294 n'avait pas de table alors que la piece est connue.
const NOM_PIECE = /^([A-Za-z0-9_]+) · \d+x\d+ · /;

function nomPiece(m) {
  if (m.p) return m.p;
  const c = NOM_PIECE.exec(m.d || '');
  return c ? c[1] : null;
}

export function initMarqueurs(element, rappelClic) {
  conteneur = element;
  auClic = rappelClic || (() => {});
}

export async function chargerMarqueurs(url = 'markers.json') {
  const reponse = await fetch(url);
  if (!reponse.ok) throw new Error('markers.json introuvable (' + reponse.status + ')');
  etat.tous = await reponse.json();

  for (const c of CATEGORIES) etat.compteurs[c.cle] = 0;
  for (const m of etat.tous) {
    etat.compteurs[m.cat] = (etat.compteurs[m.cat] || 0) + 1;
  }

  fetch('carte/loot-pieces.json')
    .then(r => (r.ok ? r.json() : null))
    .then(d => { loots = d; initTableLoot(d); })
    .catch(() => { loots = null; });

  // Une categorie absente de la sauvegarde est une categorie AJOUTEE depuis :
  // elle prend sa valeur par defaut. Sans ca, 'metal' serait restee decochee
  // chez tous ceux qui avaient deja ouvert la carte.
  const sauvegarde = lireFiltres();
  for (const c of CATEGORIES) {
    etat.filtres[c.cle] = (sauvegarde && c.cle in sauvegarde)
      ? !!sauvegarde[c.cle]
      : FILTRES_DEFAUT.includes(c.cle);
  }
  return etat.tous;
}

function lireFiltres() {
  try {
    const brut = localStorage.getItem('pzcarte.filtres');
    return brut ? JSON.parse(brut) : null;
  } catch (e) { return null; }
}

export function enregistrerFiltres() {
  try {
    localStorage.setItem('pzcarte.filtres', JSON.stringify(etat.filtres));
  } catch (e) { /* mode navigation privee, on ignore */ }
}

export function nombreActifs() {
  let n = 0;
  for (const c of CATEGORIES) if (etat.filtres[c.cle]) n += etat.compteurs[c.cle] || 0;
  return n;
}

/** Bornes monde des marqueurs actuellement filtres, ou null. */
export function empriseActifs() {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of etat.tous) {
    if (!etat.filtres[m.cat]) continue;
    if (m.x < x0) x0 = m.x;
    if (m.x > x1) x1 = m.x;
    if (m.y < y0) y0 = m.y;
    if (m.y > y1) y1 = m.y;
  }
  return x1 < x0 ? null : { x0, y0, x1, y1 };
}

// Infobulle. Une seule bulle pour toute la carte, posee sur le body en
// position fixe : l'attribut title natif met une seconde a sortir et ne sait
// pas mettre un tableau en forme, ce qui va mal avec quinze lignes d'objets.
let bulle = null;
let minuterieBulle = 0;

// La bulle porte des boutons, donc elle doit recevoir la souris. Mais elle
// est posee A COTE de la pastille, avec un jour de 10 px : quitter la
// pastille pour aller dans la bulle traverse le vide et declencherait la
// fermeture. D'ou le sursis, annule des que la souris arrive dans la bulle.
const SURSIS_BULLE = 260;   // ms

function bulleElement() {
  if (!bulle) {
    bulle = document.createElement('div');
    bulle.className = 'mq-bulle';
    bulle.addEventListener('mouseenter', () => clearTimeout(minuterieBulle));
    bulle.addEventListener('mouseleave', cacherBulle);
    // La carte se deplace au glisser : un clic dans la bulle ne doit pas
    // partir dans le fond de carte.
    bulle.addEventListener('mousedown', e => e.stopPropagation());
    bulle.addEventListener('wheel', e => e.stopPropagation());
    document.body.appendChild(bulle);
  }
  return bulle;
}

function cacherBulle() {
  clearTimeout(minuterieBulle);
  if (bulle) bulle.classList.remove('visible');
}

function cacherBulleBientot() {
  clearTimeout(minuterieBulle);
  minuterieBulle = setTimeout(cacherBulle, SURSIS_BULLE);
}

/** Contenu de l'infobulle : le lieu, puis ce qui peut y apparaitre. */
function remplirBulle(m, el) {
  const b = bulleElement();
  b.textContent = '';

  const titre = document.createElement('strong');
  titre.textContent = m.t;
  b.appendChild(titre);

  const sous = document.createElement('div');
  sous.className = 'mq-bulle-sous';
  sous.textContent = `${m.d || ''}${m.d ? ' · ' : ''}x=${m.x} y=${m.y} z=${m.z}`;
  b.appendChild(sous);

  // Ce que la pastille promet, verifie par extraire-marqueurs.py depuis les
  // meubles REELLEMENT presents : combien on peut esperer trouver en vidant la
  // piece, ou pour une station-service, la distance a la pompe.
  const QUOI = {
    billets: 'billets', or: 'objets en or', valeur: 'objets de valeur',
    armes: 'armes ou munitions', medical: 'objets de soin',
    outils: 'outils ou materiaux', bouffe: 'aliments ou boissons',
    labo: 'tirages dans les tables de laboratoire',
  };
  let attendu = '';
  if (m.pompe !== undefined) {
    attendu = m.pompe === 0 ? 'pompe a essence sur place' : `pompe a essence a ${m.pompe} cases`;
  } else if (m.cat === 'metal') {
    const n = m.n >= 10 ? Math.round(m.n) : m.n;
    attendu = `~${n} plaques en metal`
      + (m.ps >= 0.5 ? ` et ~${m.ps >= 10 ? Math.round(m.ps) : m.ps} petites` : '')
      + ' en vidant la piece (estimation). Une plaque se scie en 4 petites.';
  } else if (m.n) {
    const n = m.n >= 10 ? Math.round(m.n) : m.n;
    attendu = `~${n} ${QUOI[m.cat] || 'objets'} en vidant la piece (estimation)`;
  }
  if (attendu) {
    const att = document.createElement('div');
    att.className = 'mq-bulle-attendu';
    att.textContent = attendu;
    b.appendChild(att);
  }

  const piece = nomPiece(m);
  const fiche = piece && loots ? loots[piece] : null;
  const liste = fiche && fiche.t;
  if (liste && liste.length) {
    const entete = document.createElement('div');
    entete.className = 'mq-bulle-entete';
    // Un contenu garanti, comme la palette de lingots, n'a pas de tirage :
    // afficher "100 %" a cote donnerait a croire qu'il y en a un.
    const garanti = liste.length === 1 && liste[0][1] >= 100;
    // La liste decrit les meubles PROPRES a ce type de piece. Les meubles que
    // la piece ne liste pas (souvent des caisses) tirent dans la table
    // generique du jeu et n'y figurent pas : un grand entrepot plein de
    // caisses annonce ~194 plaques au-dessus, mais 4 % ici. Le chiffre du
    // dessus, lui, vient des meubles reels de CETTE piece.
    entete.textContent = garanti ? 'contient'
      : 'meubles propres a ce type de piece, chance par tirage';
    b.appendChild(entete);

    const table = document.createElement('table');
    for (const ligne of liste) {
      const tr = document.createElement('tr');
      const tdc = document.createElement('td');
      tdc.className = 'mq-bulle-chance';
      tdc.textContent = garanti ? '' : ligne[1] + ' %';
      const tdn = document.createElement('td');
      if (ligne.length > 2) {
        // Un conteneur : ce qu'il y a dedans compte plus que lui.
        const bt = document.createElement('button');
        bt.className = 'mq-bulle-ouvrir';
        bt.textContent = ligne[0] + ' \u25b8';
        bt.title = 'Voir ce qu\'il y a dedans';
        bt.addEventListener('click', () => ouvrirContenant(ligne[2], ligne[0]));
        tdn.appendChild(bt);
      } else {
        tdn.textContent = ligne[0];
      }
      tr.appendChild(tdc);
      tr.appendChild(tdn);
      table.appendChild(tr);
    }
    b.appendChild(table);
  }

  if (actionTrajet) {
    const t = document.createElement('button');
    t.className = 'mq-bulle-tout';
    t.textContent = 'trajet jusqu\'ici';
    t.addEventListener('click', () => { cacherBulle(); actionTrajet(m); });
    b.appendChild(t);
  }

  if (piece && loots && loots[piece] && (loots[piece].m || []).length) {
    const pied = document.createElement('button');
    pied.className = 'mq-bulle-tout';
    pied.textContent = 'voir toute la table de loot';
    pied.addEventListener('click', () => ouvrirPiece(piece, m.t));
    b.appendChild(pied);
  }

  // Place a cote de la pastille, rabattue dans la fenetre si ca deborde.
  b.classList.add('visible');
  const r = el.getBoundingClientRect();
  const t = b.getBoundingClientRect();
  let x = r.right + 10;
  let y = r.top;
  if (x + t.width > innerWidth - 8) x = Math.max(8, r.left - t.width - 10);
  if (y + t.height > innerHeight - 8) y = Math.max(8, innerHeight - t.height - 8);
  b.style.left = Math.round(x) + 'px';
  b.style.top = Math.round(y) + 'px';
}

function creerElement(index, m) {
  const el = document.createElement('div');
  el.className = 'mq mq-' + m.cat;
  el.dataset.index = index;
  // Remplie au survol et pas ici : la table de loot arrive apres les
  // marqueurs, et construire 2212 bulles d'avance ne sert a rien.
  el.addEventListener('mouseenter', () => remplirBulle(m, el));
  el.addEventListener('mouseleave', cacherBulleBientot);
  // Plus la categorie est rare, plus elle passe devant.
  el.style.zIndex = PRIORITE.get(m.cat) || 0;
  const pastille = document.createElement('i');
  pastille.style.backgroundImage = `url(icons/${m.cat}.png?v=${VERSION_ICONES})`;
  el.appendChild(pastille);
  const nom = document.createElement('span');
  nom.textContent = m.t;
  el.appendChild(nom);
  el.addEventListener('mousedown', e => e.stopPropagation());
  el.addEventListener('click', e => {
    e.stopPropagation();
    auClic(index);
  });
  return el;
}

/** Culling : on ne cree que les marqueurs reellement dans la fenetre. */
export function dessinerMarqueurs() {
  const e = echelle();
  // La boite visible ne peut plus se deduire coordonnee par coordonnee : en
  // iso le rectangle de l'ecran devient un losange en coordonnees monde.
  const { x0, y0, x1, y1 } = empriseMondeVisible(40 / e);

  let candidats = [];
  for (let i = 0; i < etat.tous.length; i++) {
    const m = etat.tous[i];
    if (!etat.filtres[m.cat]) continue;
    if (m.x < x0 || m.x > x1 || m.y < y0 || m.y > y1) continue;
    candidats.push(i);
  }

  const gardes = new Set(candidats);
  for (const [index, el] of elements) {
    if (!gardes.has(index)) {
      // Retirer l'element ne declenche pas mouseleave : la bulle resterait
      // affichee dans le vide apres un deplacement de la carte.
      if (bulle && bulle.classList.contains('visible')
          && el.matches(':hover')) cacherBulle();
      el.remove();
      elements.delete(index);
    }
  }

  // Regroupement des marqueurs qui partagent exactement la meme case. Le
  // groupe ne se forme que sur ce qui est REELLEMENT affiche : si un filtre
  // masque l'un des deux, l'autre reprend sa place normale, sans boite.
  const groupes = new Map();
  for (const index of candidats) {
    const m = etat.tous[index];
    const cle = `${m.x}|${m.y}|${m.z}`;
    let g = groupes.get(cle);
    if (!g) { g = []; groupes.set(cle, g); }
    g.push(index);
  }
  // Les plus rares a gauche, pour un ordre stable et lisible.
  for (const g of groupes.values()) {
    if (g.length > 1) {
      g.sort((a, b) => (PRIORITE.get(etat.tous[b].cat) || 0)
                     - (PRIORITE.get(etat.tous[a].cat) || 0));
    }
  }
  const rangs = new Map();
  for (const g of groupes.values()) g.forEach((idx, r) => rangs.set(idx, [r, g.length]));

  const etiquettes = vue.zoom >= ZOOM_ETIQUETTES;
  const etiquettesRares = vue.zoom >= ZOOM_ETIQUETTES_RARES;
  for (const index of candidats) {
    const m = etat.tous[index];
    const [rang, taille] = rangs.get(index) || [0, 1];
    // Une seule etiquette par groupe, sinon les textes se superposent.
    const nomme = (rang === 0 || index === etat.selection)
      && (index === etat.selection || etiquettes
      || (etiquettesRares && CATEGORIES_RARES.has(m.cat)));
    let el = elements.get(index);
    if (!el) {
      el = creerElement(index, m);
      elements.set(index, el);
      conteneur.appendChild(el);
    }
    // Arrondi au pixel : une pastille a cheval sur deux pixels est floue.
    // Le decalage des doublons est entier lui aussi, pour la meme raison.
    const dx = (taille > 1) ? Math.round((rang - (taille - 1) / 2) * ECART_DOUBLON) : 0;
    el.style.left = (Math.round(mondeVersEcranX(m.x, m.y)) + dx) + 'px';
    el.style.top = Math.round(mondeVersEcranY(m.x, m.y)) + 'px';
    el.classList.toggle('en-groupe', taille > 1);
    el.classList.toggle('avec-nom', nomme);
    el.classList.toggle('selection', index === etat.selection);
    // Etat de loot : eteint tant que le repop n'est pas fait, puis liseré vert
    // le temps qu'on remarque que c'est redevenu pillable.
    const dateLoot = loot.date(m);
    el.classList.toggle('pille', dateLoot > 0 && loot.estFrais(m));
    el.classList.toggle('repop', dateLoot > 0 && !loot.estFrais(m));
  }

  // Boites des groupes. Creees apres les marqueurs pour que leur retrait
  // suive le meme cycle, posees derriere eux par leur z-index.
  const clesVues = new Set();
  for (const [cle, g] of groupes) {
    if (g.length < 2) continue;
    clesVues.add(cle);
    const m = etat.tous[g[0]];
    let b = boites.get(cle);
    if (!b) {
      b = document.createElement('div');
      b.className = 'mq-boite';
      boites.set(cle, b);
      conteneur.appendChild(b);
    }
    const largeur = (g.length - 1) * ECART_DOUBLON + 30 + 2 * MARGE_BOITE;
    const hauteur = 30 + 2 * MARGE_BOITE;
    b.style.width = largeur + 'px';
    b.style.height = hauteur + 'px';
    b.style.left = (Math.round(mondeVersEcranX(m.x, m.y)) - largeur / 2) + 'px';
    b.style.top = (Math.round(mondeVersEcranY(m.x, m.y)) - hauteur / 2) + 'px';
  }
  for (const [cle, b] of boites) {
    if (!clesVues.has(cle)) { b.remove(); boites.delete(cle); }
  }

  etat.visibles = candidats.length;
  return candidats.length;
}

/** Vide le cache DOM (apres un changement de filtres, pour forcer la relecture). */
export function reinitialiserAffichage() {
  for (const [, el] of elements) el.remove();
  elements.clear();
  for (const [, b] of boites) b.remove();
  boites.clear();
}

/**
 * Liste laterale : les marqueurs actifs les plus proches du centre de la vue,
 * tries par distance et plafonnes pour rester lisibles.
 */
export function listerPour(options = {}) {
  const { limite = 200, texte = '', tri = 'distance', masquerPilles = false,
          filtreLoot = null } = options;
  const c = centreMonde();
  const q = texte.trim().toLowerCase();
  // La recherche porte aussi sur les objets de la table de loot : taper
  // "lingot" doit sortir la bijouterie, pas seulement les pieces qui ont
  // "lingot" dans leur nom.
  const piecesTrouvees = q.length >= 3 && loots ? piecesAvecObjet(q) : null;
  const resultat = [];
  for (let i = 0; i < etat.tous.length; i++) {
    const m = etat.tous[i];
    if (!etat.filtres[m.cat]) continue;
    if (masquerPilles && filtreLoot && filtreLoot(m)) continue;
    if (q) {
      const p = nomPiece(m);
      const dedans = (m.t || '').toLowerCase().includes(q)
        || (m.d || '').toLowerCase().includes(q)
        || (piecesTrouvees && p && piecesTrouvees.has(p));
      if (!dedans) continue;
    }
    resultat.push({ index: i, m, d2: (m.x - c.x) ** 2 + (m.y - c.y) ** 2 });
  }
  if (tri === 'nom') {
    resultat.sort((a, b) => (a.m.t || '').localeCompare(b.m.t || '')
                            || a.d2 - b.d2);
  } else {
    resultat.sort((a, b) => a.d2 - b.d2);
  }
  return { total: resultat.length, lignes: resultat.slice(0, limite) };
}

// Cache de la recherche par objet : la table est immuable, et retaper une
// lettre relancerait sinon un parcours de 370 pieces et de leurs listes.
const cacheObjets = new Map();

function piecesAvecObjet(q) {
  let trouve = cacheObjets.get(q);
  if (trouve) return trouve;
  trouve = new Set();
  for (const [piece, fiche] of Object.entries(loots)) {
    for (const ligne of (fiche.t || [])) {
      if (String(ligne[0]).toLowerCase().includes(q)) { trouve.add(piece); break; }
    }
  }
  if (cacheObjets.size > 60) cacheObjets.clear();
  cacheObjets.set(q, trouve);
  return trouve;
}
