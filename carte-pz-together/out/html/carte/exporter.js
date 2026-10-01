// Export HD de la vue courante en PNG.
//
// La carte a l'ecran est limitee par la taille de la fenetre. Ici on redessine
// la MEME emprise monde, mais a la resolution native des tuiles, en allant
// chercher le niveau de pyramide adapte plutot qu'en agrandissant ce qui est
// deja affiche. Un agrandissement ne creerait aucun detail ; changer de niveau
// en revele.
//
// Le calque des constructions est redessine a la meme echelle, avec la meme
// regle que constructions.js.

import { vue, echelle, ecranVersPlanX, ecranVersPlanY } from './vue.js';
import { pyramidesActives, facteurNiveau, tailleNiveau, urlTuile, tuileExiste }
  from './geometrie.js';

// Limites d'un canvas. Chrome refuse au-dela de 16384 px de cote, et la
// memoire s'effondre bien avant sur la surface totale.
const COTE_MAX = 16384;
const SURFACE_MAX = 40e6;        // 40 megapixels

/** Charge une image, ou null si elle manque. Jamais d'exception. */
function charger(url) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * Facteur de sortie retenu : pixels de sortie par unite de plan.
 *
 * On part de la resolution native (1) et on divise par deux tant que l'image
 * depasse les limites. Toujours une puissance de deux, pour que les tuiles
 * tombent sur des pixels entiers et restent nettes.
 */
function facteurSortie(pw, ph) {
  let f = 1;
  while (f > 1 / 64) {
    const w = Math.ceil(pw * f), h = Math.ceil(ph * f);
    if (w <= COTE_MAX && h <= COTE_MAX && w * h <= SURFACE_MAX) return f;
    f /= 2;
  }
  return f;
}

/**
 * Exporte la vue courante.
 * @param {(etape: string) => void} progres rappel d'avancement, pour l'interface
 * @returns {Promise<{blob: Blob, largeur: number, hauteur: number, facteur: number}>}
 */
export async function exporterVue(progres = () => {}) {
  // Emprise visible, en unites de plan, arrondie a l'entier.
  const px0 = Math.floor(ecranVersPlanX(0));
  const py0 = Math.floor(ecranVersPlanY(0));
  const px1 = Math.ceil(ecranVersPlanX(vue.largeur));
  const py1 = Math.ceil(ecranVersPlanY(vue.hauteur));
  const pw = px1 - px0, ph = py1 - py0;
  if (pw <= 0 || ph <= 0) throw new Error('vue vide');

  const f = facteurSortie(pw, ph);
  const largeur = Math.ceil(pw * f), hauteur = Math.ceil(ph * f);

  const toile = document.createElement('canvas');
  toile.width = largeur;
  toile.height = hauteur;
  const c = toile.getContext('2d');
  c.imageSmoothingEnabled = false;      // pixel art : jamais de lissage
  c.fillStyle = '#14161a';
  c.fillRect(0, 0, largeur, hauteur);

  // --- tuiles --------------------------------------------------------------
  const pyramides = pyramidesActives().filter(p => !p.masque);
  for (let ip = 0; ip < pyramides.length; ip++) {
    const p = pyramides[ip];
    progres(`tuiles ${ip + 1}/${pyramides.length}`);

    // Niveau dont la resolution correspond au facteur de sortie.
    const voulu = Math.round(p.niveau1a1 + Math.log2(f));
    const niveau = Math.max(0, Math.min(p.niveauMax, voulu));
    const fn = facteurNiveau(p, niveau);          // unites de plan par px d'image
    const taille = tailleNiveau(p, niveau);
    const span = p.tailleTuile * fn;              // unites de plan par tuile

    const vx0 = Math.max(p.planX, px0), vy0 = Math.max(p.planY, py0);
    const vx1 = Math.min(p.planX1, px1), vy1 = Math.min(p.planY1, py1);
    if (vx1 <= vx0 || vy1 <= vy0) continue;

    const tx0 = Math.floor((vx0 - p.planX) / span);
    const ty0 = Math.floor((vy0 - p.planY) / span);
    const tx1 = Math.floor((vx1 - 1e-6 - p.planX) / span);
    const ty1 = Math.floor((vy1 - 1e-6 - p.planY) / span);

    const demandes = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (tx < 0 || ty < 0) continue;
        if (tx * p.tailleTuile >= taille.w || ty * p.tailleTuile >= taille.h) continue;
        if (!tuileExiste(p, niveau, tx, ty)) continue;
        demandes.push({ tx, ty });
      }
    }

    // Par paquets : ouvrir mille requetes d'un coup sature le navigateur.
    const PAQUET = 24;
    for (let i = 0; i < demandes.length; i += PAQUET) {
      const lot = demandes.slice(i, i + PAQUET);
      const images = await Promise.all(lot.map(d => charger(urlTuile(p, niveau, d.tx, d.ty))));
      for (let k = 0; k < lot.length; k++) {
        const img = images[k];
        if (!img) continue;
        const { tx, ty } = lot[k];
        // Le dernier rang d'un niveau est rogne : ne pas l'etirer.
        const lImg = Math.min(p.tailleTuile, taille.w - tx * p.tailleTuile);
        const hImg = Math.min(p.tailleTuile, taille.h - ty * p.tailleTuile);
        const gx = (p.planX + tx * span - px0) * f;
        const gy = (p.planY + ty * span - py0) * f;
        c.drawImage(img, 0, 0, lImg, hImg, gx, gy, lImg * fn * f, hImg * fn * f);
      }
      progres(`tuiles ${ip + 1}/${pyramides.length} — ${Math.min(i + PAQUET, demandes.length)}/${demandes.length}`);
    }
  }

  // Le calque des constructions n'a plus de traitement particulier : c'est
  // une pyramide de tuiles comme les autres, deja dessinee par la boucle
  // ci-dessus, et qui suit sa case a cocher via p.masque.

  progres('encodage');
  const blob = await new Promise(r => toile.toBlob(r, 'image/png'));
  if (!blob) throw new Error('encodage impossible');
  return { blob, largeur, hauteur, facteur: f };
}
