// Calque des constructions : pilotage de la couche de tuiles.
//
// Le calque N'EST PLUS dessine dans le navigateur. Il est pre-calcule en
// pyramide de tuiles par outils/agent-monde/rendre-calque.py, puis affiche par
// le moteur de tuiles ordinaire, comme la carte elle-meme.
//
// POURQUOI CE CHANGEMENT
//   Le dessin cote navigateur empilait des sprites a chaque image. Sur un
//   releve de 1,5 million de cases cela demandait des centaines de milliers
//   d'appels de dessin, tout etait a refaire au moindre deplacement, et rien
//   ne survivait a un rechargement de page.
//
//   En tuiles, l'affichage est immediat, le navigateur les met en cache, et
//   deplacer ou recharger ne coute plus rien.
//
// Ce module ne garde donc que le pilotage : afficher ou masquer la couche, et
// la recharger apres une synchronisation.

import { pyramidesActives, chargerGeometrie, mode } from './geometrie.js';

export let actif = false;

/** La pyramide du calque, ou null si elle n'a pas ete produite. */
function couche() {
  return pyramidesActives().find(p => p.calque) || null;
}

export function initConstructions() { /* plus de canvas : rien a preparer */ }

/** Le calque existe-t-il ? Faux en vue de dessus, ou si rien n'a ete calcule. */
export function disponible() { return couche() !== null; }

/** Nombre de cases du releve, tel qu'annonce par info.json. */
export function nombreCases() {
  const c = couche();
  return c ? (c.cases || 0) : 0;
}

export function basculerConstructions(valeur) {
  actif = valeur;
  const c = couche();
  if (c) c.masque = !valeur;
  return Promise.resolve();
}

/**
 * Recharge la couche apres une synchronisation.
 *
 * rendre-calque.py a pu produire de nouvelles tuiles : il faut relire la
 * geometrie pour connaitre la nouvelle liste, et forcer le navigateur a
 * oublier les tuiles qu'il garde en cache une semaine.
 */
export async function rechargerConstructions() {
  await chargerGeometrie(mode);
  const c = couche();
  if (c) c.masque = !actif;
  return !!c;
}

// --- compatibilite ---------------------------------------------------------
// Le dessin est desormais assure par le moteur de tuiles. Ces fonctions
// existent encore pour ne pas disperser des conditions dans app.js.
export function dessinerConstructions() { /* rien : ce sont des tuiles */ }
export function surChargement() { /* plus de chargement asynchrone de sprites */ }
