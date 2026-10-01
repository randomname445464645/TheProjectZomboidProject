// Suivi du loot : date du dernier passage sur chaque lieu, et delai de repop.
//
// Les valeurs par defaut ne sont pas inventees, elles viennent des reglages
// reels du serveur PZ together, lus dans le journal du jeu (~/Zomboid/console.txt) :
//
//   HoursForLootRespawn 187     delai de repop, en HEURES DE JEU
//   DayLength 5                 indice d'enumeration, pas une duree
//
// media/lua/shared/Translate/EN/Sandbox_EN.txt donne la correspondance :
// Sandbox_DayLength_option5 vaut "2 Hours". Une journee de jeu dure donc
// 2 heures reelles, une heure de jeu vaut 5 minutes reelles, et les 187 heures
// de jeu font 15 h 35 min reelles.
//
// L'horodatage est stocke par POSITION et non par marqueur : 19 lieux portent
// deux marqueurs (le butin et la piece), et les piller c'est le meme geste.

export const REPOP_JEU_DEFAUT = 187;      // heures de jeu, reglage du serveur

// DayLength = 2 h reelles pour une journee de jeu, soit 120 minutes reelles
// pour 24 heures de jeu : une heure de jeu vaut exactement 5 minutes reelles.
// On garde des entiers, un 2/24 flottant faisait retomber 187 h juste sous la
// minute et affichait 15 h 34 au lieu de 15 h 35.
export const MINUTES_REELLES_PAR_JOUR_JEU = 120;
const MS_REELLES_PAR_HEURE_JEU = MINUTES_REELLES_PAR_JOUR_JEU * 60000 / 24;

const CLE_DATES = 'pzcarte.loot';
const CLE_REPOP = 'pzcarte.repop';

let dates = {};        // "x|y|z" -> instant en ms
let repopJeu = REPOP_JEU_DEFAUT;

export function cle(m) { return `${m.x}|${m.y}|${m.z}`; }

export function charger() {
  try {
    const brut = localStorage.getItem(CLE_DATES);
    if (brut) {
      const o = JSON.parse(brut);
      if (o && typeof o === 'object') dates = o;
    }
    const r = parseFloat(localStorage.getItem(CLE_REPOP));
    if (isFinite(r) && r > 0) repopJeu = r;
  } catch (e) { /* stockage indisponible : on tourne en memoire */ }
}

function enregistrer() {
  try { localStorage.setItem(CLE_DATES, JSON.stringify(dates)); } catch (e) {}
}

/** Delai de repop en heures de jeu. */
export function repop() { return repopJeu; }

export function definirRepop(heuresJeu) {
  if (!isFinite(heuresJeu) || heuresJeu <= 0) return false;
  repopJeu = heuresJeu;
  try { localStorage.setItem(CLE_REPOP, String(heuresJeu)); } catch (e) {}
  return true;
}

/** Delai de repop converti en millisecondes reelles. */
export function repopMs() {
  return Math.round(repopJeu * MS_REELLES_PAR_HEURE_JEU);
}

export function date(m) { return dates[cle(m)] || 0; }

/** Horodate le lieu a maintenant. Retourne l'instant pose. */
export function marquer(m) {
  const t = Date.now();
  dates[cle(m)] = t;
  enregistrer();
  return t;
}

export function effacer(m) {
  delete dates[cle(m)];
  enregistrer();
}

export function toutEffacer() {
  dates = {};
  enregistrer();
}

export function nombreSuivis() { return Object.keys(dates).length; }

/** Le lieu a-t-il ete pille depuis moins d'un cycle de repop ? */
export function estFrais(m) {
  const t = date(m);
  return t > 0 && (Date.now() - t) < repopMs();
}

/** Progression vers le repop, de 0 a 1. Vaut 1 des que c'est repop. */
export function avancement(m) {
  const t = date(m);
  if (!t) return 1;
  return Math.min(1, (Date.now() - t) / repopMs());
}

/** Duree lisible : "2 h 13", "3 j", "41 min". */
export function duree(ms) {
  if (ms < 0) ms = 0;
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'moins d’une minute';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${String(min % 60).padStart(2, '0')}`;
  const j = Math.floor(h / 24);
  return `${j} j ${h % 24} h`;
}

/** Texte d'etat d'un lieu, ou null s'il n'a jamais ete marque. */
export function etatTexte(m) {
  const t = date(m);
  if (!t) return null;
  const ecoule = Date.now() - t;
  const reste = repopMs() - ecoule;
  const quand = ecoule < 60000 ? 'pille a l’instant' : `pille il y a ${duree(ecoule)}`;
  if (reste <= 0) return `${quand} · repop fait`;
  // Arrondi a la minute SUPERIEURE : sinon on annonce 15 h 34 une milliseconde
  // apres avoir pose un chrono de 15 h 35.
  return `${quand} · repop dans ${duree(Math.ceil(reste / 60000) * 60000)}`;
}
