// Assemblage : evenements, panneau lateral, persistance.

import { EMPRISE, chargerGeometrie, pyramidesActives,
         mode, modeDisponible, ecartZoomModes } from './geometrie.js';
import {
  vue, echelle, zoomMin, zoomMax,
  initTuiles, dessinerTuiles, infoRendu, viderTuiles,
  deplacer, zoomer, centrerSur, cadrerSur, cadrerEmprise,
  ecranVersMondeX, ecranVersMondeY, centreMonde,
} from './vue.js';
import {
  CATEGORIES, etat, initMarqueurs, chargerMarqueurs, enregistrerFiltres,
  dessinerMarqueurs, reinitialiserAffichage, listerPour,
  nombreActifs, empriseActifs, definirActionTrajet,
} from './marqueurs.js';
import * as bases from './bases.js';
import * as trajet from './itineraire.js';
import * as joueur from './joueur.js';
import * as histo from './historique.js';
import { initRues, basculerRues, dessinerRues } from './rues.js';
import * as radio from './radio.js';
import * as vehicules from './vehicules.js';
import * as loot from './loot.js';
import { exporterVue } from './exporter.js';
import * as menu from './menu.js';
import * as pulse from './pulse.js';
import { initConstructions, basculerConstructions, dessinerConstructions,
         disponible as constructionsDisponibles,
         nombreCases as nbConstructions,
         surChargement as constructionsSurChargement,
         rechargerConstructions, surveillerConstructions } from './constructions.js';

const $ = id => document.getElementById(id);

const carte = $('carte');
const plan = $('plan');

// --- boucle de rendu -------------------------------------------------------

let rendementDemande = false;
let minuteurListe = 0;
let minuteurVue = 0;

/**
 * Le dessin (tuiles, rues, marqueurs, bandeau) suit le rythme de l'ecran.
 * Le tri de la liste laterale et l'ecriture dans localStorage sont differes :
 * les refaire a chaque image pendant un glisser fait saccader le deplacement.
 */
function demanderRendu(majListeAussi = false) {
  if (!rendementDemande) {
    rendementDemande = true;
    requestAnimationFrame(() => {
      rendementDemande = false;
      rendre();
    });
  }
  if (majListeAussi) {
    clearTimeout(minuteurListe);
    minuteurListe = setTimeout(majListe, 140);
  }
  clearTimeout(minuteurVue);
  minuteurVue = setTimeout(enregistrerVue, 400);
}

function rendre() {
  dessinerTuiles();
  dessinerRues();
  radio.dessinerRadio();
  histo.dessinerHistorique();
  trajet.dessinerItineraire();
  dessinerMarqueurs();
  vehicules.dessinerVehicules();
  bases.dessinerBases();
  joueur.dessinerJoueur();
  majHud();
}

function mesurer() {
  vue.largeur = carte.clientWidth;
  vue.hauteur = carte.clientHeight;
}

// --- bandeau d'information -------------------------------------------------

let sourisX = null, sourisY = null;

function majHud() {
  // Masque par defaut (Carte > Calques) : inutile de le recalculer a chaque image.
  if ($('hud').hidden) return;
  const info = infoRendu();
  if (!info) return;
  if (sourisX !== null) {
    $('hudX').textContent = Math.floor(ecranVersMondeX(sourisX, sourisY));
    $('hudY').textContent = Math.floor(ecranVersMondeY(sourisX, sourisY));
  }
  const ratio = info.facteurRendu;
  const modeRendu = ratio > 1.001 ? 'agrandi x' + Math.round(ratio)
             : ratio > 0.999 ? '1:1 pixel ecran'
             : 'reduit x' + (1 / ratio).toFixed(2);
  const tc = info.tailleCase;
  $('hudZoom').textContent =
    `${tc >= 1 ? tc : '1/' + Math.round(1 / tc)} px/case`
    + ` · ${info.mode === 'iso' ? 'isometrique' : 'vue de dessus'}`
    + ` · niveau ${info.niveau}/${info.niveauMax} · ${modeRendu}`
    + (info.sqr > 1 ? ` · source ${info.sqr} px/case` : '')
    + (info.dpr !== 1 ? ` · dpr ${info.dpr}` : '')
    + ` · ${info.tuiles} tuiles`;
  $('hudCompte').textContent = `${etat.visibles} affiches / ${nombreActifs()} actifs`;
}

// --- panneau des filtres ---------------------------------------------------

// Les onze categories sont rangees en trois familles. A plat sur deux
// colonnes, il fallait lire toutes les etiquettes pour retrouver la bonne ;
// la case de famille coche ou decoche ses categories d'un coup.
const FAMILLES = [
  { nom: 'Valeurs',     cles: ['top', 'or', 'billets', 'valeur'] },
  { nom: 'Equipement',  cles: ['armes', 'outils', 'metal'] },
  { nom: 'Survie',      cles: ['medical', 'bouffe', 'essence', 'labo'] },
];

function famillesCompletes() {
  // Une categorie ajoutee plus tard sans famille ne doit pas disparaitre.
  const rangees = new Set(FAMILLES.flatMap(f => f.cles));
  const orphelines = CATEGORIES.filter(c => !rangees.has(c.cle)).map(c => c.cle);
  return orphelines.length ? [...FAMILLES, { nom: 'Autres', cles: orphelines }] : FAMILLES;
}

function construireFiltres() {
  const hote = $('filtres');
  hote.innerHTML = '';
  const parCle = new Map(CATEGORIES.map(c => [c.cle, c]));
  for (const f of famillesCompletes()) {
    const cats = f.cles.map(k => parCle.get(k)).filter(Boolean);
    if (!cats.length) continue;
    const groupe = document.createElement('div');
    groupe.className = 'famille';
    const tete = document.createElement('label');
    tete.className = 'tete-famille';
    const total = cats.reduce((n, c) => n + (etat.compteurs[c.cle] || 0), 0);
    tete.innerHTML = `<input type="checkbox" data-famille><span class="nom"></span><i class="nb">${total}</i>`;
    tete.querySelector('.nom').textContent = f.nom;
    groupe.appendChild(tete);
    const corps = document.createElement('div');
    corps.className = 'cats';
    for (const c of cats) {
      const l = document.createElement('label');
      l.innerHTML =
        `<input type="checkbox" data-cat="${c.cle}" ${etat.filtres[c.cle] ? 'checked' : ''}>`
        + `<b class="pastille" style="background:${c.couleur};`
        + `background-image:url(icons/${c.cle}.png?v=4)"></b>`
        + `<span class="nom">${c.nom}</span>`
        + `<i class="nb">${etat.compteurs[c.cle] || 0}</i>`;
      corps.appendChild(l);
    }
    groupe.appendChild(corps);
    const caseFamille = tete.querySelector('[data-famille]');
    caseFamille.addEventListener('change', () => {
      for (const c of cats) etat.filtres[c.cle] = caseFamille.checked;
      appliquerFiltres();
    });
    hote.appendChild(groupe);
  }
  hote.querySelectorAll('[data-cat]').forEach(cb => {
    cb.addEventListener('change', () => {
      etat.filtres[cb.dataset.cat] = cb.checked;
      appliquerFiltres();
    });
  });
  majCasesFiltres();
}

/** Remet les cases d'accord avec etat.filtres, familles comprises. */
function majCasesFiltres() {
  const hote = $('filtres');
  hote.querySelectorAll('[data-cat]').forEach(cb => { cb.checked = !!etat.filtres[cb.dataset.cat]; });
  for (const g of hote.querySelectorAll('.famille')) {
    const cases = [...g.querySelectorAll('[data-cat]')];
    const n = cases.filter(cb => cb.checked).length;
    const cf = g.querySelector('[data-famille]');
    cf.checked = n === cases.length;
    cf.indeterminate = n > 0 && n < cases.length;
  }
}

function appliquerFiltres() {
  majCasesFiltres();
  enregistrerFiltres();
  reinitialiserAffichage();
  demanderRendu(true);
}

function toutCocher(valeur) {
  for (const c of CATEGORIES) etat.filtres[c.cle] = valeur;
  appliquerFiltres();
}

// --- liste laterale --------------------------------------------------------

// La liste etait refaite de zero a chaque deplacement : innerHTML = '' puis
// 200 lignes reconstruites en HTML. Mesure avant changement, 3514 marqueurs,
// 200 lignes : 8,4 ms en moyenne, 19,4 ms au pire, soit plus d'une trame a
// 60 Hz, et ca tombait 140 ms apres chaque geste.
//
// Maintenant les lignes sont creees une fois et reutilisees : on ne touche
// qu'au texte qui a change. Les lignes en trop sont cachees, pas detruites.
const lignesListe = [];

function ligneListe(i) {
  if (lignesListe[i]) return lignesListe[i];
  const el = document.createElement('div');
  el.className = 'ligne';
  el.innerHTML =
    '<div class="titre"><b class="pastille"></b><span class="nom"></span>'
    + '<button class="chrono"></button></div>'
    + '<div class="meta"></div><div class="loot"></div><div class="desc"></div>';
  const r = {
    el,
    pastille: el.querySelector('.pastille'),
    nom: el.querySelector('.nom'),
    chrono: el.querySelector('.chrono'),
    meta: el.querySelector('.meta'),
    loot: el.querySelector('.loot'),
    desc: el.querySelector('.desc'),
    index: -1,
  };
  el.addEventListener('click', () => { if (r.index >= 0) selectionner(r.index, true); });
  lignesListe[i] = r;
  $('liste').appendChild(el);
  return r;
}

function optionsListe() {
  const tri = document.querySelector('input[name="tri"]:checked');
  return {
    limite: 200,
    texte: $('recherche').value || '',
    tri: tri ? tri.value : 'distance',
    masquerPilles: $('masquerPilles').checked,
    filtreLoot: m => loot.date(m) > 0 && loot.estFrais(m),
  };
}

