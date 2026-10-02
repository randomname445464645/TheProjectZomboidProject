// Redressage des routes dessinees a la main.
//
// Clique en vue isometrique, une route droite du jeu sort en zigzag : chaque
// point tombe a quelques cases de la chaussee, d'un cote ou de l'autre. Les
// routes du jeu, elles, suivent les axes de la grille (x ou y constant), plus
// rarement une diagonale a 45 degres.
//
// Le redressage, en coordonnees monde :
//   1. simplifie le trace (Douglas-Peucker) : les points qui ne font que
//      trembler autour d'une ligne disparaissent ;
//   2. accroche chaque troncon a l'axe le plus proche : x constant, y
//      constant, ou une des deux diagonales ;
//   3. fusionne les troncons consecutifs de meme axe ;
//   4. aligne entre elles les lignes paralleles et presque confondues, y
//      compris d'une route a l'autre : deux bouts de la meme chaussee
//      dessines separement finissent sur la meme ligne ;
//   5. recalcule les sommets comme intersections des lignes voisines ;
//   6. prolonge ou raccourcit chaque bout de route jusqu'a une autre route
//      dessinee proche, le long de son propre axe pour rester droit.
//
// Les routes gardent leur nom, leur ordre et leur sens ; le trace d'origine
// est conserve dans route.brut pour pouvoir revenir en arriere.

const TOLERANCE = 6;      // cases : ecart de trace absorbe par la simplification
const ANGLE_AXE = 30;     // degres : en deca, axe droit ; au-dela, diagonale
const ALIGNEMENT = 3;     // cases : lignes paralleles fusionnees si plus proches
const ECART_ALIGN = 12;   // cases : et si leurs etendues se touchent a ca pres
const TRONCON_MIN = 3;    // cases : un troncon plus court est absorbe
const ACCROCHE_BOUT = 10; // cases : un bout de route rejoint une route voisine

// Axes : direction et normale. La ligne d'un troncon est n . p = c.
const AXES = {
  H: { d: [1, 0], n: [0, 1] },      // y constant
  V: { d: [0, 1], n: [1, 0] },      // x constant
  D1: { d: [1, 1], n: [1, -1] },    // x - y constant
  D2: { d: [1, -1], n: [1, 1] },    // x + y constant
};

const constante = (axe, p) => AXES[axe].n[0] * p.x + AXES[axe].n[1] * p.y;
const position = (axe, p) => AXES[axe].d[0] * p.x + AXES[axe].d[1] * p.y;

function distSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Indices des points gardes par Douglas-Peucker. */
function simplifier(pts, tol) {
  const garde = new Uint8Array(pts.length);
  garde[0] = garde[pts.length - 1] = 1;
  const pile = [[0, pts.length - 1]];
  while (pile.length) {
    const [i, j] = pile.pop();
    let k = -1, dMax = tol;
    for (let m = i + 1; m < j; m++) {
      const d = distSegment(pts[m], pts[i], pts[j]);
      if (d > dMax) { dMax = d; k = m; }
    }
    if (k >= 0) { garde[k] = 1; pile.push([i, k], [k, j]); }
  }
  const res = [];
  garde.forEach((g, i) => { if (g) res.push(i); });
  return res;
}

function axeDe(a, b) {
  let ang = Math.abs(Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI); // 0..180
  if (ang <= ANGLE_AXE || ang >= 180 - ANGLE_AXE) return 'H';
  if (Math.abs(ang - 90) <= ANGLE_AXE) return 'V';
  // Entre les deux : diagonale. Meme signe pour dx et dy -> D1.
  return (b.x - a.x) * (b.y - a.y) > 0 ? 'D1' : 'D2';
}

function intersection(l1, l2) {
  const [a1, b1] = AXES[l1.axe].n, [a2, b2] = AXES[l2.axe].n;
  const det = a1 * b2 - a2 * b1;
  if (!det) return null;
  return {
    x: (l1.c * b2 - l2.c * b1) / det,
    y: (a1 * l2.c - a2 * l1.c) / det,
  };
}

