#!/usr/bin/env python3
"""Icones des vehicules : rendu du modele 3D du jeu, vu de dessus et de 3/4.

POURQUOI UN RENDU
Le jeu n'a aucune image de ses vehicules : il les dessine en 3D. Les mods
non plus, a part les schemas de l'ecran de mecanique. On refait donc ce que
fait le jeu, en plus simple : le maillage du script du vehicule, sa texture,
un eclairage, vu d'en haut (la pastille sur la carte) et de 3/4 (la fiche).

LA VUE ISOMETRIQUE
Sur la carte isometrique, le vehicule est vu comme dans le jeu : camera
orthographique tournee de 45 degres, inclinee pour qu'une case fasse un
losange deux fois plus large que haut (sin 30 = 1/2). Le relief ne se deduit
pas d'une image a plat : chaque cap est un rendu a part, arrondi a 32
directions ("iso00" a "iso31", l'avant vers l'est puis dans le sens des
aiguilles d'une montre a l'ecran). L'echelle est fixe, ISO_A pixels par
demi-largeur de losange, et le rendu note ou tombe le centre du vehicule au
sol (l'ancre) : la carte n'a qu'a poser l'image a sa place et l'agrandir.

LA PEINTURE
Lue dans media/shaders/vehicle_multiuv.frag : l'alpha de la texture dit ou
la carrosserie est peinte (alpha 1 : pas de peinture, chrome, vitres, pneus).
La couleur peinte garde la saturation et la valeur de la texture, decalees
de celles du vehicule, avec SA teinte :
    hsv = (teinte, s_tex + saturation - 0.5, v_tex + valeur - 0.5)
    couleur = mix(texture, hsv2rgb(hsv), 1 - alpha)
Chaque vehicule a sa couleur : le rendu ne peut donc pas etre fige ici. Il
sort deux images empilees, la texture telle quelle en haut, et en bas
l'amount de peinture (rouge) et l'eclairage (vert). La carte refait le
melange avec la couleur de chaque vehicule.

D'OU VIENNENT LES FICHIERS
Scripts, maillages et textures du jeu, puis des mods de l'atelier Steam.
Pour un mod build 42 : le dossier de version le plus recent qui ne depasse
pas celle du jeu, puis common/. Le maillage est converti par assimp (deja
installe) en OBJ, lu ici. Aucun fichier du jeu n'est modifie.

Usage :
    python3 icones_vehicules.py Base.CarNormal [skin]   rend un vehicule
    python3 icones_vehicules.py --tout                  rend tous les scripts
Le serveur de la carte l'appelle a la demande et garde le resultat dans
vehicules-icones/ (non versionne).
"""

import functools
import glob
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading

import numpy as np
from PIL import Image

JEU = os.environ.get('PZCARTE_JEU') or os.path.expanduser(
    '~/.local/share/Steam/steamapps/common/ProjectZomboid/projectzomboid')
ATELIER = os.environ.get('PZCARTE_ATELIER') or os.path.expanduser(
    '~/.local/share/Steam/steamapps/workshop/content/108600')
VERSION_JEU = (42, 20)
ICI = os.path.dirname(os.path.realpath(__file__))
CACHE = os.path.join(ICI, 'vehicules-icones')
# Le contenu du rendu change si ce code change : le numero entre dans le nom
# des fichiers en cache.
VERSION_RENDU = 3

DESSUS = 96     # px pour la longueur du vehicule, vue de dessus
TROIS_QUARTS = 180   # px de large, vue de 3/4
ISO_A = 24      # px par case le long d'un axe, a l'horizontale (64 sur la carte au zoom max)
ISO_CAPS = 32   # directions rendues en vue isometrique
ISO_H = ISO_A * 2 * 0.8660254 / 2 ** 0.5   # px par case de hauteur : cos 30 x (A / cos 45)
VUES = ('dessus', '34') + tuple('iso%02d' % i for i in range(ISO_CAPS))
SURECH = 3      # sur-echantillonnage, pour lisser les bords


# --- les dossiers media ----------------------------------------------------------

def _version(nom):
    m = re.match(r'^(\d+)(?:\.(\d+))?$', nom)
    return (int(m.group(1)), int(m.group(2) or 0)) if m else None


