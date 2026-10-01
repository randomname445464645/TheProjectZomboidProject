// Geometrie des pyramides de tuiles et conversions de coordonnees.
//
// Rien n'est code en dur ici : toute la geometrie est lue au demarrage dans les
// fichiers produits par pzmap2dzi.
//
//   map_info.json  ->  w, h, x0, y0, sqr, cell_rects
//   layer0.dzi     ->  TileSize, Format et Size (source de verite pour les tuiles)
//
// DEUX MODES, ET UN ESPACE INTERMEDIAIRE
//
// En vue de dessus, une case du jeu occupe un carre de `sqr` pixels et les
// coordonnees monde se confondent avec la grille de l'image :
//     pixel = x0 + coordonnee_monde * sqr
//
// En isometrique une case occupe un losange de 128 x 64 px et les deux axes se
// melangent (pzmap/map.js, square2pixel) :
//     pixel_x = x0 + (x - y) * sqr / 2      soit 64 pour sqr = 128
//     pixel_y = y0 + (x + y) * sqr / 4      soit 32
//
// Les deux ne peuvent donc pas partager la meme notion de "coordonnee de vue".
// D'ou l'espace PLAN, intermediaire, dans lequel travaillent le pan, le zoom,
// le placement des tuiles, des marqueurs et des rues :
//
//   mode dessus : 1 unite de plan = 1 case du jeu      (pixelsParPlan = sqr)
//   mode iso    : 1 unite de plan = 1 pixel de pyramide (pixelsParPlan = 1)
//
// Le reste du viewer ne connait que le plan, et n'a donc pas a savoir dans quel
// mode il est. Seules mondeVersPlan / planVersMonde different.

export const CASES_PAR_CELLULE = 256;   // B42

/** Mode d'affichage courant. */
export const MODES = ['dessus', 'iso'];
export let mode = 'dessus';

// Identite des pyramides. L'ordre fixe l'ordre de dessin : la vanilla d'abord,
// les cartes moddees par-dessus.
//
// Les deux rendus ont des racines differentes : la vue de dessus sort dans
// base_top, l'isometrique dans base (voir render.py, RENDER_CMD : le job
// s'appelle 'base' et non 'base_top').
export const PYRAMIDES = [
  { nom: 'default',         libelle: 'Knox County (vanilla)',      mod: false },
  { nom: 'RavenCreek_B42',  libelle: 'Raven Creek',                mod: true },
  { nom: 'Constown_B42',    libelle: 'Constown',                   mod: true },
  { nom: 'Trelai_B42',      libelle: 'Trelai',                     mod: true },
  { nom: 'NewHartburg_B42', libelle: 'New Hartburg',               mod: true },
  { nom: 'Greenport_B42',   libelle: 'Greenport',                  mod: true },
  { nom: 'Maplewood_B42',   libelle: 'Maplewood',                  mod: true },
  { nom: 'LQZ_B42',         libelle: 'Louisville Quarantine Zone', mod: true },
  { nom: 'Chestown_B42',    libelle: 'Chestown',                   mod: true },
  // Calque des constructions, pre-calcule en tuiles par
  // outils/agent-monde/rendre-calque.py. Ce n'est pas une carte mais une
  // couche transparente posee par-dessus, et elle n'existe qu'en isometrique :
  // sa geometrie est celle de la pyramide iso de base.
  { nom: 'constructions',   libelle: 'Mes constructions',          mod: false, calque: true },
];

/** Racine des tuiles d'une pyramide, pour un mode donne. */
function racine(p, m) {
  if (p.calque) return 'map_data/constructions';
  const job = (m === 'iso') ? 'base' : 'base_top';
  return p.mod ? `map_data/mod_maps/${p.nom}/${job}` : `map_data/${job}`;
}

// Emprise globale en unites de plan, union des pyramides du mode courant.
export const EMPRISE = { x0: 0, y0: 0, x1: 0, y1: 0 };

// --- conversions monde <-> plan --------------------------------------------
// Le facteur iso vient de sqr : 64 = sqr/2 et 32 = sqr/4. Il est lu sur la
// premiere pyramide chargee plutot que code en dur, pour suivre un eventuel
// changement de resolution du rendu.
let ISO_DX = 64, ISO_DY = 32;