function projeter(l, p) {
  const [nx, ny] = AXES[l.axe].n;
  const k = (nx * p.x + ny * p.y - l.c) / (nx * nx + ny * ny);
  return { x: p.x - k * nx, y: p.y - k * ny };
}

/**
 * Decoupe une route en lignes : [{axe, c, pts}] ou pts sont les points
 * d'origine couverts. Pas encore de sommets.
 */
function lignesDe(points) {
  const idx = simplifier(points, TOLERANCE);
  let lignes = [];
  for (let s = 1; s < idx.length; s++) {
    const a = points[idx[s - 1]], b = points[idx[s]];
    if (a.x === b.x && a.y === b.y) continue;
    const axe = axeDe(a, b);
    const pts = points.slice(idx[s - 1], idx[s] + 1);
    const der = lignes[lignes.length - 1];
    if (der && der.axe === axe) der.pts.push(...pts.slice(1));
    else lignes.push({ axe, pts });
  }
  for (const l of lignes) {
    l.c = l.pts.reduce((s, p) => s + constante(l.axe, p), 0) / l.pts.length;
  }
  return lignes;
}

function fusionnerVoisines(lignes) {
  const res = [];
  for (const l of lignes) {
    const der = res[res.length - 1];
    if (der && der.axe === l.axe) {
      const n = der.pts.length + l.pts.length;
      der.c = (der.c * der.pts.length + l.c * l.pts.length) / n;
      der.pts.push(...l.pts);
    } else res.push(l);
  }
  return res;
}

/** Sommets d'une suite de lignes, bouts projetes sur la premiere et la derniere. */
function sommets(lignes, debut, fin) {
  const out = [projeter(lignes[0], debut)];
  for (let i = 1; i < lignes.length; i++) {
    out.push(intersection(lignes[i - 1], lignes[i]) || projeter(lignes[i], lignes[i].pts[0]));
  }
  out.push(projeter(lignes[lignes.length - 1], fin));
  return out;
}

/** Retire les troncons interieurs trop courts, qui ne sont que du bruit. */
function nettoyer(lignes, debut, fin) {
  for (let tour = 0; tour < 50 && lignes.length > 2; tour++) {
    const s = sommets(lignes, debut, fin);
    let k = -1;
    for (let i = 1; i < lignes.length - 1; i++) {
      if (Math.hypot(s[i + 1].x - s[i].x, s[i + 1].y - s[i].y) < TRONCON_MIN) { k = i; break; }
    }
    if (k < 0) break;
    lignes[k - 1].pts.push(...lignes[k].pts);
    lignes.splice(k, 1);
    lignes = fusionnerVoisines(lignes);
  }
  return lignes;
}

/** Unifie les lignes paralleles proches, d'une route a l'autre aussi. */
function aligner(toutes) {
  const parent = toutes.map((_, i) => i);
  const racine = i => (parent[i] === i ? i : (parent[i] = racine(parent[i])));
  const etendue = l => {
    let a = Infinity, b = -Infinity;
    for (const p of l.pts) { const t = position(l.axe, p); a = Math.min(a, t); b = Math.max(b, t); }
    return [a, b];
  };
  const et = toutes.map(etendue);
  for (let i = 0; i < toutes.length; i++) {
    for (let j = i + 1; j < toutes.length; j++) {
      const a = toutes[i], b = toutes[j];
      if (a.axe !== b.axe || Math.abs(a.c - b.c) > ALIGNEMENT) continue;
      if (et[i][0] > et[j][1] + ECART_ALIGN || et[j][0] > et[i][1] + ECART_ALIGN) continue;
      parent[racine(i)] = racine(j);
    }
  }
  const groupes = new Map();
  toutes.forEach((l, i) => {
    const r = racine(i);
    if (!groupes.has(r)) groupes.set(r, []);
    groupes.get(r).push(l);
  });
  for (const g of groupes.values()) {
    const n = g.reduce((s, l) => s + l.pts.length, 0);
    const c = g.reduce((s, l) => s + l.c * l.pts.length, 0) / n;
    // Axes droits : sur une case entiere. Diagonales : x-y entier suffit.
    for (const l of g) l.c = Math.round(c);
  }
}