def racines_media():
    """Dossiers media/ par priorite decroissante : mods, puis le jeu.

    Un mod n'est pas forcement actif sur le serveur : on n'en sait rien d'ici.
    Ce n'est pas genant, un script de vehicule n'est cherche que par son nom.
    """
    racines = []
    for mod in sorted(glob.glob(os.path.join(ATELIER, '*/mods/*'))):
        versions = []
        for d in os.listdir(mod):
            v = _version(d)
            if v and v <= VERSION_JEU and os.path.isdir(os.path.join(mod, d, 'media')):
                versions.append((v, d))
        if versions:
            racines.append(os.path.join(mod, max(versions)[1], 'media'))
        if os.path.isdir(os.path.join(mod, 'common', 'media')):
            racines.append(os.path.join(mod, 'common', 'media'))
        if not versions and os.path.isdir(os.path.join(mod, 'media')):
            racines.append(os.path.join(mod, 'media'))   # mod build 41
    racines.append(os.path.join(JEU, 'media'))
    return racines


# --- lecture des scripts ---------------------------------------------------------

JETON = re.compile(r'/\*.*?\*/|//[^\n]*|\{|\}|[^{}\n]+', re.S)


def lire_blocs(texte):
    """Arbre des blocs : [(entete, {cle: [valeurs]}, [enfants])]."""
    pile = [('', {}, [])]
    attente = ''
    for m in JETON.finditer(texte):
        t = m.group(0)
        if t.startswith('/*') or t.startswith('//'):
            continue
        if t == '{':
            bloc = (attente.strip(), {}, [])
            pile[-1][2].append(bloc)
            pile.append(bloc)
            attente = ''
        elif t == '}':
            if len(pile) > 1:
                pile.pop()
            attente = ''
        else:
            for morceau in t.split(','):
                if '=' in morceau:
                    k, v = morceau.split('=', 1)
                    pile[-1][1].setdefault(k.strip().rstrip('!').strip(), []).append(v.strip())
                    if k.strip().endswith('!'):
                        pile[-1][1].setdefault('template!', []).append(v.strip())
                    attente = ''
                elif morceau.strip():
                    attente = morceau
    return pile[0]


_index = None
_verrou_index = threading.Lock()


def index():
    """Vehicules, gabarits et modeles de tous les scripts. Une fois par process."""
    global _index
    with _verrou_index:
        if _index is not None:
            return _index
        vehicules, gabarits, modeles = {}, {}, {}
        racines = racines_media()
        # Du moins prioritaire au plus prioritaire : le dernier lu gagne.
        for racine in reversed(racines):
            for f in glob.glob(os.path.join(racine, 'scripts', '**', '*.txt'), recursive=True):
                try:
                    texte = open(f, encoding='utf-8', errors='replace').read()
                except OSError:
                    continue
                if 'vehicle' not in texte and 'model' not in texte:
                    continue
                for module in lire_blocs(texte)[2]:
                    mots = module[0].split()
                    if len(mots) != 2 or mots[0] != 'module':
                        continue
                    for bloc in module[2]:
                        e = bloc[0].split()
                        if len(e) == 2 and e[0] == 'vehicle':
                            vehicules['%s.%s' % (mots[1], e[1])] = bloc
                        elif len(e) == 3 and e[0] == 'template' and e[1] == 'vehicle':
                            gabarits[e[2]] = bloc
                        elif len(e) == 2 and e[0] == 'model':
                            modeles[e[1]] = bloc
        fichiers = {'models_X': {}, 'textures': {}}
        for racine in reversed(racines):
            try:
                presents = os.listdir(racine)
            except OSError:
                continue
            for sous in fichiers:
                # Sans tenir compte de la casse : le mod des semi-remorques
                # range ses maillages dans models_x, le jeu dans models_X.
                for d in presents:
                    if d.lower() != sous.lower():
                        continue
                    base = os.path.join(racine, d)
                    for dossier, _, noms in os.walk(base):
                        for n in noms:
                            rel = os.path.relpath(os.path.join(dossier, n), base)
                            fichiers[sous][rel.lower().replace('\\', '/')] = os.path.join(dossier, n)
        _index = {'vehicules': vehicules, 'gabarits': gabarits, 'modeles': modeles,
                  'fichiers': fichiers}
        return _index


