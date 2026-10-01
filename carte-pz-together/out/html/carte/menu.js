// Menu contextuel de la carte : remplace celui du navigateur au clic droit.
//
// Ce module ne fait qu'afficher une liste d'entrees et appeler leur action :
// c'est app.js qui sait quoi proposer selon ce qu'il y a sous la souris.
//
// Une entree est un objet :
//   { titre: 'texte' }                      ligne d'en-tete, non cliquable
//   { sep: true }                           separateur
//   { libelle, action, aide?, desactive? }  entree cliquable
// Les entrees falsy sont ignorees, ce qui permet d'ecrire `cond && {...}`.

let menu = null;
let avantOuverture = null;     // element qui avait le focus, rendu a la fermeture

function creer() {
  menu = document.createElement('div');
  menu.id = 'menuCarte';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  // Le menu vit au-dessus de la carte : ses clics ne doivent ni la glisser ni
  // poser une etape dessous.
  for (const ev of ['mousedown', 'click', 'wheel', 'contextmenu']) {
    menu.addEventListener(ev, e => {
      e.stopPropagation();
      if (ev === 'contextmenu') e.preventDefault();
    });
  }
  menu.addEventListener('keydown', clavier);
  document.body.appendChild(menu);

  // Toute interaction ailleurs referme le menu.
  window.addEventListener('mousedown', e => { if (!menu.contains(e.target)) fermer(); }, true);
  window.addEventListener('wheel', fermer, { passive: true });
  window.addEventListener('resize', fermer);
  window.addEventListener('blur', fermer);
}

export function ouvert() { return !!menu && !menu.hidden; }

/** Ouvre le menu au point (cx, cy) en coordonnees de la fenetre. */
export function ouvrir(cx, cy, entrees) {
  if (!menu) creer();
  menu.textContent = '';
  for (const e of entrees) {
    if (!e) continue;
    if (e.sep) {
      // Pas de separateur en tete ni deux de suite.
      if (menu.lastChild && !menu.lastChild.classList.contains('sep')) {
        const s = document.createElement('div');
        s.className = 'sep';
        menu.appendChild(s);
      }
      continue;
    }
    if (e.titre !== undefined) {
      const t = document.createElement('div');
      t.className = 'titre';
      t.textContent = e.titre;
      if (e.sous) {
        const s = document.createElement('small');
        s.textContent = e.sous;
        t.appendChild(s);
      }
      menu.appendChild(t);
      continue;
    }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    b.textContent = e.libelle;
    if (e.aide) {
      const a = document.createElement('span');
      a.className = 'aide-menu';
      a.textContent = e.aide;
      b.appendChild(a);
    }
    b.disabled = !!e.desactive;
    b.addEventListener('click', () => {
      fermer();
      e.action();
    });
    menu.appendChild(b);
  }
  if (menu.lastChild && menu.lastChild.classList.contains('sep')) menu.lastChild.remove();

  avantOuverture = document.activeElement;
  menu.hidden = false;
  // Place puis recale : le menu ne doit jamais deborder de la fenetre. Pres
  // du bord droit ou du bas, il s'ouvre de l'autre cote du curseur.
  const l = menu.offsetWidth, h = menu.offsetHeight;
  const W = window.innerWidth, H = window.innerHeight;
  const x = cx + l + 4 > W ? Math.max(4, cx - l) : cx;
  const y = cy + h + 4 > H ? Math.max(4, H - h - 4) : cy;
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  const premier = menu.querySelector('button:not(:disabled)');
  if (premier) premier.focus({ preventScroll: true });
}

export function fermer() {
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  if (avantOuverture && avantOuverture.focus) avantOuverture.focus({ preventScroll: true });
  avantOuverture = null;
}

function clavier(e) {
  const boutons = [...menu.querySelectorAll('button:not(:disabled)')];
  const i = boutons.indexOf(document.activeElement);
  if (e.key === 'Escape') fermer();
  else if (e.key === 'ArrowDown') boutons[(i + 1) % boutons.length]?.focus();
  else if (e.key === 'ArrowUp') boutons[(i - 1 + boutons.length) % boutons.length]?.focus();
  else if (e.key === 'Home') boutons[0]?.focus();
  else if (e.key === 'End') boutons[boutons.length - 1]?.focus();
  else return;
  e.preventDefault();
  e.stopPropagation();
}
