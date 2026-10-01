# Agent d'export du monde

Relève les constructions que tu as vues en jeu et les affiche sur la carte web.

## Pourquoi

Le serveur n'envoie jamais de fichiers de monde au client : en multijoueur,
`~/Zomboid/Saves/Multiplayer/<serveur>/` ne contient aucune donnée de terrain,
les dossiers `chunkdata`, `map`, `isoregiondata`, `apop`, `metagrid` et `zpop`
sont vides. Le rendu de pzmap2dzi part donc des fichiers de carte du jeu et des
mods, c'est à dire du monde tel qu'il est livré, sans aucune construction.

Mais le client **reçoit** bien la géométrie, sinon il ne pourrait pas l'afficher.
Elle est en mémoire. Cet agent va la lire là.

## Pourquoi un agent et pas autre chose

**Pas un mod Lua** : l'API `getCell():getGridSquare()` ferait la même chose en
cinquante lignes, mais il faudrait déposer un mod dans le dossier des mods.
L'agent n'y touche pas.

**Pas un débogueur distant.** `-agentlib:jdwp` fonctionne, mais chaque lecture
de champ est un aller-retour réseau et invoquer une méthode exige un thread
suspendu. Balayer la zone chargée demanderait des millions d'allers-retours,
jeu figé. Un agent tourne DANS le processus, sans aucun aller-retour.
JDWP reste excellent pour explorer l'API à la main.

**Pas de lecture brute de la mémoire.** Le jeu tourne en `-XX:+UseZGC`, un
ramasse-miettes concurrent et déplaçant à pointeurs colorés : les objets
changent d'adresse pendant la lecture et les pointeurs portent des métadonnées.
Reconstruire des objets Java depuis `/proc/<pid>/mem` reviendrait à
réimplémenter les internes de la JVM.

Les classes du jeu ne sont pas obfusquées (`zombie.iso.IsoCell`,
`IsoGridSquare`, `IsoObject`), l'agent se compile donc directement contre
`projectzomboid.jar`, sans réflexion.

## Construire

```bash
P=/home/kiri/.local/share/Steam/steamapps/common/ProjectZomboid/projectzomboid
javac -cp "$P/projectzomboid.jar" -d classes src/pzexport/Agent.java
jar --create --file agent-monde.jar --manifest META-INF/MANIFEST.MF -C classes .
```

Demande un JDK complet (`java-25-openjdk-devel`) : le JRE livré avec le jeu est
amputé, il n'a ni `javac`, ni `jmap`, ni `jcmd`.

## Installer

Ajouter aux `vmArgs` de `ProjectZomboid64.json` :

```
-javaagent:<chemin>/agent-monde.jar=periode=5
```

Options, séparées par des virgules :

| Option | Défaut | Rôle |
|---|---|---|
| `periode=<s>` | 5 | intervalle entre deux balayages |
| `sortie=<chemin>` | `~/Zomboid/pz-export/monde.ndjson` | fichier de sortie |
| `tout=1` | non | exporte toutes les cases, pas seulement celles qui contiennent une construction |

`tout=1` est nécessaire pour que **les suppressions** apparaissent. Sans lui le
calque ne fait qu'ajouter : un arbre abattu reste affiché, puisqu'il appartient
à la tuile de base et que rien ne le recouvre. Avec lui, les sols de toutes les
cases relevées sont repeints par dessus, et ce qui n'existe plus n'est
simplement pas peint.

Le volume change d'ordre de grandeur : quelques milliers de cases avec le
filtre, plus de cent mille avec `tout=1`.

Une limite subsiste : un grand arbre situé juste en dehors de la zone relevée
continuera de déborder dedans par le haut. Les bords de l'exploration gardent
ces résidus, le centre est propre.

Steam réécrit parfois `ProjectZomboid64.json` lors d'une mise à jour du jeu :
garder une copie.

## Utiliser

Jouer. L'agent écrit une ligne NDJSON par case nouvelle ou modifiée, et affiche
`[pz-export] N cases ecrites` dans la console du jeu. Puis :

```bash
python3 outils/agent-monde/convertir.py
```

ou, plus simplement, le bouton **synchroniser** du panneau de la carte, qui
fait la même chose sans terminal.

Le convertisseur lit **tous les `.ndjson`** du dossier d'export, du plus ancien
au plus récent, et déduplique. Peu importe donc comment les relevés sont
nommés ou répartis entre sessions.