def par_nom(table, nom):
    """Un modele ou un gabarit, nomme seul ou avec son module.

    Les scripts ecrivent l'un ou l'autre : "file = Vehicles_CarNormal" chez le
    jeu, "file = Rotators.SemiTruckBase" chez le mod des semi-remorques. Les
    tables sont indexees par le nom seul.
    """
    return table.get(nom) or table.get(nom.rsplit('.', 1)[-1])


def _chaine_gabarits(bloc, ix, vus=None):
    """Le vehicule, puis ses gabarits (template!, template) dans l'ordre."""
    vus = vus or set()
    yield bloc
    for nom in bloc[1].get('template!', []) + bloc[1].get('template', []):
        g = par_nom(ix['gabarits'], nom)
        if g is not None and nom not in vus:
            vus.add(nom)
            yield from _chaine_gabarits(g, ix, vus)


def decrire(script):
    """Ce qu'il faut pour rendre un vehicule, ou None."""
    ix = index()
    bloc = ix['vehicules'].get(script)
    if bloc is None and '.' not in script:
        bloc = ix['vehicules'].get('Base.' + script)
    if bloc is None:
        return None
    fichier = peaux = etendue = None
    echelle = 1.0
    pieces, vues = [], set()
    for b in _chaine_gabarits(bloc, ix):
        # Les pieces (portieres, capot, coffre...) que certains mods modelisent
        # a part. On prend le premier modele de chaque piece, celui que le jeu
        # pose par defaut. Pas les blindages : en option, ils recouvriraient
        # la carrosserie.
        for enfant in b[2]:
            e = enfant[0].split()
            if len(e) != 2 or e[0] != 'part' or e[1] in vues or 'armor' in e[1].lower():
                continue
            for m in enfant[2]:
                if m[0].split()[:1] == ['model'] and 'file' in m[1]:
                    vues.add(e[1])
                    pieces.append(m[1]['file'][-1])
                    break
        for enfant in b[2]:
            if enfant[0] == 'model' and 'file' in enfant[1] and fichier is None:
                fichier = enfant[1]['file'][-1]
                echelle = _nombre(enfant[1].get('scale'), 1.0)
            if enfant[0] == 'skin' and 'texture' in enfant[1] and peaux is None:
                peaux = [s[1]['texture'][-1] for s in b[2] if s[0] == 'skin' and 'texture' in s[1]]
        if etendue is None and 'extents' in b[1]:
            etendue = [float(x) for x in b[1]['extents'][-1].split()]
    if not fichier:
        return None
    modele = par_nom(ix['modeles'], fichier)
    if modele is None or 'mesh' not in modele[1]:
        return None
    maillage = modele[1]['mesh'][-1]
    # Seules les pieces du MEME fichier que la carrosserie : elles sont
    # modelisees en place. Un fichier a part aurait son propre repere, avec un
    # decalage que l'on ne sait pas reproduire ici.
    fichier_corps = maillage.partition('|')[0].lower()
    autres = []
    for nom in pieces:
        m = par_nom(ix['modeles'], nom)
        if m is None or 'mesh' not in m[1]:
            continue
        mesh = m[1]['mesh'][-1]
        if mesh.partition('|')[0].lower() == fichier_corps and mesh != maillage:
            autres.append((mesh, m[1]['texture'][-1] if 'texture' in m[1] else None))
    # Taille reelle : unites du maillage x echelle du modele x echelle du
    # vehicule. Donne des metres, soit des cases : 4,8 x 1,9 pour la
    # Chevalier Nyala, 4,5 x 2,4 pour le HMMWV.
    echelle *= _nombre(modele[1].get('scale'), 1.0)
    return {'script': script, 'maillage': maillage, 'peaux': peaux or [],
            'etendue': etendue, 'pieces': autres, 'echelle': echelle}


def _nombre(valeurs, defaut):
    try:
        return float(valeurs[-1])
    except (TypeError, ValueError, IndexError):
        return defaut


