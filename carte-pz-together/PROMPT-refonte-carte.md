# Prompt : refonte propre de la carte PZ together

Copie tout ce qui suit dans une nouvelle session Claude Code ouverte sur
`/home/kiri/Documents/labo/pzmap`.

---

## Contexte

Je joue sur le serveur Project Zomboid **PZ together** (`5.39.71.209:26955`, build
**42.20.4**, client GOG dans `/home/kiri/GOG Games/Project Zomboid/game/projectzomboid`).

Dans `/home/kiri/Documents/labo/pzmap` il y a déjà une carte web locale fonctionnelle
mais bricolée par ajouts successifs. **Je veux que tu réécrives le viewer au propre**,
sans rien re-rendre : tout le rendu lourd est déjà fait et doit être réutilisé tel quel.

### Ce qui existe et ne doit PAS être refait

- `out/html/map_data/` (109 Mo) : rendu **pzmap2dzi** en vue de dessus, déjà généré.
  - `base_top/` : carte vanilla, 19968 x 16128 px à 1 px par case, pyramide **niveaux 0 à 15**,
    tuiles de **256 px**, format webp. Le niveau 15 est la pleine résolution.
  - `mod_maps/<nom>/base_top/` : 8 cartes moddées, **chacune avec sa propre pyramide,
    son origine et son niveau maximum** (voir tableau plus bas).
  - `rooms/`, `objects/`, `streets/` : calques pzmap2dzi additionnels, actuellement inutilisés
    par mon viewer. À toi de me dire s'ils valent le coup.
- `out/html/pzmap.html` : le viewer officiel de pzmap2dzi, à laisser intact.
- `out/html/server.py` : serveur HTTP de pzmap2dzi, port **8880**. Lancé par `./lancer-carte.sh`.
- `out/html/icons/*.png` : 10 sprites 32x32 extraits de `UI2.pack` du jeu, un par catégorie.
- `markers.json` : **1860 marqueurs**, données statiques uniquement.
- `pzmap2dzi/` : l'outil, avec **deux correctifs que j'ai dû écrire, ne les écrase pas** :
  - `pzmap2dzi/pzdzi.py`, `clear_wip()` : `os.remove` entouré d'un `try/except FileNotFoundError`
    (course entre workers sur les fichiers `.pending`).
  - `pzmap2dzi/cell.py` : `block_num` recalculé depuis la table d'offsets quand la valeur
    déclarée ne vaut pas `block_per_cell²`. Les `.lotpack` de Trelai déclarent 8 blocs au lieu
    de 1024 et faisaient planter le parseur.
  - `conf/conf.yaml` : `layer_range: [-2, 9]`, et `dzi_cell_range[default]` figé sur l'emprise
    vanilla pour éviter qu'ajouter une carte moddée ne relance 25 minutes de rendu.

### Géométrie des pyramides

Conversion : `pixel = coordonnée monde + x0`. Cellules de 256 cases en B42.

| Pyramide | largeur | hauteur | x0 | y0 | niveau max |
|---|---|---|---|---|---|
| base_top (vanilla) | 19968 | 16128 | 0 | 0 | 15 |
| RavenCreek_B42 | 2560 | 3584 | -4096 | -14336 | 12 |
| Constown_B42 | 2304 | 1280 | -4096 | -10240 | 12 |
| Trelai_B42 | 1792 | 1792 | -6144 | -6144 | 11 |
| NewHartburg_B42 | 1280 | 1536 | -6144 | -10240 | 11 |
| Greenport_B42 | 1536 | 768 | -7168 | -7168 | 11 |
| Maplewood_B42 | 1280 | 512 | -7168 | -8192 | 11 |
| LQZ_B42 | 768 | 1280 | -13312 | -3072 | 11 |
| Chestown_B42 | 768 | 768 | -4096 | -6144 | 10 |

Les cartes moddées se dessinent **par-dessus** la vanilla, uniquement dans leurs bornes.
Raven Creek descend jusqu'à y = 17919, soit sous le bord inférieur de la carte vanilla
qui s'arrête à y = 16127. Le viewer doit gérer ce débordement.

---

## Objectif 1 : la netteté au dézoom (le point le plus important)

La carte actuelle est **sale dès qu'on dézoome**. J'ai identifié la cause, corrige-la
proprement plutôt que de bricoler :

1. Le viewer choisit son niveau de pyramide avec `Math.round(Math.log2(1/scale))`.
   Le facteur d'affichage d'une tuile tombe donc n'importe où entre **0,707 et 1,414**.
2. Le CSS applique `image-rendering: pixelated` sur toutes les tuiles. Quand le facteur
   est inférieur à 1, le navigateur fait du plus proche voisin et **jette des pixels**,
   d'où le fourmillement et l'aspect granuleux.
3. La molette multiplie l'échelle par 1,25 ou 0,8, donc l'échelle n'est presque jamais
   une puissance de deux et il y a rééchantillonnage en permanence.

Ce que j'attends :

- **Zoom calé sur les puissances de deux.** Chaque cran de molette double ou divise
  l'échelle par deux, de sorte qu'une tuile s'affiche toujours à exactement 1 pixel
  écran par pixel de tuile. Ajoute une transition CSS courte si ça rend le geste brutal,
  mais les paliers doivent être exacts.
- **Prise en compte de `devicePixelRatio`.** Sur écran HiDPI il faut charger le niveau
  du dessus pour afficher à la résolution native, sinon tout est flou par construction.