const arrondir = p => ({ x: Math.round(p.x), y: Math.round(p.y) });

function dedoublonner(pts) {
  const res = [];
  for (const p of pts) {
    const d = res[res.length - 1];
    if (!d || d.x !== p.x || d.y !== p.y) res.push(p);
  }
  return res;
}

/**
 * Prolonge ou raccourcit un bout de route le long de son axe jusqu'a une
 * autre route dessinee, si elle passe a moins de ACCROCHE_BOUT cases.
 */
function accrocherBouts(routes) {
  const segs = [];
  routes.forEach((r, ri) => {
    for (let i = 1; i < r.points.length; i++) segs.push({ ri, a: r.points[i - 1], b: r.points[i] });
  });
  routes.forEach((r, ri) => {
    const n = r.points.length;
    if (n < 2) return;
    for (const [iBout, iVoisin] of [[0, 1], [n - 1, n - 2]]) {
      const bout = r.points[iBout], voisin = r.points[iVoisin];
      const dx = bout.x - voisin.x, dy = bout.y - voisin.y;
      const L = Math.hypot(dx, dy);
      if (!L) continue;
      let meilleur = null, dMeilleur = ACCROCHE_BOUT;
      for (const s of segs) {
        if (s.ri === ri) continue;
        if (distSegment(bout, s.a, s.b) > ACCROCHE_BOUT) continue;
        // Intersection de la droite (voisin -> bout) avec le segment s.
        const ex = s.b.x - s.a.x, ey = s.b.y - s.a.y;
        const det = dx * ey - dy * ex;
        if (!det) continue;
        const t = ((s.a.x - voisin.x) * ey - (s.a.y - voisin.y) * ex) / det;
        const u = ((s.a.x - voisin.x) * dy - (s.a.y - voisin.y) * dx) / det;
        if (u < -0.01 || u > 1.01 || t <= 0.2) continue;
        const p = { x: voisin.x + t * dx, y: voisin.y + t * dy };
        const d = Math.hypot(p.x - bout.x, p.y - bout.y);
        if (d <= dMeilleur) { dMeilleur = d; meilleur = p; }
      }
      if (meilleur) r.points[iBout] = arrondir(meilleur);
    }
    const propres = dedoublonner(r.points);
    if (propres.length > 1) r.points = propres;
  });
}

/**
 * Redresse une liste de routes [{nom, points}] ensemble. Renvoie de nouvelles
 * routes {nom, points, brut, redresse: true} ; brut garde le trace d'origine (ou celui deja
 * garde lors d'un redressage precedent).
 */
export function redresserRoutes(routes) {
  const decoupes = routes.map(r => {
    const brut = (r.brut && r.brut.length > 1 ? r.brut : r.points).map(p => ({ x: p.x, y: p.y }));
    if (brut.length < 2) return { r, brut, lignes: null };
    let lignes = lignesDe(brut);
    if (!lignes.length) return { r, brut, lignes: null };
    lignes = nettoyer(lignes, brut[0], brut[brut.length - 1]);
    return { r, brut, lignes };
  });
  aligner(decoupes.flatMap(d => d.lignes || []));
  const res = decoupes.map(({ r, brut, lignes }) => {
    const points = lignes
      ? dedoublonner(sommets(lignes, brut[0], brut[brut.length - 1]).map(arrondir))
      : brut.slice();
    return { ...r, points: points.length > 1 ? points : brut.slice(), brut, redresse: true };
  });
  accrocherBouts(res);
  return res;
}