Il produit deux fichiers dans `out/html/` :

| Fichier | Contenu |
|---|---|
| `constructions.json` | les cases, avec leurs sprites en indices |
| `constructions-sprites.json` | par sprite : dossier, taille, décalage `ox`/`oy` |

Le viewer affiche alors une case « mes constructions » dans le panneau.

### Les vraies tuiles

Pour que le calque dessine les vrais sprites et pas seulement l'emprise, les
textures extraites doivent être accessibles au serveur web :

```bash
ln -sfn /mnt/data/pz-render/out-iso/texture out/html/texture
```

Le rendu par sprites n'a lieu **qu'en isométrique et au-delà de 16 px par
case**. En vue de dessus, dessiner des sprites isométriques n'aurait aucun
sens. Le seuil de 16 est fixé par la mesure, pas par la lisibilité : sur un
relevé de 120 000 cases, une image coûte 14,8 ms à 16 px/case, 37 ms à 8 et
71 ms à 4, pour un budget de 16,7 ms à 60 Hz. En dessous, le calque retombe
sur l'emprise dorée, qui coûte 2 ms.

La règle de dessin est reprise de `render_impl/base.py` et de `pzdzi.IsoDZI` :

```
bas_centre_x = (x - y) * 64
bas_centre_y = (x + y + 2) * 32 - 192 * z
sprite dessiné en (bas_centre + ox, bas_centre + oy)
```

64 et 32 sont `GRID_WIDTH` et `GRID_HEIGHT`, 192 est `LAYER_HEIGHT`. Le `+2`
vient du `oy += dzi.sqr_height >> 1` de `base.py`, qui passe du centre du
losange à son bas. Les décalages `ox`/`oy` sont propres à chaque sprite et
vivent dans les métadonnées des PNG écrits par `unpack` ; le navigateur ne sait
pas lire un bloc tEXt, d'où l'index produit par le convertisseur.

Les cases sont dessinées dans l'ordre du peintre : étage croissant, puis
profondeur isométrique croissante (`x + y`). Sans ce tri, un mur du fond
recouvrirait un mur du premier plan.

## Effacer un relevé pour repartir de zéro

**Arrêter le jeu d'abord.** Renommer ou supprimer le fichier pendant que
l'agent tourne ne l'arrête pas : sous Linux, renommer un fichier sur le même
système de fichiers ne change que son nom, le descripteur ouvert suit l'inode.
L'agent continue donc d'écrire, dans le fichier renommé.

```bash
# jeu ferme
rm ~/Zomboid/pz-export/monde.ndjson
```

## Feuillage : pourquoi les arbres etaient nus

`plants.py` montre que pzmap2dzi ne dessine pas un arbre tel quel : il empile
le tronc nu `e_<essence>_1_<i>` puis une couche de feuillage
`e_<essence>_1_<i + 4 x step>` choisie par `plants_conf.season`. La carte de
base est rendue en `summer2`, donc en ete permanent.

L'agent releve les sprites que le jeu utilise **reellement**. Si le serveur est
en hiver, il n'y a pas de couche de feuillage : les arbres du calque sont nus
alors que ceux de la carte ont des feuilles.

Le convertisseur reproduit donc la substitution de `get_tree` et ajoute la
couche de feuillage. Par defaut `summer2`, comme la carte :

```bash
python3 convertir.py --saison=summer2     # defaut
python3 convertir.py --saison=autumn
python3 convertir.py --saison=aucune      # garde ce que le jeu affiche
```

Saisons acceptees : `spring`, `summer`, `summer2`, `autumn`. Les persistants
(houx, pruche, pin de Virginie) n'ont pas de couche de feuillage et ne sont pas
touches.

## L'export HD

Le bouton **exporter en HD** enregistre la vue courante en PNG, a la resolution
native des tuiles et non a celle de l'ecran. Il ne s'agit pas d'un
agrandissement : le module va chercher le niveau de pyramide correspondant, ce
qui revele du detail que l'ecran ne montrait pas.

Le facteur est toujours une puissance de deux, pour que les tuiles tombent sur
des pixels entiers. Il est reduit de moitie tant que l'image depasse 16384 px
de cote ou 40 megapixels, limites au-dela desquelles le navigateur refuse la
toile.

Le calque des constructions suit la case a cocher, et ses sprites sont
**attendus** avant le dessin : a l'ecran un sprite manquant revient a l'image
suivante, dans un export il manquerait definitivement.

