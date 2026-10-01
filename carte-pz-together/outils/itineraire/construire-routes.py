#!/usr/bin/env python3
"""Construit le reseau routier et les zones urbaines utilises par le GPS.

POURQUOI
    L'ancienne grille (construire-grille.py, 8 cases par pixel) rendait
    franchissables l'herbe, le sable et les sols interieurs. Le GPS coupait
    donc a travers champs et parfois a travers un batiment. Ici, seules les
    cases de chaussee comptent : rien d'autre n'existe pour l'itineraire.

CE QUE FAIT CE SCRIPT
    Cellule par cellule (256 x 256 cases, couche z=0), il classe chaque case :

        bitume   blends_street_01, tuiles pleines des teintes grises,
                 et floors_exterior_street
        gravier  blends_street_01, tuiles pleines des teintes beiges
        terre    blends_natural_01_64 a 71 (chemins de terre, cours)
        bati     un mur ou un sol interieur sur la case

    Dans chaque groupe de 16 tuiles de blends_street_01, les 8 premieres sont
    pleines, les 8 suivantes sont des bordures de fondu posees sur l'herbe :
    elles ne font pas une chaussee. Verifie a l'oeil sur les textures.

    Puis il regroupe par blocs de PAS x PAS cases. Un bloc est de la route
    s'il contient au moins ROUTE_MINI cases de chaussee et plus de chaussee
    que de bati. Le resultat est un PNG ou la valeur du pixel est la classe
    (1 bitume, 2 gravier, 3 terre, 0 rien). Le navigateur en tire un graphe :
    chaque pixel de route est un noeud, relie a ses 8 voisins de route.

    Zones urbaines : la densite de cases baties par bloc de 64 cases, seuillee,
    elargie d'un bloc, puis decoupee en composantes connexes. Chaque zone est
    nommee d'apres les points d'apparition du jeu (spawnpoints.lua) qu'elle
    contient, sinon d'apres le dossier de la carte moddee.

MEMOIRE
    Chaque cellule est lue dans un processus a part (environ 40 Mo) et ne
    renvoie que 64 x 64 octets. La grille globale tient en 22 Mo. Lancer sous
    plafond si le jeu tourne :
        systemd-run --user --scope -q -p MemoryMax=2G -p MemorySwapMax=0 \\
            .venv/bin/python outils/itineraire/construire-routes.py
"""
import json
import os
import re
import sys
import time

RACINE = os.path.dirname(os.path.abspath(__file__))
PROJET = os.path.normpath(os.path.join(RACINE, '..', '..'))
SORTIE = os.path.join(PROJET, 'out', 'html', 'map_data', 'routes')
JOURNAL = os.path.join(SORTIE, 'construction.log')

sys.path.insert(0, os.path.join(PROJET, 'pzmap2dzi'))

CELL = 256
PAS = 4                  # cases par pixel de route
PX = CELL // PAS
ROUTE_MINI = 6           # cases de chaussee sur 16 pour faire un pixel de route
PAS_VILLE = 64           # cases par bloc de densite urbaine
BV = CELL // PAS_VILLE
BATI_VILLE = 300         # cases baties sur 4096 pour qu'un bloc soit urbain
VILLE_MINI = 4           # blocs mini pour garder une zone (sinon ferme isolee)
RAYON_RATTACHE = 1500    # cases : un quartier sans nom rejoint la ville proche

RIEN, BITUME, GRAVIER, TERRE, BATI = 0, 1, 2, 3, 4

BLEND = re.compile(r'^blends_(street|natural)_0*(\d+)_(\d+)$')
BATI_RE = re.compile(r'^(walls_|floors_interior)')
SOL = 16                 # marque "tuile de sol pleine" dans classe_tuile


