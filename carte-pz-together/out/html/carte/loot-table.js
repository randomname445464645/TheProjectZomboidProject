// Fenetre "toute la table de loot".
//
// L'infobulle ne montre qu'un resume de quatorze objets, choisi pour etre
// lisible. Cette fenetre montre tout : chaque meuble de la piece, la table
// qu'il tire, la chance que cette table soit tiree, et chaque objet avec son
// poids brut et sa part.
//
// Les conteneurs sont ouvrables. Une mallette pleine de billets est un objet
// dans la table du meuble, mais elle a sa propre table, et c'est celle-la qui
// compte : Briefcase_Money donne 600 de poids de Monnaie sur 4 tirages.
//
// loot-tables.json fait 1,1 Mo, il n'est donc charge qu'a la premiere
// ouverture, pas au demarrage de la carte.

let tables = null;          // nom de table -> { r: tirages, i: [[nom, poids, id?]] }
let chargement = null;
let pieces = null;          // fourni par marqueurs.js, deja charge
let fenetre = null, corps = null, fil = null;
let pile = [];              // fil d'Ariane : [{type, cle, titre}]

export function initTableLoot(tableauPieces) {
  pieces = tableauPieces;
}

function charger() {
  if (tables) return Promise.resolve(tables);
  if (!chargement) {
    chargement = fetch('carte/loot-tables.json')
      .then(r => (r.ok ? r.json() : {}))
      .then(d => { tables = d; return d; })
      .catch(() => { tables = {}; return tables; });
  }
  return chargement;
}

function construire() {
  if (fenetre) return;
  fenetre = document.createElement('div');
  fenetre.className = 'loot-fenetre';
  fenetre.innerHTML =
    '<div class="loot-cadre">'
    + '<div class="loot-tete"><div class="loot-fil"></div>'
    + '<button class="loot-fermer" title="Fermer (Echap)">&times;</button></div>'
    + '<div class="loot-corps"></div></div>';
  document.body.appendChild(fenetre);
  corps = fenetre.querySelector('.loot-corps');
  fil = fenetre.querySelector('.loot-fil');
  fenetre.querySelector('.loot-fermer').addEventListener('click', fermer);
  // Clic sur le fond, pas sur le cadre.
  fenetre.addEventListener('mousedown', e => { if (e.target === fenetre) fermer(); });
  fenetre.addEventListener('mousedown', e => e.stopPropagation());
  fenetre.addEventListener('wheel', e => e.stopPropagation());
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && estOuverte()) { e.stopPropagation(); fermer(); }
  }, true);
}

export function estOuverte() {
  return !!fenetre && fenetre.classList.contains('visible');
}

export function fermer() {
  if (fenetre) fenetre.classList.remove('visible');
  pile = [];
}

/** Ouvre la piece d'un marqueur. */
export function ouvrirPiece(cle, titre) {
  pile = [];
  empiler({ type: 'piece', cle, titre });
}

/** Ouvre la table d'un conteneur. */
export function ouvrirContenant(cle, titre) {
  pile = [];
  empiler({ type: 'table', cle, titre });
}

function empiler(entree) {
  construire();
  pile.push(entree);
  fenetre.classList.add('visible');
  corps.textContent = 'chargement...';
  charger().then(dessiner);
}

function reculer(index) {
  pile = pile.slice(0, index + 1);
  dessiner();
}

function dessiner() {
  const courant = pile[pile.length - 1];
  if (!courant) return;

  fil.textContent = '';
  pile.forEach((e, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'loot-sep';
      sep.textContent = '›';
      fil.appendChild(sep);
    }
    if (i < pile.length - 1) {
      const a = document.createElement('button');
      a.className = 'loot-lien';
      a.textContent = e.titre;
      a.addEventListener('click', () => reculer(i));
      fil.appendChild(a);
    } else {
      const s = document.createElement('strong');
      s.textContent = e.titre;
      fil.appendChild(s);
    }
  });

  corps.textContent = '';
  if (courant.type === 'piece') {
    const d = pieces && pieces[courant.cle];
    const meubles = (d && d.m) || [];
    if (!meubles.length) {
      corps.appendChild(note("Cette piece n'a pas de table de loot dans les "
        + 'fichiers du jeu. Les pieces de cartes moddees, comme les coffres de '
        + 'Trelai, definissent les leurs ailleurs.'));
      return;
    }
    for (const [meuble, nomTable, chance] of meubles) {
      corps.appendChild(bloc(meuble, nomTable, chance));
    }
  } else {
    corps.appendChild(bloc(null, courant.cle, 100));
  }
}

function note(texte) {
  const p = document.createElement('p');
  p.className = 'loot-note';
  p.textContent = texte;
  return p;
}

/** Un meuble et sa table, avec tous les objets. */
function bloc(meuble, nomTable, chance) {
  const bl = document.createElement('section');
  bl.className = 'loot-bloc';

  const t = tables[nomTable];
  const tete = document.createElement('h3');
  const parts = [];
  if (meuble) parts.push(meuble);
  parts.push(nomTable);
  tete.textContent = parts.join(' · ');
  bl.appendChild(tete);

  const sous = document.createElement('div');
  sous.className = 'loot-soustitre';
  if (!t) {
    sous.textContent = 'table introuvable';
    bl.appendChild(sous);
    return bl;
  }
  const total = t.i.reduce((s, l) => s + l[1], 0) || 1;
  sous.textContent = (chance < 100 ? chance + ' % de chance que la table soit tiree · ' : '')
    + t.r + (t.r > 1 ? ' tirages' : ' tirage')
    + ' · ' + t.i.length + ' objets · poids total ' + arrondi(total);
  bl.appendChild(sous);

  const table = document.createElement('table');
  for (const ligne of t.i) {
    const tr = document.createElement('tr');
    const pct = document.createElement('td');
    pct.className = 'loot-pct';
    pct.textContent = (ligne[1] * 100 / total).toFixed(1) + ' %';
    const poids = document.createElement('td');
    poids.className = 'loot-poids';
    poids.textContent = arrondi(ligne[1]);
    const nom = document.createElement('td');
    if (ligne.length > 2) {
      const b = document.createElement('button');
      b.className = 'loot-ouvrir';
      b.textContent = ligne[0] + ' ▸';
      b.title = 'Voir ce qu\'il y a dedans';
      b.addEventListener('click', () => empiler(
        { type: 'table', cle: ligne[2], titre: ligne[0] }));
      nom.appendChild(b);
    } else {
      nom.textContent = ligne[0];
    }
    tr.appendChild(pct);
    tr.appendChild(poids);
    tr.appendChild(nom);
    table.appendChild(tr);
  }
  bl.appendChild(table);
  return bl;
}

function arrondi(v) {
  return (Math.round(v * 1000) / 1000).toString();
}