- **`image-rendering` choisi dynamiquement** : `pixelated` seulement quand on agrandit
  au-delà du 1:1 (zoom rapproché, on veut voir les pixels nets), filtrage lisse sinon.
  Jamais de plus proche voisin en réduction.
- Le même traitement doit s'appliquer aux tuiles des cartes moddées, qui ont leur propre
  niveau maximum et donc leur propre correspondance échelle vers niveau.

Si tu juges qu'un rendu à 2 px par case (`top_view_square_size: 2` dans `conf.yaml`)
apporterait un gain réel, dis-le moi avec l'estimation de temps et d'espace disque
**avant** de lancer quoi que ce soit. Le rendu complet actuel a pris environ 25 minutes.

---

## Objectif 2 : réécrire le viewer au propre

`out/html/carte.html` fait 17 Ko d'un seul tenant, écrit par patchs successifs via des
`sed` et des regex. Je veux une base saine :

- Sépare en fichiers distincts (`carte.html`, `carte.css`, `carte.js`, ou l'organisation
  que tu juges correcte), servis par le même serveur sur le port 8880.
- Code commenté en français, noms de variables explicites.
- Aucun accès à mes fichiers de jeu, aucun serveur de synchronisation, aucune écriture
  dans `~/Zomboid`. **La carte est 100 % statique.**
- Pas de dépendance externe, pas de CDN. Tout doit marcher hors ligne.

### Fonctionnalités à conserver

- Déplacement à la souris et zoom molette.
- Lecture des coordonnées x/y du curseur, celles qu'affiche le jeu.
- Filtres par catégorie avec pastille de couleur, sprite du jeu et compteur.
- Boutons Tout / Rien, saut à des coordonnées x/y saisies, sélecteur des 8 villes moddées,
  bouton « Tout voir » qui recadre sur l'ensemble des marqueurs visibles.
- Liste latérale des marqueurs les plus proches du centre de la vue, triée par distance,
  plafonnée pour rester lisible. Un clic recentre la carte dessus.
- Culling : ne dessiner que les marqueurs présents dans la fenêtre. Il y en a 1860 et
  tout afficher d'un coup fait ramer.
- Mémorisation de la vue et des filtres entre deux sessions.

### Bugs connus à ne pas réintroduire

- Le navigateur déclenche son glisser-déposer natif sur les tuiles et la carte se bloque.
  Il faut `-webkit-user-drag: none`, `user-select: none`, `draggable = false` sur chaque
  image, et un `preventDefault` sur `dragstart` et sur `mousedown`.
- Les marqueurs contre-zoomés sans plafond deviennent énormes et se chevauchent au dézoom.
- Les icônes doivent porter un suffixe de version dans leur URL, le cache est tenace.

---

## Les données de marqueurs

`markers.json`, tableau d'objets `{x, y, z, cat, t, d}`. **1860 entrées, 10 catégories.**

| Catégorie | Nombre | Contenu |
|---|---|---|
| outils | 399 | quincailleries, garages, entrepôts, jardineries |
| medical | 354 | pharmacies, cliniques, réserves d'hôpital |
| bouffe | 348 | épiceries, primeurs, magasins d'alcool |
| armes | 296 | armureries, dépôts militaires, réserves de police |
| essence | 183 | stations-service et leurs réserves |
| valeur | 155 | banques, bijouteries, prêteurs, labos de drogue |
| labo | 87 | laboratoires |
| billets | 24 | coffres de Trelai, réserves de banque, labos |
| or | 13 | salle des coffres de Trelai, cryptes de Greenport, réserves de bijouterie |
| top | 1 | le Trelai Slugger, x 7758 y 7159 |

Provenance : extraites des noms de pièces dans les `.lotheader` des 4065 cellules vanilla
et des cartes moddées, plus une liste écrite à la main pour l'or, les billets et le Slugger.
**Ne les régénère pas**, réutilise le fichier.

Deux fichiers de référence accompagnent ces données et doivent rester cohérents avec elles :
`/home/kiri/Documents/labo/trelai-coords.md` et
`/home/kiri/Documents/labo/pz-or-et-billets.md`.

---

## Méthode de travail

- Vérifie tes affirmations dans les fichiers plutôt que de supposer. Sur ce projet,
  plusieurs évidences se sont révélées fausses : la liste des mods du serveur ne se
  déduit pas du dictionnaire d'items (une carte pure n'ajoute aucun item), les coffres-forts
  vanilla ne sont pas des conteneurs, et les `.lotpack` de Trelai mentent sur leur nombre
  de blocs.
- Teste le résultat dans le navigateur avant de me dire que c'est bon : tuiles réellement
  chargées, aucun 404, marqueurs présents, et surtout **une vérification explicite de la
  netteté** à plusieurs niveaux de zoom.
- Réponds en français, sans tiret cadratin.
- Dis-moi ce qui ne marche pas plutôt que de l'enrober.

## Critères d'acceptation

1. Au dézoom, la carte est nette et stable, sans fourmillement ni pixels perdus.
2. Le zoom s'arrête sur des paliers exacts, tuiles affichées au 1:1 en pixels écran.
3. Les 8 cartes moddées apparaissent à leur place, Raven Creek comprise malgré son
   débordement sous la carte vanilla.
4. Les 1860 marqueurs sont là, filtrables, avec leurs sprites.
5. Le code est réparti en fichiers lisibles et commentés, sans reste de sync ni de code mort.
6. `./lancer-carte.sh` démarre tout, rien d'autre à faire.
