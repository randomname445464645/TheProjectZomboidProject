# Carte PZ together

Carte web locale du serveur Project Zomboid **PZ together** (build 42.20.4),
avec 1860 points de loot. Tout est statique : aucun acces aux sauvegardes du
jeu, aucune ecriture dans `~/Zomboid`, aucune dependance externe, marche hors
ligne.

Le rendu des tuiles est fait par [pzmap2dzi](https://github.com/cff29546/pzmap2dzi)
(inclus ici avec deux correctifs, voir plus bas). Le viewer, lui, est ecrit pour
ce projet.

## Lancer la carte

Les tuiles ne sont pas dans ce depot (plusieurs centaines de Mo). Il faut donc
les rendre une fois, puis :

```bash
./lancer-carte.sh
```

Carte sur http://127.0.0.1:8880/carte.html, viewer pzmap2dzi complet sur
http://127.0.0.1:8880/pzmap.html.

## Refaire le rendu

```bash
python3 -m venv .venv
.venv/bin/pip install -r pzmap2dzi/requirements.txt
cd pzmap2dzi
../.venv/bin/python main.py deploy
../.venv/bin/python main.py unpack
../.venv/bin/python main.py -c conf/conf-sqr2.yaml render base_top
```

Adapter d'abord les chemins en tete de `conf/conf.yaml` et
`conf/conf-sqr2.yaml` : `pz_root` (dossier du jeu), `mod_root` (workshop Steam),
`output_root`.

`unpack` extrait les textures une fois pour toutes (environ 650 Mo). Si elles
sont deja la, sauter cette etape.

### Les deux configurations

| Fichier | Rendu | Duree | Disque |
|---|---|---|---|
| `conf/conf.yaml` | 1 px par case | 25 min | 109 Mo |
| `conf/conf-sqr2.yaml` | 2 px par case | 33 min | 212 Mo |

Mesures faites sur un Core Ultra 9 185H. Le rendu 2 px est celui utilise
aujourd'hui : murs, bordures de trottoir et lignes de route y sont nets au lieu
d'etre en escalier.

`conf-sqr2.yaml` ecrit dans `out2/`. Une fois le rendu fini,
`./bascule-rendu-2px.sh` met le resultat en place et archive l'ancien sous
`out/html/map_data_sqr1`. Rien n'est efface.

### Rendu isometrique

Pas encore fait. Estimation mesuree sur 7 % d'avancement :
**6 a 9 heures et 60 a 80 Go**. En isometrique une case occupe 64 x 32 px au
lieu de 2 x 2, soit 1024 fois plus de pixels.

Attention, `dzi_cell_range` ne limite pas le rendu, seulement le recadrage
final. Le journal affiche `Unit range: all` : le moteur parcourt toute la carte
quoi qu'il arrive. Restreindre l'emprise ne fait donc pas gagner de temps.

## Organisation

```
out/html/carte.html        page
out/html/carte/            style.css, geometrie.js, vue.js, marqueurs.js, rues.js, app.js
out/html/serveur.py        serveur statique, bibliotheque standard seule
out/html/icons/            10 sprites extraits de UI2.pack
out/html/markers.json      1860 marqueurs
pzmap2dzi/                 l'outil de rendu, avec les correctifs
docs/                      le patch contre l'amont
```

## Comment marche le viewer

### Coordonnees

Convention pzmap2dzi (voir `out/html/pzmap/map.js`, `square2pixel`) :

```
pixel_local = x0 + coordonnee_monde * sqr
```

`x0` integre deja le facteur `sqr`. L'origine monde d'une pyramide vaut donc
`(-x0 / sqr, -y0 / sqr)`. Les coordonnees dans `markers.json` sont celles que le
jeu affiche.

Chaque carte moddee a sa propre pyramide, sa propre origine et son propre niveau
maximum. Raven Creek descend jusqu'a y = 17919, sous le bord inferieur de la
carte vanilla qui s'arrete a 16127 : le viewer gere ce debordement.

Pour verifier qu'un marqueur est au bon endroit : `map_data/rooms/marks.json`
contient les rectangles de pieces en coordonnees monde, produits par pzmap2dzi.
Assembler les tuiles autour de la zone et superposer ces rectangles suffit a
trancher.

### Nettete

Trois contraintes qui tiennent ensemble. En casser une ramene le fourmillement
au dezoom.

1. L'echelle vaut toujours `2^zoom`. Un cran de molette double ou divise par
   deux, jamais 1,25.
2. Le niveau de pyramide vaut `niveau1a1 + zoom + ceil(log2(devicePixelRatio))`,
   ou `niveau1a1 = niveauMax - log2(sqr)`. Une tuile s'affiche alors a 1 pixel
   physique d'ecran par pixel de tuile.
3. Aucun `transform: scale()` sur le conteneur des tuiles. Chaque tuile est
   positionnee en pixels CSS et le pan est garde en entiers. Un transform force
   une rasterisation intermediaire qui refloute tout.

`image-rendering: pixelated` n'est applique qu'en agrandissement au dela du 1:1.
En reduction c'est le plus proche voisin qui jetait des pixels.

La geometrie n'est pas codee en dur : le viewer lit `map_info.json` et
`layer0.dzi` au demarrage, il s'adapte donc seul a un rendu 1 px ou 2 px.

### Cache des tuiles

Les tuiles sont servies avec un cache d'une semaine. Un changement de
`top_view_square_size` reutilise les memes URLs avec un contenu different (256
px d'un cote, 512 de l'autre). D'ou le jeton `?r=` dans `urlTuile()`, derive de
la geometrie. Un nouveau rendu de meme geometrie ne le bouscule pas : dans ce
cas, incrementer `VERSION_TUILES` dans `carte/geometrie.js`.

## Les correctifs de pzmap2dzi

Clone de `cff29546/pzmap2dzi` au commit `5025122`. Le `.git` d'origine est
conserve sous `pzmap2dzi/.git-upstream` (non versionne) : le renommer en `.git`
pour suivre l'amont. Diff complet dans `docs/pzmap2dzi-correctifs.diff`.

**`pzmap2dzi/pzdzi.py`, `clear_wip()`** : `os.remove` entoure d'un
`try/except FileNotFoundError`. Course entre workers sur les fichiers
`.pending`.

**`pzmap2dzi/cell.py`** : `block_num` recalcule depuis la table d'offsets quand
la valeur declaree ne vaut pas `block_per_cell^2`. Les `.lotpack` de Trelai
declarent 8 blocs au lieu de 1024 et faisaient planter le parseur.

**`conf/conf.yaml`** : `layer_range: [-2, 9]`, et `dzi_cell_range[default]` fige
sur l'emprise vanilla pour qu'ajouter une carte moddee ne relance pas tout le
rendu.

`conf/mod/pztogether.txt` decrit les 8 cartes moddees du serveur.

## Les marqueurs

`markers.json`, tableau de `{x, y, z, cat, t, d}`. Extraits des noms de pieces
dans les `.lotheader`, plus une liste ecrite a la main pour l'or, les billets et
le Slugger.

| Categorie | Nombre |
|---|---|
| outils | 399 |
| medical | 354 |
| bouffe | 348 |
| armes | 296 |
| essence | 183 |
| valeur | 155 |
| labo | 87 |
| billets | 24 |
| or | 13 |
| top | 1 |

Raven Creek, Constown, New Hartburg, Chestown et LQZ n'ont aucun marqueur :
l'extraction est anterieure a l'ajout de ces cinq cartes.

## Notes

Le rendu isometrique sort en jpg avec des tuiles de 1024, la vue de dessus en
webp avec des tuiles de 256 (1 px par case) ou 512 (2 px par case).

`req-nolinux.txt` est la liste des dependances sans `pynput`, qui reclame X ou
evdev.

`main.py` fait `from distutils.dir_util import copy_tree`. distutils a disparu
en Python 3.12, c'est `setuptools` qui le fournit encore : sans lui, `main.py`
ne s'importe meme pas.