function majListe() {
  const hote = $('liste');
  const { total, lignes } = listerPour(optionsListe());
  let vide = hote.querySelector('.vide');
  if (!vide) {
    vide = document.createElement('p');
    vide.className = 'vide';
    hote.appendChild(vide);
  }
  vide.hidden = lignes.length > 0;
  if (!lignes.length) {
    vide.textContent = $('recherche').value
      ? 'Rien ne correspond a cette recherche.'
      : 'Aucune categorie cochee.';
  }

  let actif = null;
  lignes.forEach((entree, i) => {
    const { index, m, d2 } = entree;
    const r = ligneListe(i);
    r.index = index;
    r.el.hidden = false;
    const etatLoot = loot.etatTexte(m);
    const frais = etatLoot !== null && loot.estFrais(m);
    const classe = 'ligne'
      + (index === etat.selection ? ' active' : '')
      + (etatLoot === null ? '' : (frais ? ' pille' : ' repop'));
    if (r.el.className !== classe) r.el.className = classe;
    if (index === etat.selection) actif = r.el;

    const fond = `url(icons/${m.cat}.png?v=4)`;
    if (r.pastille.style.backgroundImage !== fond) r.pastille.style.backgroundImage = fond;
    majTexte(r.nom, m.t);
    majTexte(r.chrono, etatLoot ? '\u21bb' : 'pille');
    r.chrono.title = etatLoot ? 'Remettre a zero le chrono' : 'Marquer comme pille maintenant';
    r.chrono.dataset.index = index;
    majTexte(r.meta, `${m.cat} · x ${m.x} y ${m.y} z ${m.z} · ${Math.round(Math.sqrt(d2))} cases`);
    majTexte(r.loot, etatLoot || '');
    r.loot.hidden = !etatLoot;
    majTexte(r.desc, m.d || '');
    r.desc.hidden = !m.d;
  });
  for (let i = lignes.length; i < lignesListe.length; i++) {
    lignesListe[i].el.hidden = true;
    lignesListe[i].index = -1;
  }
  $('hudListe') && ($('hudListe').textContent = total);
  if (actif) actif.scrollIntoView({ block: 'nearest' });
}

function majTexte(el, valeur) {
  if (el.textContent !== valeur) el.textContent = valeur;
}

// Un seul ecouteur pose une fois pour toutes : la liste est reconstruite a
// chaque deplacement, poser un ecouteur par ligne les multiplierait.
$('liste').addEventListener('click', e => {
  const b = e.target.closest('.chrono');
  if (!b) return;
  e.stopPropagation();
  const m = etat.tous[+b.dataset.index];
  if (loot.date(m)) loot.effacer(m); else loot.marquer(m);
  majBandeauLoot();
  reinitialiserAffichage();
  demanderRendu(true);
});

function echapper(s) {
  return String(s).replace(/[&<>"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
}

function selectionner(index, recentrer) {
  etat.selection = index;
  const m = etat.tous[index];
  if (recentrer && m) centrerSur(m.x, m.y, Math.max(vue.zoom, 1));
  demanderRendu(true);
}

// --- navigation ------------------------------------------------------------

let glisse = null;
let glisseABouge = false;

carte.addEventListener('dragstart', e => e.preventDefault());
plan.addEventListener('dragstart', e => e.preventDefault());

carte.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  e.preventDefault();               // coupe le glisser-deposer natif des images
  glisse = { x: e.clientX, y: e.clientY, bouge: false };
  glisseABouge = false;
  carte.classList.add('glisse');
});

window.addEventListener('mousemove', e => {
  const r = carte.getBoundingClientRect();
  sourisX = e.clientX - r.left;
  sourisY = e.clientY - r.top;
  if (glisse) {
    const dx = e.clientX - glisse.x, dy = e.clientY - glisse.y;
    if (dx || dy) {
      glisse.bouge = true;
      glisseABouge = true;
      // Suivre ET deplacer la carte a la main sont incompatibles : sans ca,
      // la camera revient sur le joueur a chaque seconde, on ne peut plus
      // regarder ailleurs.
      if (joueur.etat.suivre) joueur.basculerSuivi(false);
      glisse.x = e.clientX; glisse.y = e.clientY;
      deplacer(dx, dy);
      demanderRendu(true);
      return;
    }
  }
  majHud();
});

window.addEventListener('mouseup', () => {
  glisse = null;
  carte.classList.remove('glisse');
});

// Un clic, c'est un mousedown suivi d'un mouseup sans deplacement. Sans ce
// test, tout glisser de la carte poserait une base ou une etape a l'arrivee.
carte.addEventListener('click', e => {
  if (glisseABouge) return;
  if (e.target.closest('.mq') || e.target.closest('.base')) return;
  if (clicCarte(e)) e.preventDefault();
});

// Un cran de molette = UN palier de zoom exact, jamais plus.
// L'amplitude du deltaY est ignoree : c'est elle qui produisait les echelles
// batardes type 1,25 dans l'ancien viewer. On accumule seulement pour que les
// pavés tactiles, qui envoient des dizaines de petits deltas, ne fassent pas
// traverser toute la pyramide d'un geste.
let accumulation = 0;
let dernierPalier = 0;
const SEUIL_MOLETTE = 24;     // un cran de souris classique vaut 100
const DELAI_PALIER = 80;      // ms mini entre deux paliers

carte.addEventListener('wheel', e => {
  e.preventDefault();
  if (Math.sign(e.deltaY) !== Math.sign(accumulation)) accumulation = 0;
  accumulation += e.deltaY;
  if (Math.abs(accumulation) < SEUIL_MOLETTE) return;

  const maintenant = performance.now();
  if (maintenant - dernierPalier < DELAI_PALIER) return;
  dernierPalier = maintenant;

  const sens = accumulation > 0 ? -1 : 1;   // molette vers le bas = dezoom
  accumulation = 0;
  const r = carte.getBoundingClientRect();
  zoomer(sens, e.clientX - r.left, e.clientY - r.top);
  demanderRendu(true);
}, { passive: false });

window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && (bases.etat.pose || trajet.etat.pose)) {
    bases.etat.pose = false;
    trajet.arreterPose();
    majConsigne();
    majPanneauBases();
    demanderRendu();
    return;
  }
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const pas = 120;
  if (e.key === '+' || e.key === '=') { zoomer(1, vue.largeur / 2, vue.hauteur / 2); demanderRendu(true); }
  else if (e.key === '-') { zoomer(-1, vue.largeur / 2, vue.hauteur / 2); demanderRendu(true); }
  else if (e.key === 'ArrowLeft') { deplacer(pas, 0); demanderRendu(true); }
  else if (e.key === 'ArrowRight') { deplacer(-pas, 0); demanderRendu(true); }
  else if (e.key === 'ArrowUp') { deplacer(0, pas); demanderRendu(true); }
  else if (e.key === 'ArrowDown') { deplacer(0, -pas); demanderRendu(true); }
  else if (e.key === 'f' || e.key === 'F') {
    if (!$('suivre').hidden) {
      if (joueur.etat.suivre) joueur.basculerSuivi(false);
      else joueur.basculerSuivi(true, 'moi');
    }
  }
  else if (e.key === 'v' || e.key === 'V') {
    const b = $('bascule');
    if (b && !b.hidden && !b.disabled) basculerMode(mode === 'iso' ? 'dessus' : 'iso');
  }
  else return;
  e.preventDefault();
});

window.addEventListener('resize', () => {
  const c = centreMonde();
  mesurer();
  centrerSur(c.x, c.y);
  demanderRendu(true);
});

// --- boutons ---------------------------------------------------------------

$('toutCocher').addEventListener('click', () => toutCocher(true));
$('rienCocher').addEventListener('click', () => toutCocher(false));

$('voirTout').addEventListener('click', () => {
  const b = empriseActifs();
  if (!b) return;
  cadrerSur(b.x0, b.y0, b.x1, b.y1);
  demanderRendu(true);
});

$('allerCoord').addEventListener('click', allerAuxCoordonnees);
$('coordX').addEventListener('keydown', e => { if (e.key === 'Enter') allerAuxCoordonnees(); });
$('coordY').addEventListener('keydown', e => { if (e.key === 'Enter') allerAuxCoordonnees(); });

function allerAuxCoordonnees() {
  const x = parseFloat($('coordX').value), y = parseFloat($('coordY').value);
  if (!isFinite(x) || !isFinite(y)) return;
  etat.selection = -1;
  centrerSur(x, y, Math.max(vue.zoom, 1));
  demanderRendu(true);
}

// Villes moddees : centre et cadrage deduits directement de la geometrie lue
// dans map_info.json, pas de coordonnees saisies a la main.
const selecteurVilles = $('villes');

function remplirVilles() {
  for (const p of pyramidesActives()) {
    if (!p.mod) continue;
    const o = document.createElement('option');
    o.value = p.nom;
    o.textContent = p.libelle;
    selecteurVilles.appendChild(o);
  }
}

selecteurVilles.addEventListener('change', function () {
  const p = pyramidesActives().find(q => q.nom === this.value);
  this.value = '';
  if (!p) return;
  cadrerSur(p.mondeX, p.mondeY, p.mondeX1, p.mondeY1, 30);
  demanderRendu(true);
});

$('slugger').addEventListener('click', () => {
  const i = etat.tous.findIndex(m => m.cat === 'top');
  if (i >= 0) selectionner(i, true);
});

$('calqueRues').addEventListener('change', function () {
  basculerRues(this.checked).then(() => demanderRendu());
  try { localStorage.setItem('pzcarte.rues', this.checked ? '1' : '0'); } catch (e) {}
  demanderRendu();
});

