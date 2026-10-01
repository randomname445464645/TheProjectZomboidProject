// Calque optionnel des noms de rues, dessine sur un canvas.
//
// Source : les fichiers streets/marks.json produits par pzmap2dzi a partir des
// streets.xml du jeu et des mods. 283 Ko au total, charges a la demande a la
// premiere activation. Les points sont deja en coordonnees monde, aucune
// conversion a faire.
//
// Ces fichiers manquaient : le calque etait branche mais les trois URL
// renvoyaient 404, donc cocher la case ne faisait rien. Ils se regenerent avec
//     python main.py -c conf/conf-sqr2.yaml render streets
// depuis pzmap2dzi/, puis copie de map_data/**/streets/marks.json.

import { vue, echelle, mondeVersEcranX, mondeVersEcranY,
         empriseMondeVisible } from './vue.js';

// Cinq cartes sur neuf ont un streets.xml : la vanilla (1098 polylignes), Raven
// Creek (45), New Hartburg (13), Greenport (15) et Maplewood (12). Constown,
// Trelai, Chestown et LQZ n'en ont pas : le rendu sort zero marque pour elles.
const SOURCES = [
  'map_data/streets/marks.json',
  'map_data/mod_maps/RavenCreek_B42/streets/marks.json',
  'map_data/mod_maps/NewHartburg_B42/streets/marks.json',
  'map_data/mod_maps/Greenport_B42/streets/marks.json',
  'map_data/mod_maps/Maplewood_B42/streets/marks.json',
];

// Seuils exprimes en taille de case apparente (px CSS par case), pour valoir
// dans les deux modes : le zoom brut differe de 6 crans entre dessus et iso.
const CASE_MIN_TRACE = 1 / 16;  // en dessous c'est un plat de spaghettis
const CASE_MIN_NOMS = 1 / 4;    // les noms ne sont lisibles qu'a partir de la

let canvas = null, ctx = null;
let rues = null;                // null = pas encore charge
let chargement = null;
export let actif = false;

export function initRues(element) {
  canvas = element;
  ctx = canvas.getContext('2d');
}

export function basculerRues(valeur) {
  actif = valeur;
  if (actif && !rues && !chargement) {
    chargement = Promise.all(SOURCES.map(u =>
      fetch(u).then(r => (r.ok ? r.json() : [])).catch(() => [])
    )).then(listes => {
      rues = [];
      for (const liste of listes) {
        for (const r of liste) {
          if (r.type !== 'polyline' || !r.points || r.points.length < 2) continue;
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
          for (const p of r.points) {
            if (p.x < x0) x0 = p.x;
            if (p.x > x1) x1 = p.x;
            if (p.y < y0) y0 = p.y;
            if (p.y > y1) y1 = p.y;
          }
          rues.push({ nom: r.name || '', points: r.points, epaisseur: r.width || 6, x0, y0, x1, y1 });
        }
      }
      chargement = null;
    });
    return chargement;
  }
  return Promise.resolve();
}

/** Largeur apparente d'une case du jeu, en px CSS, quel que soit le mode. */
function taillleCase() {
  return Math.abs(mondeVersEcranX(1, 0) - mondeVersEcranX(0, 0));
}

export function dessinerRues() {
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
  if (!actif || !rues || taillleCase() < CASE_MIN_TRACE) return;

  const e = echelle();
  const { x0: mx0, y0: my0, x1: mx1, y1: my1 } = empriseMondeVisible(0);

  const visibles = rues.filter(r => r.x1 >= mx0 && r.x0 <= mx1 && r.y1 >= my0 && r.y0 <= my1);

  // Traces
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const r of visibles) {
    ctx.lineWidth = Math.max(1, r.epaisseur * e);
    ctx.beginPath();
    for (let i = 0; i < r.points.length; i++) {
      const pt = r.points[i];
      const sx = mondeVersEcranX(pt.x, pt.y), sy = mondeVersEcranY(pt.x, pt.y);
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }

  if (taillleCase() < CASE_MIN_NOMS) return;

  // Noms, poses sur le segment le plus long de chaque rue visible a l'ecran.
  ctx.font = '600 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = '#e8eaee';
  const poses = [];
  for (const r of visibles) {
    if (!r.nom) continue;
    let meilleur = null, meilleureLongueur = 0;
    for (let i = 1; i < r.points.length; i++) {
      const pa = r.points[i - 1], pb = r.points[i];
      const ax = mondeVersEcranX(pa.x, pa.y), ay = mondeVersEcranY(pa.x, pa.y);
      const bx = mondeVersEcranX(pb.x, pb.y), by = mondeVersEcranY(pb.x, pb.y);
      const L = Math.hypot(bx - ax, by - ay);
      const cx = (ax + bx) / 2, cy = (ay + by) / 2;
      if (cx < 0 || cy < 0 || cx > vue.largeur || cy > vue.hauteur) continue;
      if (L > meilleureLongueur) { meilleureLongueur = L; meilleur = { cx, cy, ax, ay, bx, by }; }
    }
    if (!meilleur || meilleureLongueur < 90) continue;
    // Anti-chevauchement grossier : une etiquette tous les 60 px.
    if (poses.some(p => Math.abs(p.x - meilleur.cx) < 70 && Math.abs(p.y - meilleur.cy) < 16)) continue;
    poses.push({ x: meilleur.cx, y: meilleur.cy });

    let angle = Math.atan2(meilleur.by - meilleur.ay, meilleur.bx - meilleur.ax);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle < -Math.PI / 2) angle += Math.PI;
    ctx.save();
    ctx.translate(meilleur.cx, meilleur.cy);
    ctx.rotate(angle);
    ctx.strokeText(r.nom, 0, 0);
    ctx.fillText(r.nom, 0, 0);
    ctx.restore();
  }
}