def classe_tuile(nom):
    """BATI, ou SOL + classe pour une tuile de sol pleine, ou 0 (decor).

    Ce qui compte est la surface VISIBLE : la derniere tuile de sol pleine
    posee sur la case. Beaucoup de cases gardent un bitume en dessous d'une
    herbe pleine (vieilles routes recouvertes, jardins poses sur une ancienne
    chaussee) ; prendre la meilleure tuile de la pile faisait passer le GPS
    a travers ces pelouses.
    """
    if BATI_RE.match(nom):
        return BATI
    m = BLEND.match(nom)
    if m:
        sorte, feuille, n = m.group(1), int(m.group(2)), int(m.group(3))
        if n % 16 >= 8:
            return 0                  # bordure de fondu, posee par-dessus
        if sorte == 'street':
            return SOL + (GRAVIER if (n // 16) in (1, 3) else BITUME)
        if feuille == 1 and 64 <= n < 72:
            return SOL + TERRE
        return SOL + RIEN             # sable, herbe, eau
    if nom.startswith('floors_exterior_street'):
        return SOL + BITUME
    if nom.startswith('floors_'):
        return SOL + RIEN             # trottoirs, dalles, planchers
    return 0


def classe_case(classes, tuiles):
    surface = RIEN
    for t in tuiles:
        c = classes[t]
        if c == BATI:
            return BATI
        if c >= SOL:
            surface = c - SOL
    return surface


VIDE = 255               # case sans aucune tuile


def lire_cases(chemin, cx, cy):
    """Classe de chaque case de la cellule (256*256 octets, x majeur), ou None.

    VIDE marque une case ou la carte ne pose rien du tout : c'est la que la
    vanilla reste visible sous une carte moddee.
    """
    from pzmap2dzi import cell
    try:
        c = cell.load_cell(chemin, cx, cy)
    except Exception:
        return None
    if not c or c.minlayer > 0 or c.maxlayer <= 0:
        return None
    classes = [classe_tuile(t) for t in c.header['tiles']]
    taille = min(c.cell_size, CELL)
    bs = c.block_size
    cases = bytearray([VIDE]) * (CELL * CELL)
    for sx in range(taille):
        bx, x = divmod(sx, bs)
        for sy in range(taille):
            by, y = divmod(sy, bs)
            couche = c.blocks[bx * c.block_per_cell + by][0]
            if not couche:
                continue
            ligne = couche[x]
            if not ligne:
                continue
            tuiles = ligne[y]
            if not tuiles:
                continue
            cases[sx * CELL + sy] = classe_case(classes, tuiles)
    return cases


def traiter_cellule(args):
    """Retourne (cx, cy, 64x64 octets de classe, BV*BV comptes de bati).

    Pour une cellule moddee, 'dessous' est le chemin de la vanilla : une
    carte moddee laisse souvent ses bords vides (Trelai en est entoure), et
    sans ce melange les routes vanilla s'arretaient net a sa frontiere.
    """
    chemin, cx, cy, dessous = args
    cases = lire_cases(chemin, cx, cy)
    if dessous:
        bas = lire_cases(dessous, cx, cy)
        if cases is None:
            cases = bas
        elif bas is not None:
            for i in range(CELL * CELL):
                if cases[i] == VIDE:
                    cases[i] = bas[i]
    if cases is None:
        return cx, cy, bytes(PX * PX), [0] * (BV * BV)
    # comptes[pixel] = [bitume, gravier, terre, bati]
    comptes = [[0, 0, 0, 0] for _ in range(PX * PX)]
    bati = [0] * (BV * BV)
    for sx in range(CELL):
        px = sx // PAS
        vx = sx // PAS_VILLE
        base = sx * CELL
        for sy in range(CELL):
            k = cases[base + sy]
            if k and k != VIDE:
                comptes[(sy // PAS) * PX + px][k - 1] += 1
                if k == BATI:
                    bati[(sy // PAS_VILLE) * BV + vx] += 1
    sortie = bytearray(PX * PX)
    for i, (b, g, t, m) in enumerate(comptes):
        route = b + g + t
        if route < ROUTE_MINI or m >= route:
            continue
        sortie[i] = BITUME if b >= 4 else (GRAVIER if b + g >= 4 else TERRE)
    retirer_champs(sortie)
    return cx, cy, bytes(sortie), bati


def retirer_champs(px):
    """Efface la terre en nappe : champs laboures, cours, terrains vagues.

    Un chemin de terre fait 3 a 6 cases, soit 1 ou 2 pixels de large. Un
    pixel de terre dont le voisinage 3 x 3 est entierement roulable est donc
    au milieu d'une nappe, pas sur un chemin. On efface ces pixels et leurs
    voisins de terre ; le bitume et le gravier ne sont jamais touches (un
    parking se traverse en voiture, un champ non).
    """
    larges = []
    for y in range(1, PX - 1):
        for x in range(1, PX - 1):
            i = y * PX + x
            if px[i] != TERRE:
                continue
            if all(px[i + dy * PX + dx] for dy in (-1, 0, 1) for dx in (-1, 0, 1)):
                larges.append(i)
    for i in larges:
        y, x = divmod(i, PX)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                xx, yy = x + dx, y + dy
                if 0 <= xx < PX and 0 <= yy < PX and px[yy * PX + xx] == TERRE:
                    px[yy * PX + xx] = RIEN


def cellules(chemin):
    out = []
    if not os.path.isdir(chemin):
        return out
    for f in os.listdir(chemin):
        if not f.endswith('.lotheader'):
            continue
        try:
            cx, cy = (int(v) for v in f[:-10].split('_'))
        except ValueError:
            continue
        out.append((cx, cy))
    return sorted(out)


def nom_lisible(dossier):
    """'Raven Creek B42', 'RavenCreek_B42', 'Muldraugh, KY' -> nom de ville."""
    nom = re.sub(r'(, KY|_B42|_4x4| B42)$', '', dossier).replace('_', ' ')
    nom = re.sub(r'(?<=[a-z])(?=[A-Z])', ' ', nom)
    return {'LQZ': 'Louisville (zone de quarantaine)',
            'Louisville Quarantine Zone': 'Louisville (zone de quarantaine)'}.get(nom, nom)


SPAWN = re.compile(r'posX\s*=\s*(\d+)\s*,\s*posY\s*=\s*(\d+)')


def points_nommes(cartes):
    """[(x, y, nom)] depuis les spawnpoints.lua du jeu et des mods."""
    pts = []
    vanilla = os.path.dirname(cartes['default'])
    dossiers = [os.path.join(vanilla, d) for d in os.listdir(vanilla)]
    for nom, chemin in cartes.items():
        if nom != 'default':
            dossiers.append(chemin)
    for d in dossiers:
        f = os.path.join(d, 'spawnpoints.lua')
        if not os.path.isfile(f):
            continue
        nom = nom_lisible(os.path.basename(d))
        with open(f, errors='replace') as fh:
            for m in SPAWN.finditer(fh.read()):
                pts.append((int(m.group(1)), int(m.group(2)), nom))
    # Louisville n'a pas de spawnpoints.lua a lui en B42.
    pts.append((12700, 1800, 'Louisville'))
    return pts


def zones_urbaines(bati, larg, haut, x0, y0, pts, mods):
    """Composantes de blocs urbains, nommees. Retourne (grille, noms)."""
    urbain = bytearray(larg * haut)
    for i, n in enumerate(bati):
        if n >= BATI_VILLE:
            urbain[i] = 1
    # Elargit d'un bloc : les rues en bordure de ville en font partie.
    large = bytearray(urbain)
    for y in range(haut):
        for x in range(larg):
            if urbain[y * larg + x]:
                for dy in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        xx, yy = x + dx, y + dy
                        if 0 <= xx < larg and 0 <= yy < haut:
                            large[yy * larg + xx] = 1
    ids = [0] * (larg * haut)
    zones = []
    for depart in range(larg * haut):
        if not large[depart] or ids[depart]:
            continue
        zid = len(zones) + 1
        pile = [depart]
        ids[depart] = zid
        blocs = []
        while pile:
            i = pile.pop()
            blocs.append(i)
            x, y = i % larg, i // larg
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                xx, yy = x + dx, y + dy
                if 0 <= xx < larg and 0 <= yy < haut:
                    j = yy * larg + xx
                    if large[j] and not ids[j]:
                        ids[j] = zid
                        pile.append(j)
        zones.append(blocs)
    garde = []
    for zid, blocs in enumerate(zones, 1):
        if len(blocs) < VILLE_MINI:
            for i in blocs:
                ids[i] = 0
            continue
        votes = {}
        for (px, py, nom) in pts:
            bx = (px - x0) // PAS_VILLE
            by = (py - y0) // PAS_VILLE
            if 0 <= bx < larg and 0 <= by < haut and ids[by * larg + bx] == zid:
                votes[nom] = votes.get(nom, 0) + 1
        for nom, (mx0, my0, mx1, my1) in mods.items():
            n = sum(1 for i in blocs
                    if mx0 <= (i % larg) * PAS_VILLE + x0 < mx1
                    and my0 <= (i // larg) * PAS_VILLE + y0 < my1)
            if n * 2 > len(blocs):
                votes[nom] = votes.get(nom, 0) + 1000
        sx = sum(i % larg for i in blocs) / len(blocs)
        sy = sum(i // larg for i in blocs) / len(blocs)
        cx = int(sx * PAS_VILLE + x0 + PAS_VILLE / 2)
        cy = int(sy * PAS_VILLE + y0 + PAS_VILLE / 2)
        if votes:
            nom = max(votes, key=votes.get)
        else:
            nom = None
        garde.append((zid, nom, cx, cy, len(blocs)))
    # Renumerote 1..n, les plus grandes d'abord ; ids sur un octet.
    garde.sort(key=lambda z: -z[4])
    garde = garde[:254]
    nouveau = {z[0]: k for k, z in enumerate(garde, 1)}
    grille = bytes(nouveau.get(i, 0) for i in ids)
    # Une zone sans point d'apparition est un quartier ou un hameau : elle
    # prend le nom de la ville nommee la plus proche si elle en est a moins de
    # RAYON_RATTACHE cases, sinon elle reste "zone isolee". Les morceaux d'une
    # meme ville portent le meme nom ; l'interface les regroupe par nom.
    nommees = [(z[1], z[2], z[3]) for z in garde if z[1]]
    noms = []
    for z in garde:
        nom = z[1]
        if not nom:
            proche = min(nommees, key=lambda n: (n[1] - z[2]) ** 2 + (n[2] - z[3]) ** 2,
                         default=None)
            if proche and ((proche[1] - z[2]) ** 2 + (proche[2] - z[3]) ** 2
                           <= RAYON_RATTACHE ** 2):
                nom = proche[0]
            else:
                nom = 'zone isolee'
        noms.append({'nom': nom, 'x': z[2], 'y': z[3], 'blocs': z[4]})
    return grille, noms


def main():
    import multiprocessing
    import importlib.util
    from PIL import Image
    spec = importlib.util.spec_from_file_location(
        'ex', os.path.join(PROJET, 'outils', 'marqueurs',
                           'extraire-marqueurs.py'))
    ex = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ex)

    os.makedirs(SORTIE, exist_ok=True)
    cartes = ex.charger_conf()
    listes = {nom: cellules(ch) for nom, ch in cartes.items()}
    toutes = [c for l in listes.values() for c in l]
    if not toutes:
        print('aucune cellule trouvee')
        return 1
    cx0 = min(c[0] for c in toutes)
    cy0 = min(c[1] for c in toutes)
    cx1 = max(c[0] for c in toutes)
    cy1 = max(c[1] for c in toutes)
    larg = (cx1 - cx0 + 1) * PX
    haut = (cy1 - cy0 + 1) * PX
    vl = (cx1 - cx0 + 1) * BV
    vh = (cy1 - cy0 + 1) * BV
    grille = bytearray(larg * haut)
    bati = [0] * (vl * vh)
    mods = {}
    total = len(toutes)
    faits = 0
    debut = time.time()
    # La vanilla d'abord, les cartes moddees ensuite : elles la recouvrent.
    ordre = sorted(cartes, key=lambda n: n != 'default')
    with open(JOURNAL, 'w') as jrn:
        jrn.write('total %d\n' % total)
        jrn.flush()
        for nom in ordre:
            liste = listes[nom]
            if not liste:
                continue
            if nom != 'default':
                mods[nom_lisible(nom)] = (
                    min(c[0] for c in liste) * CELL, min(c[1] for c in liste) * CELL,
                    (max(c[0] for c in liste) + 1) * CELL,
                    (max(c[1] for c in liste) + 1) * CELL)
            dessous = cartes['default'] if nom != 'default' else None
            travail = [(cartes[nom], cx, cy, dessous) for cx, cy in liste]
            with multiprocessing.Pool(4, maxtasksperchild=50) as pool:
                for cx, cy, bloc, bt in pool.imap_unordered(traiter_cellule,
                                                            travail, chunksize=2):
                    ox = (cx - cx0) * PX
                    oy = (cy - cy0) * PX
                    for y in range(PX):
                        grille[(oy + y) * larg + ox:(oy + y) * larg + ox + PX] = \
                            bloc[y * PX:(y + 1) * PX]
                    vx = (cx - cx0) * BV
                    vy = (cy - cy0) * BV
                    for y in range(BV):
                        for x in range(BV):
                            bati[(vy + y) * vl + vx + x] = bt[y * BV + x]
                    faits += 1
                    jrn.write('%s %d %d\n' % (nom, cx, cy))
                    jrn.flush()
        x0 = cx0 * CELL
        y0 = cy0 * CELL
        Image.frombytes('L', (larg, haut), bytes(grille)).save(
            os.path.join(SORTIE, 'routes.png'), optimize=True)
        pts = points_nommes(cartes)
        villes, noms = zones_urbaines(bati, vl, vh, x0, y0, pts, mods)
        Image.frombytes('L', (vl, vh), villes).save(
            os.path.join(SORTIE, 'villes.png'), optimize=True)
        compte = [0, 0, 0, 0]
        for v in grille:
            if v:
                compte[v] += 1
        index = {
            'version': int(time.time()),
            'pas': PAS, 'x0': x0, 'y0': y0, 'largeur': larg, 'hauteur': haut,
            'villes': {'pas': PAS_VILLE, 'largeur': vl, 'hauteur': vh,
                       'fichier': 'villes.png', 'zones': noms},
            'fichier': 'routes.png',
            'pixels': {'bitume': compte[1], 'gravier': compte[2], 'terre': compte[3]},
        }
        with open(os.path.join(SORTIE, 'index.json'), 'w') as f:
            json.dump(index, f, separators=(',', ':'), ensure_ascii=False)
        ligne = ('FINI %d cellules en %.0f s ; %d px bitume, %d gravier, '
                 '%d terre ; %d zones urbaines'
                 % (faits, time.time() - debut, compte[1], compte[2], compte[3],
                    len(noms)))
        jrn.write(ligne + '\n')
        print(ligne)
    return 0


if __name__ == '__main__':
    sys.exit(main())