Ordres de grandeur mesures : une vue a 8 px par case donne 5472 x 6144, soit
34 megapixels et 51 Mo de PNG ; a 16 px par case, 2736 x 3072 et 13 Mo. Le PNG
est sans perte, ce qui convient a du pixel art mais pese.

## Le bouton synchroniser

`serveur.py` expose `POST /api/sync`, qui relance le convertisseur et renvoie
son résumé en JSON. C'est la seule entorse au caractère statique de la carte :
le serveur n'exécute rien d'autre, ne lit aucune donnée de jeu, et n'accepte
aucun paramètre. La commande est fixe.

Trois protections :

- le serveur n'écoute que sur `127.0.0.1`, rien n'est joignable depuis le
  réseau local ;
- la requête doit porter l'en-tête `X-Carte: sync`. Une page d'une autre
  origine ne peut pas le poser sans requête préliminaire, à laquelle le serveur
  ne répond pas : un site tiers ne peut donc pas déclencher la synchronisation
  à ton insu ;
- un verrou interdit deux conversions simultanées, qui écriraient le même
  fichier et produiraient un JSON tronqué. La seconde reçoit un `409`.

Le convertisseur a besoin de Pillow, donc du python du `.venv` du projet. Le
serveur le cherche là en priorité et retombe sur le python courant sinon.

## Ta position en direct sur la carte

L'agent a un second thread, `pz-export-position`, qui lit la position du
joueur local chaque seconde et l'écrit dans `~/Zomboid/pz-export/position.json` :

```json
{"x":10712.46,"y":9503.50,"z":0.00,"a":-1.571,"v":1,"m":0,"t":1790601505666}
```

`v` = en véhicule, `m` = mort, `t` = heure de la lecture dans le jeu. Écriture
dans un `.tmp` puis renommage atomique : le serveur ne lit jamais un fichier à
moitié écrit. Extension `.json` et pas `.ndjson` : `convertir.py` lit tous les
`.ndjson` du dossier et ne doit pas prendre la position pour un relevé.

Le serveur de la carte la sert sur `GET /api/position` (en-tête `X-Carte:
position` obligatoire, même garde que la synchro). La carte l'interroge chaque
seconde tant que la position est fraîche, toutes les 5 s sinon.

- **me suivre** (bouton en haut à droite, ou touche **F**) : la caméra suit le
  joueur. Glisser la carte arrête le suivi, sinon on ne pourrait plus regarder
  ailleurs.
- Le déplacement est interpolé entre deux lectures : la pastille et la caméra
  glissent au lieu de sauter chaque seconde, avec au plus une seconde de retard.
- La flèche suit le **déplacement réel**, pas l'angle `a` fourni par le jeu,
  dont la convention n'a pas pu être vérifiée en partie.
- Au-delà de 6 s sans nouvelle position, la pastille s'éteint et le panneau
  indique depuis quand : jeu fermé, menu, ou agent absent.
- Onglet Calques, case « ma position en direct » pour tout couper.

### Les autres joueurs

Le même fichier contient `"autres"`, les autres joueurs **connus de ton
client**, pris à deux endroits du jeu :

- `GameClient.IDToPlayerMap` : les joueurs **proches**, que ton client simule.
  Données complètes : étage, orientation, véhicule. Marqués `"p":1`.
- `WorldMapRemotePlayers` : ce qui alimente la carte du monde en jeu. Position
  et pseudo seulement, mais aussi pour les joueurs lointains, **si le serveur
  le permet** (option `MapRemotePlayerVisibility` : personne, faction, faction
  et visibles, tous). Marqués `"p":0`.

Fusion par identifiant réseau. Les joueurs invisibles (administrateurs)
restent cachés, avec la même règle que le jeu. Un joueur absent des deux
listes n'existe pas pour ton client : il ne peut pas apparaître sur la carte.

Sur la carte : pastille verte avec le pseudo, plus petite pour un joueur
lointain. Un clic dessus, ou « suivre » dans l'onglet Calques, fait suivre ce
joueur. Un joueur qui disparaît des listes (déconnexion, sortie de portée)
reste grisé 2 minutes avec « vu il y a… ».

### La direction

- **En mouvement** : le déplacement réel entre deux positions.
- **À l'arrêt** : l'orientation donnée par le jeu quand elle existe (toi et les
  joueurs proches), sinon la dernière direction connue.