def trouver_fichier(sous, chemin, extensions):
    ix = index()
    c = chemin.lower().replace('\\', '/')
    for ext in extensions:
        f = ix['fichiers'][sous].get(c + ext)
        if f:
            return f
    return None


# --- maillage ----------------------------------------------------------------------

@functools.lru_cache(maxsize=6)
def lire_fichier_maillage(nom):
    """{sous-maillage: (positions, uv)} d'un fichier de modele.

    assimp convertit en JSON, qui garde la hierarchie des noeuds. Les
    transformations des noeuds sont appliquees ici : les mods exportes de
    Blender posent chaque piece par une translation et une rotation de -90
    degres (Z vers le haut chez Blender, Y chez le jeu). L'export OBJ les
    ignorait et rendait les pieces en vrac.
    """
    source = trouver_fichier('models_X', nom, ('.fbx', '.x', '.glb', '.gltf', ''))
    if not source:
        raise FileNotFoundError('maillage introuvable : %s' % nom)
    with tempfile.TemporaryDirectory() as tmp:
        sortie = os.path.join(tmp, 'm.json')
        subprocess.run(['assimp', 'export', source, sortie, '-fassjson'], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        with open(sortie, encoding='utf-8', errors='replace') as f:
            scene = json.load(f)
    maillages = scene.get('meshes', [])
    groupes = {}

    def parcourir(noeud, parent):
        m = parent @ np.array(noeud.get('transformation', np.eye(4).ravel()), dtype=np.float64).reshape(4, 4)
        for i in noeud.get('meshes', []) or []:
            me = maillages[i]
            v = np.array(me['vertices'], dtype=np.float64).reshape(-1, 3)
            v = v @ m[:3, :3].T + m[:3, 3]
            tc = me.get('texturecoords') or []
            if tc:
                k = (me.get('numuvcomponents') or [2])[0]
                uv = np.array(tc[0], dtype=np.float64).reshape(-1, k)[:, :2]
            else:
                uv = np.zeros((len(v), 2))
            tri = []
            for f in me.get('faces', []):
                for j in range(1, len(f) - 1):
                    tri.append((f[0], f[j], f[j + 1]))
            if not tri:
                continue
            tri = np.array(tri)
            nom_m = me.get('name') or noeud.get('name', '')
            p, t = v[tri], uv[tri]
            if nom_m in groupes:
                p = np.concatenate([groupes[nom_m][0], p])
                t = np.concatenate([groupes[nom_m][1], t])
            groupes[nom_m] = (p, t)
        for c in noeud.get('children', []) or []:
            parcourir(c, m)

    parcourir(scene['rootnode'], np.eye(4))
    return groupes


def choisir(groupes, sous, nom):
    if sous:
        choisis = [g for g in groupes if g == sous] or [g for g in groupes if sous.lower() in g.lower()]
    else:
        choisis = list(groupes)
    if not choisis:
        raise ValueError('sous-maillage %s absent de %s' % (sous, nom))
    return (np.concatenate([groupes[g][0] for g in choisis]),
            np.concatenate([groupes[g][1] for g in choisis]))


def orienter(pos, etendue):
    """Remet le maillage dans le repere du script : x largeur, y hauteur, z longueur.

    Les modeles du jeu sont deja ainsi (avant vers +z, gauche vers +x : voir
    les places "FrontLeft" des scripts). Un mod peut avoir exporte autrement :
    on choisit la permutation d'axes dont les proportions collent le mieux a
    "extents".
    """
    taille = np.ptp(pos.reshape(-1, 3), axis=0)
    if not etendue or min(etendue) <= 0 or int(np.argmax(taille)) == 2:
        return pos
    meilleur, ordre = None, (0, 1, 2)
    cible = np.array(etendue) / max(etendue)
    for o in ((0, 1, 2), (0, 2, 1), (2, 1, 0), (1, 0, 2), (1, 2, 0), (2, 0, 1)):
        t = taille[list(o)] / max(taille)
        e = float(np.abs(np.log((t + 1e-6) / (cible + 1e-6))).sum())
        if meilleur is None or e < meilleur - 1e-3:
            meilleur, ordre = e, o
    return pos[..., list(ordre)]


# --- rendu -------------------------------------------------------------------------

def _rotation(lacet, tangage):
    a, b = np.radians(lacet), np.radians(tangage)
    ry = np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])
    rx = np.array([[1, 0, 0], [0, np.cos(b), -np.sin(b)], [0, np.sin(b), np.cos(b)]])
    return rx @ ry