export function mondeVersPlanX(x, y) {
  return (mode === 'iso') ? (x - y) * ISO_DX : x;
}
export function mondeVersPlanY(x, y) {
  return (mode === 'iso') ? (x + y) * ISO_DY : y;
}
export function planVersMondeX(px, py) {
  return (mode === 'iso') ? (px / (2 * ISO_DX) + py / (2 * ISO_DY)) : px;
}
export function planVersMondeY(px, py) {
  return (mode === 'iso') ? (py / (2 * ISO_DY) - px / (2 * ISO_DX)) : py;
}

/**
 * Cote apparent d'une case, en unites de plan.
 *
 * En vue de dessus une case est un carre de 1 unite de cote. En iso c'est un
 * losange de 2*ISO_DX de large sur 2*ISO_DY de haut, soit 128 x 64 : comparer
 * les largeurs donnerait 128, mais un losange de 128 x 64 ne porte pas autant
 * d'information qu'un carre de 128 de cote. La grandeur comparable est la
 * racine de la surface : sqrt(128 * 64 / 2) = 64, soit 6 crans de zoom et non 7.
 */
export function coteCasePlan() {
  return (mode === 'iso') ? Math.sqrt(2 * ISO_DX * 2 * ISO_DY / 2) : 1;
}

/** Ecart de zoom entre les deux modes, a densite d'information egale. */
export function ecartZoomModes() {
  return Math.round(Math.log2(Math.sqrt(2 * ISO_DX * 2 * ISO_DY / 2)));
}

function lireDzi(texte) {
  const doc = new DOMParser().parseFromString(texte, 'application/xml');
  const image = doc.querySelector('Image');
  const taille = doc.querySelector('Size');
  if (!image || !taille) throw new Error('fichier .dzi illisible');
  return {
    tailleTuile: parseInt(image.getAttribute('TileSize'), 10),
    format: image.getAttribute('Format') || 'webp',
    w: parseInt(taille.getAttribute('Width'), 10),
    h: parseInt(taille.getAttribute('Height'), 10),
  };
}

/**
 * Charge la geometrie reelle de chaque pyramide pour le mode demande.
 * Une pyramide dont les fichiers manquent est ecartee plutot que de faire
 * echouer tout le viewer : c'est ce qui permet au mode iso d'exister avant
 * que toutes les cartes moddees soient rendues, et inversement.
 */
export async function chargerGeometrie(nouveauMode = mode) {
  mode = MODES.includes(nouveauMode) ? nouveauMode : 'dessus';
  const iso = (mode === 'iso');
  const retenues = [];

  await Promise.all(PYRAMIDES.map(async p => {
    p.absente = true;
    // Le calque est dessine dans le repere isometrique : il n'a pas
    // d'equivalent en vue de dessus.
    if (p.calque && !iso) return;
    const r = racine(p, mode);
    try {
      if (p.calque) { await chargerCalque(p, r); retenues.push(p); return; }
      const [info, dzi] = await Promise.all([
        fetch(`${r}/map_info.json`).then(x => { if (!x.ok) throw new Error(x.status); return x.json(); }),
        fetch(`${r}/layer0.dzi`).then(x => { if (!x.ok) throw new Error(x.status); return x.text(); }).then(lireDzi),
      ]);

      p.racine = r;
      p.sqr = info.sqr || 1;              // px d'image par case (2 en dessus, 128 en iso)
      p.w = dzi.w;                        // taille de l'image en px, pleine resolution
      p.h = dzi.h;
      p.tailleTuile = dzi.tailleTuile;    // 512 en dessus, 1024 en iso
      p.format = dzi.format;              // webp en dessus ; jpg pour la vanilla iso, webp pour les mods
      p.cellules = info.cell_rects || [];
      p.cellSize = info.cell_size || CASES_PAR_CELLULE;

      // Pixels de pyramide par unite de plan. C'est LA difference entre les
      // deux modes, tout le reste en decoule.
      p.pixelsParPlan = iso ? 1 : p.sqr;

      // Niveau DZI de pleine resolution.
      p.niveauMax = Math.ceil(Math.log2(Math.max(p.w, p.h)));
      // Niveau ou 1 px d'image vaut exactement 1 unite de plan. C'est lui la
      // reference pour le choix du niveau, pas le niveau max : en vue de dessus
      // avec sqr = 2 la pleine resolution est deja un agrandissement x2.
      p.niveau1a1 = p.niveauMax - Math.log2(p.pixelsParPlan);

      // Emprise de la pyramide en unites de plan.
      p.planX = -info.x0 / p.pixelsParPlan;
      p.planY = -info.y0 / p.pixelsParPlan;
      p.planX1 = p.planX + p.w / p.pixelsParPlan;
      p.planY1 = p.planY + p.h / p.pixelsParPlan;

      if (iso) { ISO_DX = p.sqr / 2; ISO_DY = p.sqr / 4; }

      p.absente = false;
      retenues.push(p);
    } catch (e) {
      console.warn(`pyramide ${p.nom} (${mode}) ignoree :`, e.message);
    }
  }));

  if (!retenues.length) throw new Error(`aucune pyramide lisible en mode ${mode}`);

  EMPRISE.x0 = Math.min(...retenues.map(p => p.planX));
  EMPRISE.y0 = Math.min(...retenues.map(p => p.planY));
  EMPRISE.x1 = Math.max(...retenues.map(p => p.planX1));
  EMPRISE.y1 = Math.max(...retenues.map(p => p.planY1));
  return retenues;
}

