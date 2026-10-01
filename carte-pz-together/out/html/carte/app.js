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
import * as loot from './loot.js';
import { exporterVue } from './exporter.js';
import { initConstructions, basculerConstructions, dessinerConstructions,
         disponible as constructionsDisponibles,
         nombreCases as nbConstructions,
         surChargement as constructionsSurChargement,
         rechargerConstructions } from './constructions.js';

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
  histo.dessinerHistorique();
  trajet.dessinerItineraire();
  dessinerMarqueurs();
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

function construireFiltres() {
  const hote = $('filtres');
  hote.innerHTML = '';
  for (const c of CATEGORIES) {
    const l = document.createElement('label');
    l.innerHTML =
      `<input type="checkbox" data-cat="${c.cle}" ${etat.filtres[c.cle] ? 'checked' : ''}>`
      + `<b class="pastille" style="background:${c.couleur};`
      + `background-image:url(icons/${c.cle}.png?v=4)"></b>`
      + `<span class="nom">${c.nom}</span>`
      + `<i class="nb">${etat.compteurs[c.cle] || 0}</i>`;
    hote.appendChild(l);
  }
  hote.querySelectorAll('[data-cat]').forEach(cb => {
    cb.addEventListener('change', () => {
      etat.filtres[cb.dataset.cat] = cb.checked;
      enregistrerFiltres();
      reinitialiserAffichage();
      demanderRendu(true);
    });
  });
}

function toutCocher(valeur) {
  for (const c of CATEGORIES) etat.filtres[c.cle] = valeur;
  document.querySelectorAll('#filtres [data-cat]').forEach(cb => { cb.checked = valeur; });
  enregistrerFiltres();
  reinitialiserAffichage();
  demanderRendu(true);
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

function initOnglets() {
  const boutons = [...document.querySelectorAll('#onglets button')];
  const montrer = (nom) => {
    for (const b of boutons) b.classList.toggle('actif', b.dataset.onglet === nom);
    for (const v of document.querySelectorAll('.volet')) {
      v.hidden = v.dataset.volet !== nom;
    }
    try { localStorage.setItem('pzcarte.onglet', nom); } catch (e) {}
    if (nom === 'lieux') majListe();
    if (nom === 'bases') majPanneauBases();
    if (nom === 'trajet') majPanneauTrajet();
    // Les traces ne se dessinent que quand on les regarde, ou si on les a
    // epinglees : sinon elles encombreraient la carte en permanence.
    histo.afficher(nom === 'traces' || $('traceEpingler').checked);
    if (nom === 'traces') ouvrirTraces();
  };
  for (const b of boutons) b.addEventListener('click', () => montrer(b.dataset.onglet));
  let voulu = 'lieux';
  try { voulu = localStorage.getItem('pzcarte.onglet') || 'lieux'; } catch (e) {}
  if (!boutons.some(b => b.dataset.onglet === voulu)) voulu = 'lieux';
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
  const pose = trajet.etat.pose
    ? 'Chaque clic sur la carte ajoute une etape. Echap pour arreter.'
    : 'Clique auto ou manuel pour poser des etapes sur la carte. '
      + 'Depuis l\'onglet Bases, "depart" et "arrivee" remplissent le trajet.';
  $('aideTrajet').textContent = pose + ' ' + (trajet.etat.mode === 'auto'
    ? "Auto : le trajet suit une grille de cout lue dans les tuiles du jeu, a 8 cases par pixel. Le bitume coute 1, un sol interieur 2, l'herbe 5, l'eau est infranchissable."
    : 'Manuel : les etapes se relient en ligne droite, sans tenir compte du terrain.');

  const r = $('resumeTrajet');
  r.textContent = '';
  if (trajet.etat.distance > 0) {
    const gros = document.createElement('div');
    gros.className = 'gros';
    gros.textContent = trajet.etat.distance.toLocaleString('fr-FR') + ' cases';
    r.appendChild(gros);
    const t = document.createElement('table');
    for (const [nom, secondes] of trajet.durees()) {
      const tr = document.createElement('tr');
      const a = document.createElement('td');
      a.textContent = nom;
      const b = document.createElement('td');
      b.className = 'v';
      b.textContent = dureeTexte(secondes);
      tr.appendChild(a); tr.appendChild(b);
      t.appendChild(tr);
    }
    r.appendChild(t);
    const note = document.createElement('div');
    note.className = 'aide';
    note.textContent = 'Vitesses supposees (1,4 / 3 / 14 cases par seconde), '
      + 'pas mesurees dans le jeu : a prendre comme un ordre de grandeur.';
    r.appendChild(note);
  }
  if (trajet.etat.message) {
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

function dureeTexte(s) {
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0');
  return Math.floor(s / 3600) + ' h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0');
}

// --- joueur en direct -------------------------------------------------------

function majJoueurUI() {
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
    const actif = document.querySelector('#onglets button.actif');
    histo.afficher(this.checked || (actif && actif.dataset.onglet === 'traces'));
    if (this.checked) ouvrirTraces();
  });
  // Epinglees depuis une session precedente : on charge tout de suite, quel
  // que soit l'onglet ouvert.
  if (epingle) ouvrirTraces();
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

// --- demarrage -------------------------------------------------------------

async function demarrer() {
  initTuiles(plan);
  initRues($('rues'));
  initConstructions();
  initMarqueurs($('marqueurs'), i => selectionner(i, false));
  // majConsigne dans les deux rappels : le mode peut changer autrement que
  // par le bouton (Echap, une base posee, un depart choisi depuis une fiche),
  // et la consigne flottante doit suivre dans tous les cas.
  bases.initBases($('bases'), () => { majPanneauBases(); majConsigne(); demanderRendu(); });
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