def projeter_iso(pos, unite, cap):
    """Maillage -> (x ecran, y ecran, profondeur) en pixels de la vue iso, et le monde.

    Repere du vehicule (voir rendre) : avant vers -z, droite vers -x, haut
    vers +y. Repere du monde : x vers l'est, y vers le sud (vers le bas de la
    carte), h vers le haut, en cases. Le centre du vehicule est mis au sol.
    """
    a = 2 * np.pi * cap / ISO_CAPS
    fx, fy = np.cos(a), np.sin(a)          # avant, dans le monde
    rx, ry = -fy, fx                       # droite : l'avant tourne d'un quart vers l'ecran-droite
    v = pos.reshape(-1, 3)
    cx = (v[:, 0].min() + v[:, 0].max()) / 2
    cz = (v[:, 2].min() + v[:, 2].max()) / 2
    av = -(pos[..., 2] - cz) * unite
    dr = -(pos[..., 0] - cx) * unite
    h = (pos[..., 1] - v[:, 1].min()) * unite
    wx = fx * av + rx * dr
    wy = fy * av + ry * dr
    monde = np.stack([wx, wy, h], axis=-1)
    p = np.stack([(wx - wy) * ISO_A,
                  (wx + wy) * ISO_A / 2 - h * ISO_H,
                  # plus pres de la camera (sud-est, en haut) = plus petit
                  -((wx + wy) * 0.6123724 + h * 0.5)], axis=-1)
    return p, monde


