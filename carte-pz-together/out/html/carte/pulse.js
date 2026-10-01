// Fiche du personnage, facon PZ Pulse.
//
// L'agent du jeu ecrit pulse.json (meme contenu que le data.txt du mod PZ
// Pulse) ; le serveur le sert sur /api/pulse. Deux usages :
//   - la page complete du mod, dans une seconde fenetre (ouvrirFenetre) ;
//   - quelques valeurs cochees, affichees en bas a gauche de la carte.
//
// Le releve ne tourne que si une valeur est cochee ou si l'onglet est ouvert :
// sinon personne ne le lit.

const CLE = 'pzcarte.pulse.carte';

// Ce qu'on peut epingler sur la carte. "besoin" renvoie a l'id ecrit par
// l'agent dans data.needs (le libelle anglais en minuscules).
export const MESURES = [
  { groupe: 'Sante', cles: [
    { cle: 'sante', nom: 'sante' },
    { cle: 'blessures', nom: 'blessures' },
    { cle: 'douleur', nom: 'douleur', besoin: 'pain' },
    { cle: 'maladie', nom: 'maladie', besoin: 'sickness' },
    { cle: 'temperature', nom: 'temperature' },
  ] },
  { groupe: 'Besoins', cles: [
    { cle: 'faim', nom: 'faim', besoin: 'hunger' },
    { cle: 'soif', nom: 'soif', besoin: 'thirst' },
    { cle: 'fatigue', nom: 'fatigue', besoin: 'fatigue' },
    { cle: 'endurance', nom: 'endurance', besoin: 'stamina' },
    { cle: 'mouille', nom: 'mouille', besoin: 'wetness' },
    { cle: 'ivresse', nom: 'ivresse', besoin: 'drunkenness' },
  ] },
  { groupe: 'Moral', cles: [
    { cle: 'stress', nom: 'stress', besoin: 'stress' },
    { cle: 'panique', nom: 'panique', besoin: 'panic' },
    { cle: 'ennui', nom: 'ennui', besoin: 'boredom' },
    { cle: 'tristesse', nom: 'tristesse', besoin: 'unhappiness' },
    { cle: 'humeurs', nom: 'humeurs actives' },
  ] },
  { groupe: 'Equipement', cles: [
    { cle: 'charge', nom: 'charge portee' },
    { cle: 'arme', nom: 'arme en main' },
  ] },
  { groupe: 'Partie', cles: [
    { cle: 'tues', nom: 'zombies tues' },
    { cle: 'survie', nom: 'temps survecu' },
  ] },
];

const DEFAUT = ['sante', 'faim', 'soif', 'fatigue', 'endurance'];

export const etat = {
  coches: new Set(DEFAUT),
  fiche: null,          // derniere reponse de /api/pulse
  erreur: null,         // texte si pas de fiche
  ongletOuvert: false,
};

let hote = null, surMaj = () => {}, minuteur = 0, enCours = false;

export function initPulse(element, rappel) {
  hote = element;
  surMaj = rappel || surMaj;
  try {
    const s = localStorage.getItem(CLE);
    if (s !== null) etat.coches = new Set(JSON.parse(s));
  } catch (e) {}
  relancer();
}

export function cocher(cle, oui) {
  if (oui) etat.coches.add(cle); else etat.coches.delete(cle);
  try { localStorage.setItem(CLE, JSON.stringify([...etat.coches])); } catch (e) {}
  dessiner();
  relancer();
}

export function onglet(ouvert) {
  etat.ongletOuvert = ouvert;
  relancer();
}

/** La page du mod, dans sa propre fenetre, reutilisee si elle est deja ouverte. */
export function ouvrirFenetre() {
  const w = window.open('/pulse.html?d=/api/pulse/', 'pzpulse',
    'popup=yes,width=1280,height=860');
  if (w) w.focus();
  return !!w;
}

function actif() { return etat.coches.size > 0 || etat.ongletOuvert; }

function relancer() {
  clearTimeout(minuteur);
  if (!actif()) { hote && (hote.hidden = true); return; }
  if (!enCours) interroger();
}

async function interroger() {
  enCours = true;
  try {
    const r = await fetch('/api/pulse', { headers: { 'X-Carte': 'pulse' }, cache: 'no-store' });
    const d = await r.json();
    if (d.ok) { etat.fiche = d; etat.erreur = null; }
    else { etat.fiche = null; etat.erreur = d.erreur || 'fiche indisponible'; }
  } catch (e) {
    etat.fiche = null;
    etat.erreur = 'serveur de la carte injoignable';
  }
  enCours = false;
  dessiner();
  surMaj();
  if (!actif()) return;
  // Fraiche : au rythme de l'agent. Perimee (jeu ferme) : on ralentit.
  const frais = fraiche();
  minuteur = setTimeout(interroger, frais ? Math.max(500, etat.fiche.interval || 1000) : 5000);
}

export function fraiche() {
  const f = etat.fiche;
  return !!f && f.age !== null && f.age < 6 && f.etat === 'play' && !!f.data;
}

export function resume() {
  const f = etat.fiche;
  if (!f) return etat.erreur || 'en attente de la fiche...';
  if (f.age === null || f.age >= 6) return `pas de nouvelles du jeu depuis ${duree(f.age)}`;
  if (f.etat === 'dead') return 'personnage mort';
  if (f.etat !== 'play' || !f.data) return 'pas de personnage (menu ou chargement)';
  const n = f.data.info?.name;
  return `en direct${n ? ' : ' + n : ''}`;
}