$('replier').addEventListener('click', () => {
  const c = centreMonde();          // on garde le meme point au centre
  document.body.classList.toggle('replie');
  mesurer();
  centrerSur(c.x, c.y);
  demanderRendu(true);
});

// --- suivi du loot ---------------------------------------------------------

function majBandeauLoot() {
  $('repopJeu').value = loot.repop();
  $('repopReel').textContent = `soit ${loot.duree(loot.repopMs())} en temps reel`;
  const n = loot.nombreSuivis();
  $('lootCompte').textContent = n ? `${n} lieu${n > 1 ? 'x' : ''} suivi${n > 1 ? 's' : ''}` : 'aucun lieu suivi';
  $('lootReset').disabled = !n;
}

function initLoot() {
  loot.charger();
  majBandeauLoot();

  const champ = $('repopJeu');
  const appliquer = () => {
    const v = parseFloat(champ.value.replace(',', '.'));
    if (!loot.definirRepop(v)) champ.value = loot.repop();   // valeur refusee
    majBandeauLoot();
    reinitialiserAffichage();
    demanderRendu(true);
  };
  champ.addEventListener('change', appliquer);
  champ.addEventListener('blur', appliquer);
  champ.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); appliquer(); } });

  $('lootReset').addEventListener('click', () => {
    if (!loot.nombreSuivis()) return;
    if (!confirm(`Effacer les ${loot.nombreSuivis()} chronos de loot ?`)) return;
    loot.toutEffacer();
    majBandeauLoot();
    reinitialiserAffichage();
    demanderRendu(true);
  });

  // Le temps passe meme sans interaction : on rafraichit l'affichage a un
  // rythme calme, un cinquantieme du delai de repop, borne entre 15 s et 5 min.
  const periode = Math.min(300000, Math.max(15000, loot.repopMs() / 50));
  setInterval(() => { majBandeauLoot(); demanderRendu(true); }, periode);
}

// --- export HD de la vue ---------------------------------------------------