def rendre(pos, uv, numtex, textures, vue, unite=1.0):
    """Rasterise les triangles. Rend (image, ancre).

    image : couleur RGBA en haut, peinture-eclairage RGBA en bas.
    ancre : (x, y) en pixels du centre du vehicule au sol, en vue iso ; None sinon.

    Dans les maillages du jeu l'AVANT est vers -z : verifie sur le rendu de
    3/4, ou un lacet de -35 degres montrait la plaque et les feux arriere.

    vue 'dessus' : vu d'en haut, l'avant en haut de l'image. C'est une
    rotation (pas un miroir) de la vue naturelle depuis +y : la carte n'a plus
    qu'a tourner l'image selon le cap du vehicule.
    vue '34' : avant-gauche, d'un peu haut.
    vue 'isoNN' : camera de la carte isometrique, cap NN (voir projeter_iso),
    a echelle fixe : unite convertit le maillage en cases.
    """
    monde = pos
    if vue.startswith('iso'):
        p, monde = projeter_iso(pos, unite, int(vue[3:]))
        p = p * SURECH
        echelle = 1.0
        origine = np.array([0.0, 0.0])
    elif vue == 'dessus':
        # ecran x = -x, ecran y = +z, profondeur = -y (plus haut = plus pres)
        p = np.stack([-pos[..., 0], pos[..., 2], -pos[..., 1]], axis=-1)
        cote = DESSUS * SURECH
        echelle = cote / max(1e-6, np.ptp(p[..., 1]))
    else:
        r = _rotation(145, 32)
        q = pos @ r.T
        p = np.stack([-q[..., 0], -q[..., 1], -q[..., 2]], axis=-1)
        cote = TROIS_QUARTS * SURECH
        echelle = cote / max(1e-6, np.ptp(p[..., 0]))
    mini = p.reshape(-1, 3).min(axis=0)
    if vue.startswith('iso'):
        origine = (origine - mini[:2]) + SURECH * 2
    p = (p - mini) * echelle
    p[..., 0] += SURECH * 2
    p[..., 1] += SURECH * 2
    larg = int(np.ceil(p[..., 0].max())) + SURECH * 4
    haut = int(np.ceil(p[..., 1].max())) + SURECH * 4

    # Normales des faces, dans le repere du monde, pour l'eclairage.
    n = np.cross(monde[:, 1] - monde[:, 0], monde[:, 2] - monde[:, 0])
    n /= np.linalg.norm(n, axis=1, keepdims=True) + 1e-12
    # En iso, la lumiere est fixe dans le monde (haut, un peu du nord-ouest) :
    # elle ne tourne pas avec le vehicule.
    lumiere = np.array([-0.3, -0.4, 0.85]) if vue.startswith('iso') else np.array([0.35, 0.85, 0.4])
    lumiere /= np.linalg.norm(lumiere)
    # Faces dans les deux sens : les maillages de jeu ne sont pas toujours
    # orientes de facon coherente.
    eclair = 0.5 + 0.6 * np.abs(n @ lumiere)

    texs = [np.asarray(t.convert('RGBA'), dtype=np.float32) / 255.0 for t in textures]

    prof = np.full((haut, larg), np.inf, dtype=np.float64)
    coul = np.zeros((haut, larg, 4), dtype=np.float32)
    aux = np.zeros((haut, larg, 2), dtype=np.float32)

    for i in range(len(p)):
        (x0, y0, z0), (x1, y1, z1), (x2, y2, z2) = p[i]
        aire = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        if abs(aire) < 1e-9:
            continue
        bx0, bx1 = int(max(0, np.floor(min(x0, x1, x2)))), int(min(larg - 1, np.ceil(max(x0, x1, x2))))
        by0, by1 = int(max(0, np.floor(min(y0, y1, y2)))), int(min(haut - 1, np.ceil(max(y0, y1, y2))))
        if bx1 < bx0 or by1 < by0:
            continue
        xs, ys = np.meshgrid(np.arange(bx0, bx1 + 1) + 0.5, np.arange(by0, by1 + 1) + 0.5)
        w0 = ((x1 - xs) * (y2 - ys) - (x2 - xs) * (y1 - ys)) / aire
        w1 = ((x2 - xs) * (y0 - ys) - (x0 - xs) * (y2 - ys)) / aire
        w2 = 1 - w0 - w1
        dedans = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not dedans.any():
            continue
        z = w0 * z0 + w1 * z1 + w2 * z2
        zone = prof[by0:by1 + 1, bx0:bx1 + 1]
        devant = dedans & (z < zone)
        if not devant.any():
            continue
        u = w0 * uv[i, 0, 0] + w1 * uv[i, 1, 0] + w2 * uv[i, 2, 0]
        v = w0 * uv[i, 0, 1] + w1 * uv[i, 1, 1] + w2 * uv[i, 2, 1]
        tex = texs[numtex[i]]
        th, tw = tex.shape[:2]
        tx = (np.mod(u, 1.0) * tw).astype(int).clip(0, tw - 1)
        ty = (np.mod(1.0 - v, 1.0) * th).astype(int).clip(0, th - 1)
        echant = tex[ty, tx]
        zone[devant] = z[devant]
        c = coul[by0:by1 + 1, bx0:bx1 + 1]
        c[devant, :3] = echant[devant, :3]
        c[devant, 3] = 1.0
        a = aux[by0:by1 + 1, bx0:bx1 + 1]
        a[devant, 0] = 1.0 - echant[devant, 3]
        a[devant, 1] = eclair[i]

    def reduire(img):
        h2, w2 = haut // SURECH, larg // SURECH
        img = img[:h2 * SURECH, :w2 * SURECH]
        return img.reshape(h2, SURECH, w2, SURECH, -1).mean(axis=(1, 3))

    cou = reduire(coul)
    au = reduire(aux)
    alpha = cou[..., 3:4]
    # Moyenne ponderee par la couverture : sans cela les bords tirent vers le
    # noir du fond.
    rgb = np.where(alpha > 0, cou[..., :3] / np.maximum(alpha, 1e-6), 0)
    au = np.where(alpha > 0, au / np.maximum(alpha, 1e-6), 0)
    haut_ = np.concatenate([rgb, alpha], axis=-1)
    bas = np.concatenate([au[..., :1], np.clip(au[..., 1:2] / 1.2, 0, 1),
                          np.zeros_like(alpha), alpha], axis=-1)
    img = (np.clip(np.concatenate([haut_, bas], axis=0), 0, 1) * 255).astype(np.uint8)
    ancre = None
    if vue.startswith('iso'):
        ancre = (round(float(origine[0]) / SURECH, 2), round(float(origine[1]) / SURECH, 2))
    return img, ancre