/**
 * Charge la pyramide du calque, decrite par son propre info.json.
 *
 * Elle reprend la geometrie de la pyramide iso de base, donc ses indices de
 * tuiles coincident exactement. Seule difference : la liste des tuiles
 * reellement produites, le calque ne couvrant que la zone exploree.
 */
async function chargerCalque(p, r) {
  const info = await fetch(`${r}/info.json`).then(x => {
    if (!x.ok) throw new Error(x.status);
    return x.json();
  });
  p.racine = r;
  p.sqr = info.sqr;
  p.w = info.w;
  p.h = info.h;
  p.tailleTuile = info.tuile;
  p.format = info.format || 'webp';
  p.cellules = [];
  p.cellSize = CASES_PAR_CELLULE;
  p.pixelsParPlan = 1;                 // iso uniquement
  p.niveauMax = info.niveau_max;
  p.niveau1a1 = p.niveauMax;
  p.planX = -info.x0; p.planY = -info.y0;
  p.planX1 = p.planX + p.w; p.planY1 = p.planY + p.h;
  // Tuiles existantes, par niveau : evite des milliers de requetes en 404.
  p.tuiles = new Map();
  for (const [niv, liste] of Object.entries(info.tuiles || {})) {
    p.tuiles.set(parseInt(niv, 10), new Set(liste.map(([a, b]) => a + ',' + b)));
  }
  p.cases = info.cases || 0;
  // Date du rendu, reprise dans l'URL des tuiles. Sans elle, une tuile
  // reecrite par une synchronisation garde la meme adresse, et le serveur
  // envoie les .webp avec une semaine de cache : le navigateur reaffichait
  // l'ancienne version, sans les chunks explores depuis. Mesure faite le
  // 26/09 : 28 334 tuiles reecrites a 10:30, adresses identiques a celles
  // du 22/09. info.json, lui, n'est jamais mis en cache, donc la date est
  // toujours fraiche.
  p.version = String(info.genere || '').replace(/\D/g, '');
  p.absente = false;
}

/** Un mode est-il disponible ? Teste la seule pyramide vanilla, la moins chere. */
export async function modeDisponible(m) {
  const p = PYRAMIDES.find(x => !x.mod);
  try {
    const r = await fetch(`${racine(p, m)}/layer0.dzi`, { method: 'HEAD' });
    return r.ok;
  } catch (e) { return false; }
}

/** Les pyramides effectivement chargees, dans l'ordre de dessin. */
export function pyramidesActives() {
  return PYRAMIDES.filter(p => !p.absente && p.niveauMax !== undefined);
}

/**
 * Niveau DZI a charger pour une pyramide donnee.
 *
 * L'echelle vaut toujours 2^zoom. Au niveau niveau1a1 un px d'image vaut une
 * unite de plan ; au niveau L il en vaut 2^(niveau1a1 - L). Pour obtenir
 * exactement 1 px d'image par pixel PHYSIQUE d'ecran il faut
 * 2^(niveau1a1 - L) = 1 / (echelle * dpr), soit L = niveau1a1 + zoom + boostDpr.
 */