function initExport() {
  const bouton = $('exportHD');
  const etat = $('etatExport');
  bouton.addEventListener('click', async () => {
    bouton.disabled = true;
    etat.className = 'reel';
    etat.textContent = 'preparation...';
    try {
      const r = await exporterVue(e => { etat.textContent = e; });
      const nom = `carte-pz-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.png`;
      const url = URL.createObjectURL(r.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = nom;
      a.click();
      // Liberer tout de suite ferait echouer le telechargement dans certains
      // navigateurs : on laisse une seconde.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      etat.className = 'reel ok';
      etat.textContent = `${r.largeur} x ${r.hauteur}`;
    } catch (e) {
      etat.className = 'reel erreur';
      etat.textContent = e.message || 'echec';
    } finally {
      bouton.disabled = false;
    }
  });
}

// --- synchronisation du releve de l'agent ----------------------------------

function initSync() {
  const bouton = $('sync' + 'Constructions');
  if (!bouton || bouton.dataset.pret) return;
  bouton.dataset.pret = '1';
  $('ligneSync').hidden = false;

  bouton.addEventListener('click', async () => {
    const etat = $('etatSync');
    bouton.disabled = true;
    etat.className = 'reel';
    etat.textContent = 'demarrage...';
    try {
      // L'en-tete X-Carte est ce qui autorise la requete cote serveur : une
      // page d'une autre origine ne peut pas le poser sans requete
      // preliminaire, a laquelle le serveur ne repond pas.
      const r = await fetch('/api/sync', { method: 'POST', headers: { 'X-Carte': 'sync' } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) {
        etat.className = 'reel erreur';
        etat.textContent = d.erreur || `erreur ${r.status}`;
        bouton.disabled = false;
        return;
      }
      // La synchronisation dure une quinzaine de minutes, le calcul des
      // tuiles etant long : on interroge son etat au lieu de garder une
      // requete ouverte, qu'aucun navigateur ne tolererait.
      await suivreSync(etat);
    } catch (e) {
      etat.className = 'reel erreur';
      etat.textContent = 'serveur injoignable';
    } finally {
      bouton.disabled = false;
    }
  });
}

/** Interroge l'etat de la synchronisation jusqu'a son terme. */
async function suivreSync(etat) {
  const LIBELLE = { releve: 'lecture du releve', tuiles: 'calcul des tuiles' };
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    let d;
    try {
      d = await (await fetch('/api/sync', { headers: { 'X-Carte': 'sync' } })).json();
    } catch (e) {
      etat.className = 'reel erreur';
      etat.textContent = 'serveur injoignable';
      return;
    }
    if (d.fini) {
      if (!d.ok) {
        etat.className = 'reel erreur';
        etat.textContent = d.erreur || 'echec';
        return;
      }
      etat.className = 'reel';
      etat.textContent = 'rechargement...';
      calqueExiste = true;
      // On vient de synchroniser pour VOIR le resultat : on coche le calque,
      // et on passe en iso si besoin, seule vue ou il existe.
      enregistrerPrefConstructions(true);
      if (mode !== 'iso') await basculerMode('iso');
      await rechargerConstructions();
      majCalqueConstructions();
      viderTuiles();
      demanderRendu(true);
      etat.className = 'reel ok';
      etat.textContent = `${nbConstructions()} cases`;
      return;
    }
    const min = Math.floor(d.secondes / 60), s = d.secondes % 60;
    etat.textContent = `${LIBELLE[d.etape] || d.etape || 'en cours'} · ${min}:${String(s).padStart(2, '0')}`;
  }
}

// --- calque des constructions -----------------------------------------------

// Le calque n'existe qu'en vue ISOMETRIQUE : rendre-calque.py le dessine avec
// les sprites iso du jeu, et la vue de dessus n'a pas de pyramide pour lui.
//
// Avant, cet etat n'etait evalue qu'au demarrage. Ouvrir la carte en vue de
// dessus cachait donc la case "mes constructions", decochait le calque, et
// rien ne la refaisait apparaitre en passant en iso. Une synchronisation
// lancee depuis la vue de dessus se terminait sur "4407428 cases" sans rien
// montrer nulle part.
let calqueExiste = false;

function prefConstructions() {
  try { return localStorage.getItem('pzcarte.constructions') !== '0'; } catch (e) { return true; }
}

function enregistrerPrefConstructions(v) {
  try { localStorage.setItem('pzcarte.constructions', v ? '1' : '0'); } catch (e) {}
}

function majCalqueConstructions() {
  const label = $('labelConstructions');
  const cb = $('calqueConstructions');
  const nb = $('nbConstructions');
  const iso = (mode === 'iso');
  label.hidden = !calqueExiste;
  if (!calqueExiste) { basculerConstructions(false); return; }
  const voulu = prefConstructions();
  cb.checked = voulu;
  // En vue de dessus la geometrie ne charge pas le calque : on le dit a cote
  // de la case, et la cocher bascule en iso.
  basculerConstructions(iso && voulu);
  nb.textContent = iso ? nbConstructions() + ' cases' : 'vue iso seulement';
  label.title = iso ? '' : "Le calque est dessine avec les sprites isometriques du jeu : il n'existe qu'en vue iso. Cocher la case y bascule.";
}

// --- bascule entre vue de dessus et isometrique ----------------------------

let basculeEnCours = false;

/**
 * Change de mode en conservant le point vise et la taille apparente des cases.
 *
 * Les deux modes n'ont pas la meme unite de plan : une case vaut 1 unite en vue
 * de dessus et 2*64 = 128 unites en iso. L'ecart de zoom equivalent est donc
 * log2(128) = 7 crans exactement, une puissance de deux, ce qui preserve la
 * regle "echelle = 2^zoom" et donc la nettete des deux cotes.
 */
async function basculerMode(vers) {
  if (basculeEnCours || vers === mode) return;
  basculeEnCours = true;
  const bouton = $('bascule');
  bouton.disabled = true;

  const centre = centreMonde();
  const zoomAvant = vue.zoom;
  const ecart = ecartZoomModes();
  const zoomVoulu = (vers === 'iso') ? zoomAvant - ecart : zoomAvant + ecart;
  const ancien = mode;

  try {
    const pyramides = await chargerGeometrie(vers);
    majCalqueConstructions();          // nouvelles pyramides : masque a remettre
    viderTuiles();
    centrerSur(centre.x, centre.y, zoomVoulu);
    majBascule();
    demanderRendu(true);
    console.info(`mode ${vers} :`, pyramides.map(p => p.nom).join(', '));
  } catch (e) {
    // Retour au mode precedent plutot que de laisser le viewer vide.
    console.error('bascule impossible :', e.message);
    await chargerGeometrie(ancien);
    majCalqueConstructions();
    viderTuiles();
    centrerSur(centre.x, centre.y, zoomAvant);
    majBascule();
    demanderRendu(true);
    alert(`Le rendu ${vers === 'iso' ? 'isometrique' : 'de dessus'} n'est pas disponible.`);
  } finally {
    bouton.disabled = false;
    basculeEnCours = false;
  }
}

function majBascule() {
  const b = $('bascule');
  if (!b) return;
  const iso = (mode === 'iso');
  b.textContent = iso ? 'vue de dessus' : 'vue isometrique';
  b.title = iso
    ? 'Repasser a la vue de dessus (touche V)'
    : 'Passer a la vue isometrique (touche V)';
  document.body.classList.toggle('mode-iso', iso);
}

// --- persistance de la vue -------------------------------------------------

function enregistrerVue() {
  try {
    const c = centreMonde();
    localStorage.setItem('pzcarte.vue.' + mode,
      JSON.stringify({ x: c.x, y: c.y, zoom: vue.zoom }));
    localStorage.setItem('pzcarte.mode', mode);
  } catch (e) {}
}

function restaurerVue() {
  try {
    const brut = localStorage.getItem('pzcarte.vue.' + mode);
    if (brut) {
      const v = JSON.parse(brut);
      if (isFinite(v.x) && isFinite(v.y) && isFinite(v.zoom)) {
        centrerSur(v.x, v.y, Math.max(zoomMin(), Math.min(zoomMax(), v.zoom)));
        return true;
      }
    }
  } catch (e) {}
  return false;
}

// --- onglets du panneau ----------------------------------------------------

// Deux niveaux : quatre grandes categories, chacune avec ses sous-onglets.
// Le reste du code ne parle que de sous-onglets ('bases', 'trajet'...) :
// allerOnglet('bases') ouvre aussi sa categorie.
let sousActif = 'lieux';

function initOnglets() {
  const boutons = [...document.querySelectorAll('#onglets button')];
  const parent = new Map();            // sous-onglet -> categorie
  const dernier = {};                  // categorie -> dernier sous-onglet vu
  for (const v of document.querySelectorAll('.volet')) {
    const sous = [...v.querySelectorAll('[data-sous-volet]')].map(s => s.dataset.sousVolet);
    for (const s of sous) parent.set(s, v.dataset.volet);
    dernier[v.dataset.volet] = sous[0];
  }
  try { Object.assign(dernier, JSON.parse(localStorage.getItem('pzcarte.sousOnglets') || '{}')); } catch (e) {}

  const montrer = (nom) => {
    // On accepte une categorie (on rouvre son dernier sous-onglet) ou un
    // sous-onglet. Les anciens noms enregistres retombent sur leurs pieds.
    if (nom === 'reglages') nom = 'calques';
    if (!parent.has(nom)) nom = dernier[nom] && parent.has(dernier[nom]) ? dernier[nom] : 'lieux';
    const cat = parent.get(nom);
    sousActif = nom;
    dernier[cat] = nom;
    for (const b of boutons) b.classList.toggle('actif', b.dataset.onglet === cat);
    for (const v of document.querySelectorAll('.volet')) v.hidden = v.dataset.volet !== cat;
    for (const b of document.querySelectorAll('.sous-onglets button')) {
      b.classList.toggle('actif', b.dataset.sous === nom);
    }
    for (const s of document.querySelectorAll('.sous-volet')) s.hidden = s.dataset.sousVolet !== nom;
    try {
      localStorage.setItem('pzcarte.onglet', nom);
      localStorage.setItem('pzcarte.sousOnglets', JSON.stringify(dernier));
    } catch (e) {}
    if (nom === 'lieux') majListe();
    if (nom === 'bases') majPanneauBases();
    if (nom === 'trajet') majPanneauTrajet();
    // Les traces ne se dessinent que quand on les regarde, ou si on les a
    // epinglees : sinon elles encombreraient la carte en permanence.
    histo.afficher(nom === 'traces' || $('traceEpingler').checked);
    if (nom === 'traces') ouvrirTraces();
    pulse.onglet(nom === 'fiche');
  };
  for (const b of boutons) b.addEventListener('click', () => montrer(b.dataset.onglet));
  for (const b of document.querySelectorAll('.sous-onglets button')) {
    b.addEventListener('click', () => montrer(b.dataset.sous));
  }
  let voulu = 'lieux';
  try { voulu = localStorage.getItem('pzcarte.onglet') || 'lieux'; } catch (e) {}
  montrer(voulu);
  return montrer;
}

let allerOnglet = () => {};

// --- recherche et tri de la liste ------------------------------------------

function initListe() {
  let minuteur = 0;
  const relancer = () => {
    clearTimeout(minuteur);
    minuteur = setTimeout(majListe, 120);
  };
  $('recherche').addEventListener('input', relancer);
  $('recherche').addEventListener('search', relancer);
  $('masquerPilles').addEventListener('change', majListe);
  for (const r of document.querySelectorAll('input[name="tri"]')) {
    r.addEventListener('change', majListe);
  }
}

// --- consigne flottante ----------------------------------------------------

function consigne(texte) {
  const el = $('consigne');
  el.textContent = texte || '';
  el.hidden = !texte;
  document.body.classList.toggle('pose-en-cours', !!texte);
}

function majConsigne() {
  if (bases.etat.pose) {
    consigne('Clique sur la carte pour poser la base. Echap pour annuler.');
  } else if (trajet.etat.attenteDepart) {
    consigne('Clique ton point de depart sur la carte. Echap pour annuler.');
  } else if (trajet.etat.pose) {
    consigne(trajet.etat.mode === 'auto'
      ? 'Clique les points de passage. Le trajet suit les routes. Echap pour arreter.'
      : trajet.etat.mode === 'route'
        ? 'Clique les points de ta route, puis "enregistrer" dans le panneau. Echap pour arreter.'
        : 'Clique les points de passage. Trace en ligne droite. Echap pour arreter.');
  } else {
    consigne('');
  }
}

// --- bases -----------------------------------------------------------------

function majPanneauBases() {
  const hote = $('listeBases');
  hote.textContent = '';
  $('nbBases').textContent = bases.etat.liste.length + (bases.etat.liste.length > 1 ? ' bases' : ' base');
  $('nbBasesOnglet').textContent = bases.etat.liste.length || '';
  $('poserBase').classList.toggle('actif', bases.etat.pose);
  if (!bases.etat.liste.length) {
    const p = document.createElement('p');
    p.className = 'vide';
    p.textContent = 'Aucune base posee.';
    hote.appendChild(p);
    return;
  }
  for (const b of bases.etat.liste) {
    hote.appendChild(carteBase(b));
  }
}

function carteBase(b) {
  const el = document.createElement('div');
  el.className = 'carte-base';

  const tete = document.createElement('div');
  tete.className = 'tete';
  const puce = document.createElement('b');
  puce.className = 'puce';
  puce.style.background = b.couleur;
  const nom = document.createElement('input');
  nom.className = 'nom';
  nom.value = b.nom;
  nom.addEventListener('change', () => bases.modifier(b.id, { nom: nom.value.trim() || 'Base' }));
  tete.appendChild(puce);
  tete.appendChild(nom);
  el.appendChild(tete);

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = `x ${b.x}  y ${b.y}  z ${b.z}`;
  el.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'actions';
  actions.appendChild(bouton('aller', () => {
    bases.etat.selection = b.id;
    centrerSur(b.x, b.y, Math.max(vue.zoom, 1));
    demanderRendu(true);
  }));
  actions.appendChild(bouton('depart', () => {
    partirDe(b);
  }));
  actions.appendChild(bouton('arrivee', () => {
    allerVers(b);
  }));
  actions.appendChild(bouton('supprimer', () => {
    if (confirm(`Supprimer la base "${b.nom}" ?`)) {
      bases.supprimer(b.id);
      demanderRendu();
    }
  }));
  const couleurs = document.createElement('div');
  couleurs.className = 'couleurs';
  for (const [c] of bases.COULEURS) {
    const p = document.createElement('b');
    p.style.background = c;
    p.title = 'changer la couleur';
    p.addEventListener('click', () => { bases.modifier(b.id, { couleur: c }); demanderRendu(); });
    couleurs.appendChild(p);
  }
  actions.appendChild(couleurs);
  el.appendChild(actions);
  return el;
}

function bouton(texte, action) {
  const b = document.createElement('button');
  b.textContent = texte;
  b.addEventListener('click', action);
  return b;
}

function initBasesPanneau() {
  $('poserBase').addEventListener('click', () => {
    bases.etat.pose = !bases.etat.pose;
    if (bases.etat.pose) trajet.arreterPose();
    majConsigne();
    majPanneauBases();
  });
  $('baseIci').addEventListener('click', () => {
    const c = centreMonde();
    poserBase(c.x, c.y);
  });
  $('calqueBases').addEventListener('change', function () {
    bases.etat.visible = this.checked;
    demanderRendu();
  });
  $('exporterBases').addEventListener('click', () => {
    const blob = new Blob([bases.exporterJSON()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'bases-pz.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    dire($('etatBases'), `${bases.etat.liste.length} exportees`, 'ok');
  });
  $('importerBases').addEventListener('click', () => {
    const champ = document.createElement('input');
    champ.type = 'file';
    champ.accept = 'application/json,.json';
    champ.addEventListener('change', async () => {
      const f = champ.files && champ.files[0];
      if (!f) return;
      try {
        const n = bases.importerJSON(await f.text());
        dire($('etatBases'), `${n} ajoutee${n > 1 ? 's' : ''}`, 'ok');
        demanderRendu();
      } catch (e) {
        dire($('etatBases'), e.message || 'fichier illisible', 'erreur');
      }
    });
    champ.click();
  });
}

function dire(el, texte, classe) {
  el.className = 'reel' + (classe ? ' ' + classe : '');
  el.textContent = texte;
}

function poserBase(x, y) {
  const b = bases.ajouter(x, y, 0);
  bases.etat.pose = false;
  bases.etat.selection = b.id;
  majConsigne();
  allerOnglet('bases');
  demanderRendu();
}

// --- trajet ----------------------------------------------------------------

function partirDe(p) {
  const suite = trajet.etat.etapes.slice(1);
  trajet.definirEtapes([{ x: p.x, y: p.y }, ...suite]);
  allerOnglet('trajet');
}

function allerVers(p) {
  const debut = trajet.etat.etapes.length ? [trajet.etat.etapes[0]] : [];
  trajet.definirEtapes([...debut, { x: p.x, y: p.y }]);
  allerOnglet('trajet');
}

/**
 * "trajet jusqu'ici" depuis une pastille. Le depart est la base
 * selectionnee, a defaut la premiere base posee, a defaut le depart deja
 * present. Sans aucun des trois, on pose l'arrivee et on demande le depart.
 */
function trajetVers(m) {
  const base = bases.trouver(bases.etat.selection) || bases.etat.liste[0] || null;
  const depart = base ? { x: base.x, y: base.y }
    : (trajet.etat.etapes[0] || null);
  if (depart) {
    trajet.definirEtapes([depart, { x: m.x, y: m.y }]);
  } else {
    trajet.attendreDepart({ x: m.x, y: m.y });
  }
  allerOnglet('trajet');
}

function initTrajetPanneau() {
  definirActionTrajet(trajetVers);
  for (const b of document.querySelectorAll('[data-trajet]')) {
    b.addEventListener('click', () => {
      const m = b.dataset.trajet;
      if (m === 'off') {
        trajet.arreterPose();
      } else {
        bases.etat.pose = false;
        trajet.definirMode(m);
      }
      majConsigne();
      majPanneauBases();
    });
  }
  $('trajetVider').addEventListener('click', () => trajet.vider());
  $('routeEnregistrer').addEventListener('click', () => {
    if (trajet.enregistrerBrouillon($('nomRoute').value)) $('nomRoute').value = '';
  });
  $('routeRetour').addEventListener('click', () => trajet.annulerPointBrouillon());
  $('routeAbandon').addEventListener('click', () => trajet.abandonnerBrouillon());
  $('evitToutes').addEventListener('click', () => trajet.eviterToutes(true));
  $('guidage').addEventListener('change', function () { trajet.activerGuidage(this.checked); });
  $('evitAucune').addEventListener('click', () => trajet.eviterToutes(false));
  $('trajetInverser').addEventListener('click', () => {
    trajet.definirEtapes(trajet.etat.etapes.slice().reverse());
  });
  $('trajetCadrer').addEventListener('click', () => {
    const pts = trajet.etat.trace || trajet.etat.etapes;
    if (!pts || !pts.length) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    cadrerSur(x0, y0, x1, y1, 60);
    demanderRendu(true);
  });
}

function majPanneauTrajet() {
  for (const b of document.querySelectorAll('[data-trajet]')) {
    const m = b.dataset.trajet;
    b.classList.toggle('actif', m === 'off' ? !trajet.etat.pose : m === trajet.etat.mode);
  }
  const t = trajet.etat;
  const enRoute = t.mode === 'route';
  const pose = t.pose
    ? (enRoute ? 'Chaque clic ajoute un point a la route. Echap pour arreter.'
      : 'Chaque clic sur la carte ajoute une etape. Echap pour arreter.')
    : 'Choisis GPS ou ligne droite pour poser des etapes sur la carte. '
      + 'Depuis l\'onglet Bases, "depart" et "arrivee" remplissent le trajet.';
  $('aideTrajet').textContent = pose + ' ' + (t.mode === 'auto'
    ? "GPS : le trajet ne roule que sur les cases de chaussee lues dans les tuiles du jeu (bitume, gravier, chemins de terre), a 4 cases pres. Une etape posee hors route rejoint la plus proche a pied, en pointilles."
    : enRoute
      ? 'Route dessinee : une fois enregistree, le GPS peut l\'emprunter comme une vraie route. Pratique pour un chemin dans les bois ou une breche dans une cloture.'
      : 'Ligne droite : les etapes se relient sans tenir compte du terrain.');
  $('boutonsBrouillon').hidden = !enRoute;
  $('boutonsEtapes').hidden = enRoute;
  $('routeEnregistrer').disabled = t.brouillon.length < 2;
  $('routeRetour').disabled = !t.brouillon.length;
  majVillesEtRoutes();
  $('guidage').checked = t.guidage;
  $('ligneGuidage').hidden = t.mode !== 'auto';
  const g = $('etatGuidage');
  g.textContent = !t.guidage ? ''
    : !joueur.enDirect() ? 'en attente de ta position en direct (jeu lance, agent actif)'
    : (t.guide || 'suit ta position') + (t.etapes.length > 1 && t.prochaine < t.etapes.length
      ? ' · prochaine etape : ' + (t.prochaine + 1) : '');

  const r = $('resumeTrajet');
  r.textContent = '';
  if (enRoute) {
    if (t.brouillon.length) {
      const gros = document.createElement('div');
      gros.className = 'gros';
      let d = 0;
      for (let i = 1; i < t.brouillon.length; i++) {
        d += Math.hypot(t.brouillon[i].x - t.brouillon[i - 1].x, t.brouillon[i].y - t.brouillon[i - 1].y);
      }
      gros.textContent = t.brouillon.length + ' points, ' + Math.round(d).toLocaleString('fr-FR') + ' cases';
      r.appendChild(gros);
    }
  } else if (trajet.etat.distance > 0) {
    const gros = document.createElement('div');
    gros.className = 'gros';
    gros.textContent = trajet.etat.distance.toLocaleString('fr-FR') + ' cases';
    r.appendChild(gros);
    if (t.distanceAcces > 0) {
      const a = document.createElement('div');
      a.className = 'aide';
      a.textContent = 'dont ' + Math.round(t.distanceAcces).toLocaleString('fr-FR')
        + ' cases a pied pour rejoindre la route';
      r.appendChild(a);
    }
    const tab = document.createElement('table');
    for (const [nom, secondes] of trajet.durees()) {
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      a.textContent = nom;
      const b = document.createElement('td');
      b.className = 'v';
      b.textContent = dureeTexte(secondes);
      tr.appendChild(a); tr.appendChild(b);
      tab.appendChild(tr);
    }
    r.appendChild(tab);
    const note = document.createElement('div');
    note.className = 'aide';
    note.textContent = 'Vitesses supposees (1,4 / 3 / 14 cases par seconde), '
      + 'pas mesurees dans le jeu : a prendre comme un ordre de grandeur.';
    r.appendChild(note);
  }
  if (trajet.etat.message && !enRoute) {
    const m = document.createElement('div');
    m.className = 'aide';
    m.textContent = trajet.etat.message;
    r.appendChild(m);
  }

  const hote = $('listeEtapes');
  hote.textContent = '';
  trajet.etat.etapes.forEach((p, i) => {
    const el = document.createElement('div');
    el.className = 'etape'
      + (i === 0 ? ' depart' : '')
      + (i === trajet.etat.etapes.length - 1 && i > 0 ? ' arrivee' : '');
    const rang = document.createElement('b');
    rang.className = 'rang';
    rang.textContent = String(i + 1);
    const ou = document.createElement('span');
    ou.className = 'ou';
    ou.textContent = `x ${p.x}  y ${p.y}`;
    el.appendChild(rang);
    el.appendChild(ou);
    el.appendChild(bouton('voir', () => {
      centrerSur(p.x, p.y, Math.max(vue.zoom, 1));
      demanderRendu(true);
    }));
    el.appendChild(bouton('x', () => trajet.retirerEtape(i)));
    hote.appendChild(el);
  });
}

function majVillesEtRoutes() {
  const t = trajet.etat;
  const hote = $('listeVilles');
  hote.textContent = '';
  if (!t.zones.length) {
    const p = document.createElement('span');
    p.className = 'aide';
    p.textContent = trajet.reseauPret() ? 'aucune ville connue' : 'chargement du reseau...';
    hote.appendChild(p);
  }
  for (const z of t.zones) {
    const l = document.createElement('label');
    const c = document.createElement('input');
    c.type = 'checkbox';
    c.checked = t.evitees.includes(z.nom);
    c.addEventListener('change', () => trajet.eviterVille(z.nom, c.checked));
    l.appendChild(c);
    l.appendChild(document.createTextNode(z.nom));
    hote.appendChild(l);
  }
  $('nbEvitees').textContent = t.evitees.length ? t.evitees.length + ' evitee' + (t.evitees.length > 1 ? 's' : '') : '';
  if (t.evitees.length) $('blocVilles').open = true;

  const lr = $('listeRoutes');
  lr.textContent = '';
  $('nbRoutes').textContent = t.routes.length ? String(t.routes.length) : '';
  if (!t.routes.length) {
    const p = document.createElement('p');
    p.className = 'aide';
    p.textContent = 'Aucune. Bouton "dessiner une route" plus haut.';
    lr.appendChild(p);
  }
  t.routes.forEach((route, i) => {
    const el = document.createElement('div');
    el.className = 'etape';
    const rang = document.createElement('b');
    rang.className = 'rang';
    rang.textContent = String(i + 1);
    const ou = document.createElement('span');
    ou.className = 'ou';
    ou.textContent = route.nom + ' · ' + trajet.longueurRoute(route).toLocaleString('fr-FR') + ' cases';
    el.appendChild(rang);
    el.appendChild(ou);
    el.appendChild(bouton('voir', () => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of route.points) {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
        y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
      }
      cadrerSur(x0, y0, x1, y1, 60);
      demanderRendu(true);
    }));
    el.appendChild(bouton('x', () => {
      if (confirm('Supprimer la route "' + route.nom + '" ?')) trajet.supprimerRoute(i);
    }));
    lr.appendChild(el);
  });
}

function dureeTexte(s) {
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0');
  return Math.floor(s / 3600) + ' h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
}

// --- joueur en direct -------------------------------------------------------

function majJoueurUI() {
  trajet.suivrePosition(joueur.positionMoi(), joueur.enDirect());
  const b = $('suivre');
  // Le bouton n'apparait que si une position existe : sans agent dans le jeu,
  // il n'y a personne a suivre.
  b.hidden = !joueur.etat.actif || !joueur.moi();
  b.classList.toggle('actif', joueur.etat.suivre);
  const nom = joueur.nomSuivi();
  b.textContent = !nom ? 'me suivre' : (nom === 'toi' ? 'suivi actif' : 'suit ' + nom);
  $('etatJoueur').textContent = joueur.texteEtat();
  $('calqueJoueur').checked = joueur.etat.actif;
  majListeJoueurs();
}

// Liste des autres joueurs : reconstruite seulement si elle a change, sinon
// on la referait chaque seconde pour rien.
let signatureJoueurs = '';

function majListeJoueurs() {
  const hote = $('listeJoueurs');
  const l = joueur.etat.actif ? joueur.autres() : [];
  const t = joueur.etat.t;
  const sig = l.map(j => [j.cle, j.n, j.distance, j.vuA === t, j.proche,
                          joueur.etat.suivre && joueur.etat.cible === j.cle].join(':')).join('|');
  if (sig === signatureJoueurs) return;
  signatureJoueurs = sig;
  hote.textContent = '';
  const bloc = $('blocJoueurs');
  // Rien a montrer tant qu'on n'a pas de position, ou si le jeu est ferme
  // depuis longtemps (les autres sont alors oublies).
  bloc.hidden = !joueur.moi() || (!l.length && !joueur.enDirect());
  if (bloc.hidden) return;
  $('resumeJoueurs').textContent = l.length
    ? `${l.length} autre${l.length > 1 ? 's' : ''} joueur${l.length > 1 ? 's' : ''} en jeu`
    : 'aucun autre joueur';
  if (!l.length) {
    const p = document.createElement('div');
    p.className = 'aide';
    p.textContent = "Ton client ne connait personne d'autre : personne a portee, "
      + 'ou le serveur ne partage pas les positions sur la carte.';
    hote.appendChild(p);
  }
  for (const j of l) {
    const ligne = document.createElement('div');
    ligne.className = 'ligne-joueur' + (j.vuA === t ? '' : ' absent');
    const nom = document.createElement('span');
    nom.className = 'nom';
    nom.textContent = j.n || ('joueur ' + j.id);
    const info = document.createElement('span');
    info.className = 'info';
    info.textContent = (j.distance !== null ? j.distance + ' cases' : '')
      + (j.proche ? '' : ' · loin')
      + (j.vuA === t ? '' : ' · vu il y a ' + joueur.dureeCourte((t - j.vuA) / 1000));
    const suivre = bouton(joueur.etat.suivre && joueur.etat.cible === j.cle ? 'arreter' : 'suivre', () => {
      const deja = joueur.etat.suivre && joueur.etat.cible === j.cle;
      joueur.basculerSuivi(!deja, j.cle);
    });
    ligne.appendChild(nom);
    ligne.appendChild(info);
    ligne.appendChild(suivre);
    hote.appendChild(ligne);
  }
}

function initJoueurPanneau() {
  let actif = true;
  try { actif = localStorage.getItem('pzcarte.joueur') !== '0'; } catch (e) {}
  joueur.initJoueur($('joueurCalque'), majJoueurUI, () => demanderRendu());
  joueur.activer(actif);
  $('calqueJoueur').addEventListener('change', function () {
    joueur.activer(this.checked);
    try { localStorage.setItem('pzcarte.joueur', this.checked ? '1' : '0'); } catch (e) {}
  });
  // Le bouton suit TOI. Si tu suis deja quelqu'un, il arrete le suivi.
  $('suivre').addEventListener('click', () => {
    if (joueur.etat.suivre) joueur.basculerSuivi(false);
    else joueur.basculerSuivi(true, 'moi');
  });
}

// --- fiche du personnage (PZ Pulse) ------------------------------------------

function construireCasesPulse() {
  const hote = $('pulseCases');
  hote.textContent = '';
  for (const g of pulse.MESURES) {
    const titre = document.createElement('div');
    titre.className = 'pulse-groupe';
    titre.textContent = g.groupe;
    hote.appendChild(titre);
    const grille = document.createElement('div');
    grille.className = 'pulse-grille';
    for (const m of g.cles) {
      const l = document.createElement('label');
      const c = document.createElement('input');
      c.type = 'checkbox';
      c.checked = pulse.etat.coches.has(m.cle);
      c.addEventListener('change', () => pulse.cocher(m.cle, c.checked));
      l.appendChild(c);
      l.append(' ' + m.nom);
      grille.appendChild(l);
    }
    hote.appendChild(grille);
  }
}

function majPulseUI() {
  $('etatPulse').textContent = pulse.resume();
}

function ouvrirPulse() {
  if (!pulse.ouvrirFenetre()) {
    $('etatPulse').textContent = 'fenetre bloquee par le navigateur : autorise les fenetres surgissantes pour la carte';
  }
}

function initPulsePanneau() {
  pulse.initPulse($('pulseCarte'), majPulseUI);
  construireCasesPulse();
  $('pulseOuvrir').addEventListener('click', ouvrirPulse);
  $('pulseCarte').addEventListener('click', ouvrirPulse);
  $('pulseRien').addEventListener('click', () => {
    for (const m of pulse.MESURES.flatMap(g => g.cles)) pulse.cocher(m.cle, false);
    construireCasesPulse();
  });
  $('pulseDefaut').addEventListener('click', () => {
    const defaut = new Set(['sante', 'faim', 'soif', 'fatigue', 'endurance']);
    for (const m of pulse.MESURES.flatMap(g => g.cles)) pulse.cocher(m.cle, defaut.has(m.cle));
    construireCasesPulse();
  });

  // L'encadre technique du bas (coordonnees, zoom) : masque sauf demande.
  let hud = false;
  try { hud = localStorage.getItem('pzcarte.hud') === '1'; } catch (e) {}
  $('calqueHud').checked = hud;
  $('hud').hidden = !hud;
  $('calqueHud').addEventListener('change', function () {
    $('hud').hidden = !this.checked;
    try { localStorage.setItem('pzcarte.hud', this.checked ? '1' : '0'); } catch (e) {}
    demanderRendu();
  });
}

// --- traces (historique des deplacements) ------------------------------------

async function ouvrirTraces() {
  if (histo.etat.jours.length && histo.etat.jour) { majTracesUI(); return; }
  const jours = await histo.chargerJours();
  remplirJours(jours);
  if (jours.length) {
    await histo.chargerJour(jours[0].jour);
    histo.cadrer();
  }
  majTracesUI();
}

function remplirJours(jours) {
  const sel = $('traceJour');
  sel.textContent = '';
  if (!jours.length) {
    sel.appendChild(new Option('aucun jour enregistre', ''));
    return;
  }
  const auj = histo.aujourdhui();
  for (const j of jours) {
    const d = new Date(j.jour + 'T12:00:00');
    const libelle = (j.jour === auj ? "aujourd'hui, " : '')
      + d.toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' })
      + ' · ' + (j.octets < 1e6 ? Math.round(j.octets / 1024) + ' Ko' : (j.octets / 1e6).toFixed(1) + ' Mo');
    sel.appendChild(new Option(libelle, j.jour));
  }
  if (histo.etat.jour) sel.value = histo.etat.jour;
}

// Curseur 0..1000 <-> instant dans la journee affichee.
function versT(v) {
  const e = histo.etat;
  return e.tMin + (e.tMax - e.tMin) * (v / 1000);
}
function versCurseur(t) {
  const e = histo.etat;
  return e.tMax > e.tMin ? Math.round(1000 * (t - e.tMin) / (e.tMax - e.tMin)) : 0;
}

function majTracesUI() {
  const e = histo.etat;
  $('traceAide').textContent = e.erreur
    || (e.jour ? 'Trait plein a pied, pointille en vehicule. Un cercle marque un arret de plus de 3 min.' : '');

  // Joueurs du jour, avec leur couleur.
  const hote = $('traceJoueurs');
  const sig = e.joueurs.map(j => j.id + (j.visible ? '1' : '0')).join('|') + e.jour;
  if (hote.dataset.sig !== sig) {
    hote.dataset.sig = sig;
    hote.textContent = '';
    for (const j of e.joueurs) {
      const l = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = j.visible;
      // On retrouve le joueur par son id AU MOMENT du clic. Le jour en cours
      // se recharge toutes les 30 s et recree les fiches : une fermeture sur
      // 'j' modifierait une fiche remplacee, et cocher ne ferait plus rien.
      const id = j.id;
      cb.addEventListener('change', () => {
        const actuel = e.joueurs.find(x => x.id === id);
        if (actuel) actuel.visible = cb.checked;
        majTracesUI();
        demanderRendu();
      });
      const t = document.createElement('i');
      t.className = 'teinte';
      t.style.background = j.couleur;
      l.appendChild(cb);
      l.appendChild(t);
      l.appendChild(document.createTextNode(j.id === 'moi' ? 'toi' : (j.n || j.id)));
      hote.appendChild(l);
    }
  }

  if (e.tMin !== null) {
    $('traceDebut').value = versCurseur(e.debut);
    $('traceFin').value = versCurseur(e.fin);
    $('traceDebutTxt').textContent = histo.heure(e.debut);
    $('traceFinTxt').textContent = histo.heure(e.lecture ?? e.fin);
  }
  $('traceLire').textContent = e.lecture !== null ? 'reprendre' : 'rejouer';

  // Statistiques des joueurs coches, sur la plage.
  const st = $('traceStats');
  st.textContent = '';
  for (const j of e.joueurs) {
    if (!j.visible) continue;
    const s = histo.stats(j);
    const bloc = document.createElement('div');
    bloc.className = 'stat-joueur';
    const h = document.createElement('h4');
    const t = document.createElement('i');
    t.className = 'teinte';
    t.style.cssText = `display:inline-block;width:14px;height:4px;border-radius:2px;background:${j.couleur}`;
    h.appendChild(t);
    h.appendChild(document.createTextNode(j.id === 'moi' ? 'toi' : (j.n || j.id)));
    bloc.appendChild(h);
    const lignes = s.points ? [
      ['de', histo.heure(s.premier) + ' a ' + histo.heure(s.dernier)],
      ['a pied', s.pied.toLocaleString('fr-FR') + ' cases'],
      ['en vehicule', s.vehicule.toLocaleString('fr-FR') + ' cases'],
      ['en mouvement', histo.duree(s.bouge)],
      ['arrets de 3 min ou plus', String(s.arrets)],
    ] : [['', 'aucun point sur cette plage']];
    const table = document.createElement('table');
    for (const [k, v] of lignes) {
      const tr = document.createElement('tr');
      const a = document.createElement('td'); a.textContent = k;
      const b = document.createElement('td'); b.className = 'v'; b.textContent = v;
      tr.appendChild(a); tr.appendChild(b);
      table.appendChild(tr);
    }
    bloc.appendChild(table);
    st.appendChild(bloc);
  }
}

function initTracesPanneau() {
  histo.initHistorique($('historique'), majTracesUI, () => demanderRendu());
  $('traceJour').addEventListener('change', async function () {
    if (!this.value) return;
    histo.arreter();
    await histo.chargerJour(this.value);
    histo.cadrer();
  });
  $('traceRafraichir').addEventListener('click', async () => {
    remplirJours(await histo.chargerJours());
    if (histo.etat.jour) await histo.chargerJour(histo.etat.jour, true);
  });
  // Les deux curseurs ne peuvent pas se croiser.
  $('traceDebut').addEventListener('input', function () {
    const e = histo.etat;
    if (e.tMin === null) return;
    e.debut = Math.min(versT(+this.value), e.fin);
    if (e.lecture !== null && e.lecture < e.debut) e.lecture = e.debut;
    majTracesUI(); demanderRendu();
  });
  $('traceFin').addEventListener('input', function () {
    const e = histo.etat;
    if (e.tMin === null) return;
    e.fin = Math.max(versT(+this.value), e.debut);
    if (e.lecture !== null && e.lecture > e.fin) e.lecture = e.fin;
    majTracesUI(); demanderRendu();
  });
  $('traceCadrer').addEventListener('click', () => histo.cadrer());
  $('traceLire').addEventListener('click', () => histo.lire(+$('traceVitesse').value));
  $('traceVitesse').addEventListener('change', function () { histo.etat.vitesse = +this.value; });
  $('traceArreter').addEventListener('click', () => histo.arreter());
  let epingle = false;
  try { epingle = localStorage.getItem('pzcarte.traces.epingle') === '1'; } catch (e) {}
  $('traceEpingler').checked = epingle;
  $('traceEpingler').addEventListener('change', function () {
    try { localStorage.setItem('pzcarte.traces.epingle', this.checked ? '1' : '0'); } catch (e) {}
    histo.afficher(this.checked || sousActif === 'traces');
    if (this.checked) ouvrirTraces();
  });
  // Epinglees depuis une session precedente : on charge tout de suite, quel
  // que soit l'onglet ouvert.
  if (epingle) ouvrirTraces();
}

// --- portees radio -------------------------------------------------------

function centreRadio(cle) {
  if (cle === 'moi') {
    const p = joueur.positionMoi();
    return p ? { ...p, nom: 'toi' } : null;
  }
  if (cle === 'epingle') return radio.etat.epingle;
  const b = bases.trouver(cle);
  return b ? { x: b.x, y: b.y, nom: b.nom } : null;
}

/** Le menu des centres suit la liste des bases : il est refait a chaque fois. */
function majCentresRadio() {
  const sel = $('radioCentre');
  const options = [['moi', 'centre : ma position']];
  if (radio.etat.epingle) {
    options.push(['epingle', `centre : point epingle (${radio.etat.epingle.x}, ${radio.etat.epingle.y})`]);
  }
  for (const b of bases.etat.liste) options.push([b.id, 'centre : base ' + b.nom]);
  if (!options.some(o => o[0] === radio.etat.centre)) radio.etat.centre = 'moi';
  sel.innerHTML = '';
  for (const [v, t] of options) {
    const o = document.createElement('option');
    o.value = v; o.textContent = t;
    sel.appendChild(o);
  }
  sel.value = radio.etat.centre;
}

function initRadioPanneau() {
  radio.initRadio($('radio'), centreRadio);
  $('calqueRadio').checked = radio.etat.actif;
  const hote = $('radioModeles');
  let posteVu = false;
  for (const m of radio.MODELES) {
    if (m.poste && !posteVu) {
      posteVu = true;
      hote.insertAdjacentHTML('beforeend', '<div class="sep">postes radio</div>');
    }
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox"><i></i><span></span><em class="portee"></em>`;
    const c = l.querySelector('input');
    c.checked = radio.etat.modeles.has(m.id);
    l.querySelector('i').style.borderColor = m.couleur;
    l.querySelector('span').textContent = m.nom + (m.fixe ? ' (fixe)' : '');
    l.querySelector('em').textContent = m.portee.toLocaleString('fr-FR');
    l.title = m.id;
    c.addEventListener('change', () => {
      if (c.checked) radio.etat.modeles.add(m.id); else radio.etat.modeles.delete(m.id);
      // Cocher un modele, c'est vouloir le voir : le calque s'allume avec.
      if (c.checked && !radio.etat.actif) { radio.etat.actif = true; $('calqueRadio').checked = true; }
      radio.enregistrer();
      demanderRendu();
    });
    hote.appendChild(l);
  }
  $('calqueRadio').addEventListener('change', function () {
    radio.etat.actif = this.checked;
    radio.enregistrer();
    demanderRendu();
  });
  $('radioCentre').addEventListener('change', function () {
    radio.etat.centre = this.value;
    radio.enregistrer();
    demanderRendu();
  });
  $('radioEpingler').addEventListener('click', () => {
    const c = centreMonde();
    radio.etat.epingle = { x: Math.round(c.x), y: Math.round(c.y) };
    radio.etat.centre = 'epingle';
    radio.etat.actif = true;
    $('calqueRadio').checked = true;
    radio.enregistrer();
    majCentresRadio();
    demanderRendu();
  });
  $('radioCadrer').addEventListener('click', () => {
    const c = radio.centre(), r = radio.porteeMax();
    if (!c || !r) return;
    cadrerSur(c.x - r, c.y - r, c.x + r, c.y + r);
    demanderRendu(true);
  });
  majCentresRadio();
}

// --- vehicules ---------------------------------------------------------------

const LISTE_VEHICULES_MAX = 15;

function majVehiculesUI() {
  const n = vehicules.nombres();
  $('nbVehicules').textContent = n.presents ? String(n.presents) : '';
  $('nbVehiculesVus').textContent = n.vus ? String(n.vus) : '';
  $('nbVehiculesOnglet').textContent = vehicules.etat.actif && n.presents ? String(n.presents) : '';
  $('etatVehicules').textContent = vehicules.texteEtat();

  // Les plus proches, pour retrouver une voiture sans chercher le carre.
  const hote = $('listeVehicules');
  hote.textContent = '';
  if (!vehicules.etat.actif) return;
  for (const v of vehicules.presents().slice(0, LISTE_VEHICULES_MAX)) {
    const l = document.createElement('div');
    l.className = 'ligne-vh';
    l.innerHTML = '<i></i><span></span><em></em>';
    l.querySelector('i').style.background = vehicules.couleur(v.c);
    l.querySelector('span').textContent = v.n || v.s || 'vehicule';
    const bouts = [v.distance + ' cases'];
    if (v.reservoir > 0) bouts.push(Math.round(v.essence / v.reservoir * 100) + ' % ess.');
    if (v.macle || v.contact || v.porte) bouts.push('cle');
    l.querySelector('em').textContent = bouts.join(' · ');
    l.addEventListener('click', () => {
      if (joueur.etat.suivre) joueur.basculerSuivi(false);
      centrerSur(v.x, v.y, Math.max(vue.zoom, 2));
      vehicules.ouvrirFiche(v.k);
      demanderRendu();
    });
    hote.appendChild(l);
  }
  vehicules.majFiche();
}

function initVehiculesPanneau() {
  vehicules.initVehicules($('vehiculesCalque'), majVehiculesUI, () => demanderRendu());
  const cases = [['calqueVehicules', 'actif'], ['calqueVehiculesVus', 'anciens']];
  for (const [id, cle] of cases) {
    $(id).checked = vehicules.etat[cle];
    $(id).addEventListener('change', function () {
      vehicules.etat[cle] = this.checked;
      vehicules.enregistrer();
      majVehiculesUI();
      demanderRendu();
    });
  }
}

// --- clic sur la carte -----------------------------------------------------

function clicCarte(e) {
  const r = carte.getBoundingClientRect();
  const ex = e.clientX - r.left, ey = e.clientY - r.top;
  const x = ecranVersMondeX(ex, ey), y = ecranVersMondeY(ex, ey);
  if (bases.etat.pose) {
    poserBase(x, y);
    return true;
  }
  if (trajet.etat.pose) {
    trajet.ajouterEtape(x, y);
    return true;
  }
  return false;
}

// --- clic droit : actions rapides --------------------------------------------

// Le menu du navigateur ("Enregistrer l'image sous...") ne sert a rien sur
// une carte. On le remplace par les actions qu'on fait le plus souvent a un
// endroit precis : trajet, base, talkies, coordonnees. Maj + clic droit rend
// le menu du navigateur, pour qui en aurait besoin.

let minuteurAnnonce = 0;

/** Message bref dans la consigne flottante, puis retour a la consigne normale. */
function annoncer(texte) {
  clearTimeout(minuteurAnnonce);
  consigne(texte);
  document.body.classList.remove('pose-en-cours');
  minuteurAnnonce = setTimeout(majConsigne, 1600);
}

async function copier(texte) {
  try {
    await navigator.clipboard.writeText(texte);
  } catch (e) {
    // Hors contexte securise (fichier ouvert en file://), l'API est refusee :
    // on passe par une zone de texte temporaire.
    const z = document.createElement('textarea');
    z.value = texte;
    z.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(z);
    z.select();
    const ok = document.execCommand('copy');
    z.remove();
    if (!ok) { annoncer('copie impossible : ' + texte); return; }
  }
  annoncer('copie : ' + texte);
}

function entreesMarqueur(index) {
  const m = etat.tous[index];
  if (!m) return [];
  const suivi = loot.date(m) > 0;
  return [
    { titre: m.t, sous: m.cat },
    { libelle: suivi ? 'remettre le chrono a zero' : 'marquer comme pille', action: () => {
      if (suivi) loot.effacer(m); else loot.marquer(m);
      majBandeauLoot();
      reinitialiserAffichage();
      demanderRendu(true);
    } },
    { libelle: 'trajet jusqu\'ici', aide: 'depuis ta base', action: () => trajetVers(m) },
    { libelle: 'voir dans la liste', action: () => {
      $('recherche').value = '';
      allerOnglet('lieux');
      selectionner(index, false);
    } },
    { sep: true },
  ];
}

function entreesBase(id) {
  const b = bases.trouver(id);
  if (!b) return [];
  return [
    { titre: b.nom, sous: 'base' },
    { libelle: 'gerer la base', aide: 'nom, couleur', action: () => {
      bases.etat.selection = b.id;
      allerOnglet('bases');
      demanderRendu();
    } },
    { libelle: 'supprimer la base', action: () => {
      if (confirm(`Supprimer la base "${b.nom}" ?`)) { bases.supprimer(b.id); demanderRendu(); }
    } },
    { sep: true },
  ];
}

function entreesVehicule(cle) {
  const v = vehicules.trouver(cle);
  if (!v) return [];
  return [
    { titre: v.n || v.s || 'vehicule', sous: 'vehicule' },
    { libelle: 'ouvrir la fiche', action: () => { vehicules.ouvrirFiche(cle); demanderRendu(); } },
    { sep: true },
  ];
}

function menuCarte(e) {
  const r = carte.getBoundingClientRect();
  const ex = e.clientX - r.left, ey = e.clientY - r.top;
  const x = ecranVersMondeX(ex, ey), y = ecranVersMondeY(ex, ey);
  const cx = Math.floor(x), cy = Math.floor(y);
  const ici = { x, y };

  // Ce qu'il y a sous la souris passe en premier.
  const mq = e.target.closest('.mq');
  const base = e.target.closest('.base');
  const vh = e.target.closest('.vh');
  const specifiques = mq ? entreesMarqueur(+mq.dataset.index)
    : base ? entreesBase(base.dataset.id)
    : vh ? entreesVehicule(vh.dataset.cle)
    : [];

  const moi = joueur.positionMoi();
  const distance = moi ? Math.round(Math.hypot(moi.x - x, moi.y - y)) : null;
  const etapes = trajet.etat.etapes;

  menu.ouvrir(e.clientX, e.clientY, [
    ...specifiques,
    { titre: `x ${cx} · y ${cy}`,
      sous: distance !== null ? `a ${distance.toLocaleString('fr-FR')} cases de toi` : '' },
    { libelle: 'copier les coordonnees', aide: `${cx}, ${cy}`, action: () => copier(`${cx}, ${cy}`) },
    { libelle: 'centrer la vue ici', action: () => { centrerSur(x, y); demanderRendu(true); } },
    { libelle: 'zoomer ici', action: () => { zoomer(1, ex, ey); demanderRendu(true); },
      desactive: vue.zoom >= zoomMax() },
    { sep: true },
    { libelle: 'aller ici', aide: moi ? 'depuis ta position' : 'arrivee du trajet', action: () => {
      if (moi) trajet.definirEtapes([moi, ici]);
      else allerVers(ici);
      allerOnglet('trajet');
    } },
    { libelle: 'partir d\'ici', aide: 'depart du trajet', action: () => partirDe(ici) },
    etapes.length > 0 && { libelle: 'ajouter une etape ici', aide: `etape ${etapes.length + 1}`,
      action: () => { trajet.ajouterEtape(x, y); allerOnglet('trajet'); } },
    { sep: true },
    { libelle: 'poser une base ici', action: () => poserBase(x, y) },
    { libelle: 'centrer les talkies ici', aide: 'portee radio', action: () => {
      radio.etat.epingle = { x: cx, y: cy };
      radio.etat.centre = 'epingle';
      radio.etat.actif = true;
      $('calqueRadio').checked = true;
      radio.enregistrer();
      majCentresRadio();
      demanderRendu();
    } },
    moi && { libelle: 'me suivre', aide: 'touche F', action: () => joueur.basculerSuivi(true, 'moi') },
    { libelle: 'ouvrir la fiche du personnage', aide: 'PZ Pulse', action: ouvrirPulse },
  ]);
}

carte.addEventListener('contextmenu', e => {
  if (e.shiftKey) return;              // menu du navigateur, a la demande
  e.preventDefault();
  menuCarte(e);
});

// --- demarrage -------------------------------------------------------------

async function demarrer() {
  initTuiles(plan);
  initRues($('rues'));
  initConstructions();
  initMarqueurs($('marqueurs'), i => selectionner(i, false));
  // majConsigne dans les deux rappels : le mode peut changer autrement que
  // par le bouton (Echap, une base posee, un depart choisi depuis une fiche),
  // et la consigne flottante doit suivre dans tous les cas.
  bases.initBases($('bases'), () => { majPanneauBases(); majConsigne(); majCentresRadio(); demanderRendu(); });
  trajet.initItineraire($('trace'), () => { majPanneauTrajet(); majConsigne(); demanderRendu(); });
  mesurer();

  // La geometrie est lue dans les fichiers de rendu : le viewer s'adapte tout
  // seul a un rendu 1 px ou 2 px par case, et a l'un ou l'autre mode.
  let modeVoulu = 'dessus';
  try { modeVoulu = localStorage.getItem('pzcarte.mode') || 'dessus'; } catch (e) {}
  if (!(await modeDisponible(modeVoulu))) {
    modeVoulu = (modeVoulu === 'iso') ? 'dessus' : 'iso';
  }

  const [pyramides] = await Promise.all([chargerGeometrie(modeVoulu), chargerMarqueurs()]);
  console.info('pyramides chargees :', pyramides.map(
    p => `${p.nom} ${p.w}x${p.h} sqr=${p.sqr} tuile=${p.tailleTuile} niveaux 0..${p.niveauMax}`).join(' | '));
  // Le bouton n'a de sens que si l'autre rendu existe reellement sur le disque.
  const autre = (mode === 'iso') ? 'dessus' : 'iso';
  const bascPossible = await modeDisponible(autre);
  $('bascule').hidden = !bascPossible;
  majBascule();
  if (bascPossible) {
    $('bascule').addEventListener('click',
      () => basculerMode(mode === 'iso' ? 'dessus' : 'iso'));
  }

  initLoot();
  initExport();
  initListe();
  initBasesPanneau();
  initTrajetPanneau();
  initJoueurPanneau();
  initTracesPanneau();
  initRadioPanneau();
  initVehiculesPanneau();
  initPulsePanneau();
  allerOnglet = initOnglets();
  // Les deux panneaux ne sont rafraichis qu'a l'ouverture de leur onglet :
  // sans ce premier passage, le compteur de bases reste vide tant qu'on n'y
  // est pas alle une fois.
  majPanneauBases();
  majPanneauTrajet();
  remplirVilles();
  construireFiltres();
  enregistrerFiltres();   // fige l'etat par defaut des la premiere ouverture

  // Calque des constructions : la case est branchee une fois pour toutes,
  // son etat est ensuite recalcule a chaque changement de vue.
  calqueExiste = await fetch('map_data/constructions/info.json', { method: 'HEAD' })
    .then(r => r.ok).catch(() => false);
  $('calqueConstructions').addEventListener('change', async e => {
    enregistrerPrefConstructions(e.target.checked);
    if (e.target.checked && mode !== 'iso') {
      await basculerMode('iso');       // le calque n'existe qu'en iso
    }
    majCalqueConstructions();
    demanderRendu();
  });
  $('ligneSync').hidden = false;       // la premiere synchro cree le calque
  initSync();
  majCalqueConstructions();
  // Le rendu progressif ecrit des tuiles en continu : on les affiche au fil
  // de l'eau, sans bouton ni rechargement de la page.
  surveillerConstructions(() => { majCalqueConstructions(); demanderRendu(); });

  try {
    if (localStorage.getItem('pzcarte.rues') === '1') {
      $('calqueRues').checked = true;
      basculerRues(true).then(() => demanderRendu());
    }
  } catch (e) {}

  if (!restaurerVue()) {
    // Premiere ouverture : on cadre sur l'emprise complete, Raven Creek incluse.
    cadrerEmprise(20);
  }
  demanderRendu(true);
}

// Service worker : ouverture instantanee de la fenetre d'application et
// fonctionnement meme serveur eteint. Il ne met en cache que la coquille,
// jamais les tuiles, voir sw.js.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .catch(e => console.warn('service worker non enregistre :', e.message));
  });
}

demarrer().catch(err => {
  document.body.insertAdjacentHTML('afterbegin',
    `<pre class="erreur">Echec du demarrage : ${echapper(err.message)}</pre>`);
});