# --- cache ---------------------------------------------------------------------------

_verrous = {}
_verrou_verrous = threading.Lock()
NOM_SUR = re.compile(r'^[A-Za-z0-9_.\-]+$')


def chemin_icone(script, peau, vue):
    return os.path.join(CACHE, 'v%d' % VERSION_RENDU, '%s.%d.%s.png' % (script, peau, vue))


def icone(script, peau=0, vue='dessus'):
    """Chemin du PNG en cache, rendu au besoin. None si le vehicule est inconnu."""
    if not NOM_SUR.match(script) or vue not in VUES:
        return None
    chemin = chemin_icone(script, peau, vue)
    if os.path.isfile(chemin):
        return chemin
    echec = chemin + '.echec'
    if os.path.isfile(echec):
        return None
    with _verrou_verrous:
        verrou = _verrous.setdefault(chemin, threading.Lock())
    with verrou:
        if os.path.isfile(chemin):
            return chemin
        os.makedirs(os.path.dirname(chemin), exist_ok=True)
        try:
            d = decrire(script)
            if not d:
                raise LookupError('script inconnu')
            peaux = d['peaux'] or ['']
            nom_tex = peaux[peau] if 0 <= peau < len(peaux) else peaux[0]
            nom, _, sous = d['maillage'].partition('|')
            groupes = lire_fichier_maillage(nom)
            morceaux = [(choisir(groupes, sous, nom), nom_tex)]
            for mesh, tex in d['pieces']:
                try:
                    morceaux.append((choisir(groupes, mesh.partition('|')[2], nom), tex or nom_tex))
                except ValueError:
                    pass
            noms_tex = sorted({t for _, t in morceaux}, key=lambda t: t or '')
            textures = []
            for t in noms_tex:
                f = trouver_fichier('textures', t, ('.png', '')) if t else None
                textures.append(Image.open(f) if f else Image.new('RGBA', (4, 4), (160, 160, 160, 0)))
            pos = np.concatenate([m[0][0] for m in morceaux])
            uv = np.concatenate([m[0][1] for m in morceaux])
            numtex = np.concatenate([np.full(len(m[0][0]), noms_tex.index(m[1])) for m in morceaux])
            pos = orienter(pos, d['etendue'])
            img, ancre = rendre(pos, uv, numtex, textures, vue, d['echelle'])
        except Exception as e:
            # On note l'echec pour ne pas relancer assimp a chaque requete.
            with open(echec, 'w') as f:
                f.write('%s\n' % e)
            return None
        taille = np.ptp(pos.reshape(-1, 3), axis=0) * d['echelle']
        with open(chemin[:-4] + '.json', 'w') as f:
            json.dump({'longueur': round(float(taille[2]), 2), 'largeur': round(float(taille[0]), 2),
                       'peaux': len(d['peaux']), 'ancre': ancre,
                       'echelle': ISO_A if ancre else None}, f)
        tmp = chemin + '.tmp'
        Image.fromarray(img, 'RGBA').save(tmp, 'PNG', optimize=True)
        os.replace(tmp, chemin)
        return chemin


def mesures(chemin):
    """Longueur et largeur en cases, ecrites a cote de l'icone."""
    try:
        with open(chemin[:-4] + '.json') as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def infos(script):
    """Nombre de peaux et longueur (extents) du vehicule, pour la carte."""
    d = decrire(script)
    if not d:
        return None
    return {'peaux': len(d['peaux']), 'etendue': d['etendue']}


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--tout':
        noms = sorted(index()['vehicules'])
        ok = 0
        for i, s in enumerate(noms):
            for vue in ('dessus', '34'):
                if icone(s, 0, vue):
                    ok += 1
            print('%d/%d %s' % (i + 1, len(noms), s), flush=True)
        print('%d icones' % ok)
    elif len(sys.argv) > 1:
        s = sys.argv[1]
        p = int(sys.argv[2]) if len(sys.argv) > 2 else 0
        print(decrire(s))
        for vue in ('dessus', '34'):
            print(icone(s, p, vue))