Convention de l'angle, lue dans le code du jeu :
`IsoGameCharacter.getDirectionAngleRadians()` renvoie
`forwardDirection.getDirection()`, soit `atan2(y, x)`. Le vecteur en
coordonnées du monde est donc `(cos a, sin a)`.

Option de l'agent : `position=<ms>`, défaut 1000, `0` pour désactiver, 200 au
minimum.

## L'historique des déplacements (onglet Traces)

L'agent note les déplacements de chacun (toi et les autres joueurs connus de
ton client) dans `~/Zomboid/pz-export/traces/AAAA-MM-JJ.ndjson`, un fichier
par jour, classe `Journal`. Il n'écrit pas un point par seconde, seulement :

- tous les 2 cases parcourues ;
- à chaque changement d'étage, ou quand on monte ou descend d'un véhicule ;
- une fois par minute à l'arrêt, ce qui permet de mesurer les pauses.

Mesuré sur une heure simulée à deux joueurs, passée à la vraie classe : 3660
positions réduites à 686 points, 56 Ko. Les autres joueurs sont identifiés par
leur pseudo, stable d'une session à l'autre, pas par leur identifiant réseau.
Le dossier `traces/` est un sous-dossier : `convertir.py` ne lit que les
`.ndjson` du dossier lui-même et ne le confond pas avec un relevé.

Onglet **Traces** de la carte :

- choix du jour et des joueurs, plage horaire avec deux curseurs ;
- tracé plein à pied, pointillé en véhicule, coupé quand il manque des
  données plus de 2 min 30 (jeu fermé) ou en cas de saut (téléportation) ;
- **arrêts** de 3 min ou plus dans un rayon de 8 cases, avec leur durée ;
- statistiques : distance à pied et en véhicule, temps en mouvement, arrêts ;
- **rejouer** en accéléré (x30, x120, x600) ;
- le jour en cours se recharge toutes les 30 s pendant que tu joues ;
- « garder à l'écran » pour voir les traces depuis les autres onglets.

Rien n'est supprimé automatiquement. Pour faire le ménage, effacer les
fichiers de jours dans `traces/`. Option de l'agent : `journal=0` pour ne
rien enregistrer.

Un agent Java ne se charge qu'au lancement du jeu : après une mise à jour du
jar, il faut relancer Project Zomboid. Le jar se remplace par renommage
(`mv`), jamais en réécrivant le fichier : le jeu en cours garde l'ancien ouvert
et continue sans erreur.

## Limites

L'agent ne voit que la **zone chargée** autour de toi, bornée par
`IsoCell.getMinX()` à `getMaxZ()`. Ce n'est pas un scan global : la carte se
remplit à mesure que tu explores, et le fichier s'accumule.

Le balayage tourne sur son propre thread pendant que le jeu modifie le monde.
Des lectures incohérentes sont possibles ; chaque case est isolée dans un
`try/catch`, au pire elle est sautée et reprise au balayage suivant. L'agent
n'interrompt jamais le jeu, ce qui a été vérifié : privé des classes du jeu il
tourne en erreur en boucle sans faire tomber la JVM.

Le filtre par défaut garde les cases contenant un `IsoThumpable`. **Les portes
et fenêtres vanilla en sont aussi**, une maison d'origine intacte ressort donc.
La classe est partagée, ce n'est pas un défaut du filtre.

Les sprites venant de mods dont les textures n'ont pas été extraites sont
absents de l'index et ne se dessinent pas. `unpack` n'extrait que les mods
déclarés avec `texture: true` dans `conf/mod/pztogether.txt`. Sur un relevé de
1957 cases, quatre sprites `BuildingCraft_*` manquaient pour cette raison. Ils
ne sont jamais demandés au serveur, le convertisseur les signale.

La table de déduplication est bornée à 3 millions de cases ; au-delà elle
repart de zéro et le fichier contient des doublons, que `convertir.py`
élimine à la lecture.

## Sur le serveur

L'agent ne lit que la mémoire locale et n'écrit qu'un fichier local. Rien n'est
envoyé au serveur ni aux autres joueurs : `System.out` part dans le système de
journalisation du jeu, donc `~/Zomboid/console.txt`, et `zombie.debug.DebugLog`
n'a aucune méthode de remontée réseau.

Beaucoup de serveurs imposent une liste blanche de mods. À voir avec
l'administrateur.