function duree(s) {
  if (s === null || s === undefined) return '?';
  if (s < 90) return Math.round(s) + ' s';
  if (s < 5400) return Math.round(s / 60) + ' min';
  return Math.round(s / 3600) + ' h';
}

// --- encadre sur la carte ---------------------------------------------------

function ligne(nom, valeur, pct, mauvais) {
  // pct : 0..100 ou null (pas de barre). mauvais : la barre vire au rouge
  // quand elle se remplit (faim) ou quand elle se vide (sante).
  const d = document.createElement('div');
  d.className = 'pl';
  const n = document.createElement('span');
  n.className = 'pl-nom';
  n.textContent = nom;
  d.appendChild(n);
  if (pct !== null && pct !== undefined) {
    const b = document.createElement('span');
    b.className = 'pl-barre';
    const i = document.createElement('i');
    const p = Math.max(0, Math.min(100, pct));
    i.style.width = p + '%';
    const gravite = mauvais === 'haut' ? p : 100 - p;
    i.className = gravite >= 60 ? 'grave' : gravite >= 30 ? 'moyen' : '';
    b.appendChild(i);
    d.appendChild(b);
  }
  const v = document.createElement('b');
  v.textContent = valeur;
  d.appendChild(v);
  return d;
}

function besoin(data, id) {
  return (data.needs || []).find(n => (n.id || String(n.label).toLowerCase()) === id);
}

function lignesPour(cle, data) {
  const def = MESURES.flatMap(g => g.cles).find(m => m.cle === cle);
  if (!def) return [];
  if (def.besoin) {
    const n = besoin(data, def.besoin);
    if (!n) return [];
    return [ligne(def.nom, n.value + ' %', n.value, n.badHigh ? 'haut' : 'bas')];
  }
  switch (cle) {
    case 'sante': {
      const h = data.health;
      return h ? [ligne('sante', h.overall + ' %', h.overall, 'bas')] : [];
    }
    case 'blessures': {
      const parts = (data.health?.parts || []).filter(p => (p.flags || []).some(
        f => f !== 'Bandaged' && f !== 'Splinted'));
      if (!parts.length) return [ligne('blessures', 'aucune', null)];
      return parts.map(p => ligne(p.name, p.flags.filter(f => f !== 'Bandaged').map(traduireFlag).join(', ')
        + ((p.flags || []).includes('Bandaged') ? ' (bande)' : ''), null));
    }
    case 'temperature': {
      const t = data.bodytemp;
      if (!t) return [];
      return [ligne('temperature', t.coreC ? t.coreC.toFixed(1) + ' °C' : t.core + ' %', null)];
    }
    case 'humeurs': {
      const m = data.moodles || [];
      if (!m.length) return [ligne('humeurs', 'aucune', null)];
      return m.map(x => ligne(x.label, x.valence === 'good' ? '+' + x.level : '•'.repeat(x.level), null));
    }
    case 'charge': {
      const e = data.encumbrance;
      if (!e || e.max === undefined) return [];
      return [ligne('charge', `${e.load} / ${e.max}`, Math.min(100, e.ratio), 'haut')];
    }
    case 'arme': {
      const items = data.weapon?.items || [];
      if (!items.length) return [ligne('arme', 'mains nues', null)];
      return items.map(w => {
        let v = w.cond !== undefined ? w.cond + ' %' : '';
        if (w.ammoMax) v += ` · ${w.ammo}/${w.ammoMax}`;
        if (w.broken) v = 'cassee';
        if (w.jammed) v += ' · enrayee';
        return ligne(w.name, v, w.broken ? 0 : w.cond, 'bas');
      });
    }
    case 'tues':
      return data.info ? [ligne('zombies tues', String(data.info.zombieKills ?? 0), null)] : [];
    case 'survie':
      return data.info?.timeSurvived ? [ligne('survie', data.info.timeSurvived, null)] : [];
  }
  return [];
}

const FLAGS = {
  'Bleeding': 'saigne', 'Deep wound': 'plaie profonde', 'Fracture': 'fracture', 'Burn': 'brulure',
  'Bitten': 'MORSURE', 'Scratched': 'griffure', 'Cut': 'coupure', 'Bullet': 'balle',
  'Glass': 'verre', 'Infected': 'infectee', 'Splinted': 'attelle',
};
function traduireFlag(f) { return FLAGS[f] || f; }

export function dessiner() {
  if (!hote) return;
  const data = fraiche() ? etat.fiche.data : null;
  if (!etat.coches.size || !data) {
    // Rien de coche, ou rien de frais a montrer : l'encadre disparait au lieu
    // d'afficher des valeurs perimees comme si elles etaient en direct.
    hote.hidden = !etat.coches.size;
    if (!hote.hidden) {
      hote.textContent = '';
      const t = document.createElement('div');
      t.className = 'pl-etat';
      t.textContent = resume();
      hote.appendChild(t);
    }
    return;
  }
  hote.hidden = false;
  hote.textContent = '';
  for (const g of MESURES) {
    for (const m of g.cles) {
      if (!etat.coches.has(m.cle)) continue;
      for (const l of lignesPour(m.cle, data)) hote.appendChild(l);
    }
  }
}