export function niveauPour(pyramide, zoom, boostDpr) {
  const voulu = pyramide.niveau1a1 + zoom + boostDpr;
  return Math.max(0, Math.min(pyramide.niveauMax, Math.round(voulu)));
}

/** Unites de plan couvertes par un pixel d'image au niveau L. */
export function facteurNiveau(pyramide, niveau) {
  return 2 ** (pyramide.niveau1a1 - niveau);
}

/** Taille en pixels d'image du niveau L (le dernier rang de tuiles est rogne). */
export function tailleNiveau(pyramide, niveau) {
  const reduction = 2 ** (pyramide.niveauMax - niveau);
  return {
    w: Math.ceil(pyramide.w / reduction),
    h: Math.ceil(pyramide.h / reduction),
  };
}

/**
 * URL d'une tuile. layer0 = niveau du sol, le seul rendu utilise ici.
 *
 * Le jeton ?r= est indispensable : les tuiles sont servies avec un cache d'une
 * semaine et les memes URLs sont reutilisees d'un rendu a l'autre avec un
 * contenu different. Il est derive de la geometrie, il change donc tout seul
 * quand le rendu change d'emprise ou de resolution.
 *
 * Limite connue : un nouveau rendu de MEME geometrie ne bouscule pas le jeton.
 * Dans ce cas, incrementer VERSION_TUILES ci-dessous.
 */
const VERSION_TUILES = 2;   // 2 : ajout du mode isometrique

export function urlTuile(pyramide, niveau, tx, ty) {
  return `${pyramide.racine}/layer0_files/${niveau}/${tx}_${ty}.${pyramide.format}`
       + `?r=${VERSION_TUILES}.${mode}.${pyramide.sqr}.${pyramide.w}x${pyramide.h}`
       + (pyramide.version ? '.' + pyramide.version : '');
}

/**
 * La tuile (tx, ty) recouvre-t-elle au moins une cellule reellement rendue ?
 * Evite de demander des tuiles absentes : l'emprise vanilla n'est pas un
 * rectangle plein (4065 cellules sur 78 x 63 possibles).
 *
 * En iso la tuile couvre un rectangle du plan dont les quatre coins retombent
 * sur un losange en coordonnees monde : on teste la boite englobante de ces
 * coins, ce qui est conservateur. Une tuile de trop est sans consequence, le
 * moteur masque celles qui repondent 404.
 */
export function tuileExiste(pyramide, niveau, tx, ty) {
  // Le calque connait exactement ses tuiles : pas de cellules a consulter.
  if (pyramide.tuiles) {
    const s = pyramide.tuiles.get(niveau);
    return s ? s.has(tx + ',' + ty) : false;
  }
  if (!pyramide.cellules.length) return true;
  const span = pyramide.tailleTuile * facteurNiveau(pyramide, niveau); // unites de plan
  const px0 = pyramide.planX + tx * span, px1 = px0 + span;
  const py0 = pyramide.planY + ty * span, py1 = py0 + span;

  let wx0, wy0, wx1, wy1;
  if (mode === 'iso') {
    const xs = [], ys = [];
    for (const [a, b] of [[px0, py0], [px1, py0], [px0, py1], [px1, py1]]) {
      xs.push(planVersMondeX(a, b));
      ys.push(planVersMondeY(a, b));
    }
    wx0 = Math.min(...xs); wx1 = Math.max(...xs);
    wy0 = Math.min(...ys); wy1 = Math.max(...ys);
  } else {
    wx0 = px0; wx1 = px1; wy0 = py0; wy1 = py1;
  }

  const cx0 = Math.floor(wx0 / pyramide.cellSize);
  const cy0 = Math.floor(wy0 / pyramide.cellSize);
  const cx1 = Math.floor((wx1 - 1e-6) / pyramide.cellSize);
  const cy1 = Math.floor((wy1 - 1e-6) / pyramide.cellSize);
  for (const [rx, ry, rw, rh] of pyramide.cellules) {
    if (cx1 >= rx && cx0 < rx + rw && cy1 >= ry && cy0 < ry + rh) return true;
  }
  return false;
}
