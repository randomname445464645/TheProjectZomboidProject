// Service worker de la carte PZ together.
//
// REGLE ABSOLUE : ne jamais mettre les tuiles en cache. La pyramide
// isometrique pese 359 Go et la vue de dessus 197 Go. Tout ce qui passe par
// map_data/ va directement au reseau, sans jamais toucher au Cache Storage,
// qui remplirait le disque et ferait echouer le quota du navigateur.
//
// Seule la coquille est mise en cache : la page, le code, les icones et les
// marqueurs, soit moins de 500 Ko. C'est ce qui permet a la fenetre de
// s'ouvrir instantanement et de fonctionner meme si le serveur local n'a pas
// encore demarre.

const VERSION = 'carte-pz-v5';   // v5 : /api/ jamais en cache

// Chemins de la coquille. Les parametres ?v= des balises sont conserves tels
// quels : c'est l'URL complete qui sert de cle de cache.
const COQUILLE = [
  '/carte.html',
  '/carte/style.css',
  '/carte/app.js',
  '/carte/geometrie.js',
  '/carte/vue.js',
  '/carte/marqueurs.js',
  '/carte/rues.js',
  '/carte/loot.js',
  '/carte/loot-table.js',
  '/carte/exporter.js',
  '/carte/constructions.js',
  '/carte/bases.js',
  '/carte/itineraire.js',
  '/carte/joueur.js',
  '/carte/historique.js',
  '/carte/loot-pieces.json',
  '/markers.json',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/pwa/icone-192.png',
  '/pwa/icone-512.png',
  '/pwa/icone-512-maskable.png',
  '/icons/top.png', '/icons/or.png', '/icons/billets.png', '/icons/valeur.png',
  '/icons/armes.png', '/icons/medical.png', '/icons/outils.png',
  '/icons/bouffe.png', '/icons/essence.png', '/icons/labo.png', '/icons/metal.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      // addAll echoue en bloc si UN seul fichier manque : on tolere les
      // absences pour ne pas casser l'installation entiere.
      .then(c => Promise.all(COQUILLE.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(noms => Promise.all(noms.filter(n => n !== VERSION).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Les tuiles et tout ce qui vient du rendu : reseau direct, jamais de cache.
  if (url.pathname.startsWith('/map_data/')) return;
  // L'API non plus : /api/position change chaque seconde. Mise en cache, elle
  // remplirait le Cache Storage et, serveur eteint, resservirait une vieille
  // position avec un age qui la ferait passer pour du direct.
  if (url.pathname.startsWith('/api/')) return;

  // TOUTE la coquille passe par le reseau d'abord, avec repli sur le cache
  // seulement si le serveur ne repond pas.
  //
  // Avant, seule la page etait servie ainsi, et le code en "cache d'abord,
  // rafraichi derriere". Ca casse des qu'un module change d'interface : la
  // page neuve charge app.js neuf, qui importe marqueurs.js... servi depuis
  // le cache dans son ANCIENNE version, sans listerPour. L'import echoue, rien
  // ne demarre, et il faut un deuxieme rechargement pour s'en sortir. Les
  // modules ES n'ont pas de ?v= dans leurs import, donc l'URL ne change pas
  // d'une version a l'autre et le cache ne peut pas faire la difference.
  //
  // Le serveur est local : le detour par le reseau coute une milliseconde.
  // Le cache ne sert plus qu'a ouvrir la fenetre quand le serveur est eteint.
  e.respondWith(
    fetch(e.request).then(rep => {
      if (rep && rep.ok) {
        const copie = rep.clone();
        caches.open(VERSION).then(c => c.put(e.request, copie));
      }
      return rep;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })
      .then(r => r || (e.request.mode === 'navigate' ? caches.match('/carte.html') : r)))
  );
});
