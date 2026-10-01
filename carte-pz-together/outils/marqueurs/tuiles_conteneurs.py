"""Lecture des definitions de tuiles du jeu, pour savoir lesquelles sont des
conteneurs.

Source : media/*.tiles.txt, la version texte des definitions de tuiles que le
jeu livre a cote des .tiles binaires. Chaque tuile y est annoncee par un
commentaire "// nom_de_tuile" suivi d'un bloc de proprietes. Une tuile de
rangement porte la propriete "container = <type>" : c'est ce type (counter,
metal_shelves, filingcabinet...) qui sert de cle dans Distributions.lua.
"""
import glob
import os
import re

# Tuiles de pompe a essence (propriete fuelAmount), remplies au chargement.
POMPES = set()

_NOM = re.compile(r'^\s*//\s*(\S+)\s*$')
_PROP = re.compile(r'^\s*(\w+)\s*=\s*(.*?)\s*$')


def lire_binaire(chemin):
    """Lit un .tiles binaire : nom de tuile -> type de conteneur.

    Certains mods ne livrent que le binaire : Raven Creek (RC.tiles,
    RCBucho.tiles) et six fichiers du CommunityTilePack. Ne lire que les
    .tiles.txt faisait passer leurs meubles pour du decor, et les pieces
    meublees avec pour des pieces vides.

    Format, tel que lu par le jeu (IsoWorld) :
        'tdef', int version            (absent sur les tres vieux fichiers)
        int nombre de feuilles
        par feuille : nom\n, image\n, int largeur, int hauteur,
                      int numero (version >= 1), int nombre de tuiles
        par tuile   : int nombre de proprietes, puis cle\n valeur\n
    Entiers sur 4 octets, petit-boutiste.
    """
    import struct
    with open(chemin, 'rb') as fh:
        d = fh.read()
    pos = 0

    def entier():
        nonlocal pos
        v = struct.unpack_from('<i', d, pos)[0]
        pos += 4
        return v

    def chaine():
        nonlocal pos
        fin = d.index(b'\n', pos)
        v = d[pos:fin].decode('utf8', 'replace').strip()
        pos = fin + 1
        return v

    version = 0
    if d[:4] == b'tdef':
        pos = 4
        version = entier()
    conteneurs = {}
    for _ in range(entier()):
        nom = chaine()
        chaine()                    # image
        larg, haut = entier(), entier()
        if version >= 1:
            entier()                # numero de la feuille
        for i in range(entier()):
            props = {}
            for _ in range(entier()):
                k = chaine()
                props[k] = chaine()
            if 'container' in props:
                conteneurs['%s_%d' % (nom, i)] = props['container'] or '?'
            if 'fuelAmount' in props:
                POMPES.add('%s_%d' % (nom, i))
    return conteneurs


def charger(pz_root, dossiers_mods=()):
    """nom de tuile -> type de conteneur, pour toutes les tuiles conteneurs.

    Version texte quand elle existe, sinon le binaire.
    """
    textes, binaires = [], []
    dossiers = [os.path.join(pz_root, 'media')] + list(dossiers_mods)
    for d in dossiers:
        for f in sorted(glob.glob(os.path.join(d, '**', '*.tiles'), recursive=True)):
            if os.path.isfile(f + '.txt'):
                textes.append(f + '.txt')
            else:
                binaires.append(f)
        # .tiles.txt orphelins (sans binaire a cote)
        for f in sorted(glob.glob(os.path.join(d, '**', '*.tiles.txt'), recursive=True)):
            if f not in textes:
                textes.append(f)
    conteneurs = {}
    for f in binaires:
        try:
            conteneurs.update(lire_binaire(f))
        except Exception as e:
            print('  tuiles illisibles %s : %s' % (os.path.basename(f), e))
    fichiers = textes
    for f in fichiers:
        nom = None
        with open(f, encoding='utf8', errors='replace') as fh:
            for ligne in fh:
                m = _NOM.match(ligne)
                if m:
                    nom = m.group(1)
                    continue
                if nom is None:
                    continue
                p = _PROP.match(ligne)
                if p and p.group(1) == 'container':
                    conteneurs[nom] = p.group(2) or '?'
                if p and p.group(1) == 'fuelAmount':
                    POMPES.add(nom)
    return conteneurs
