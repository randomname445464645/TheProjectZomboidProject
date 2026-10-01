#!/usr/bin/env python3
"""Construit la grille de cout de deplacement qui sert a l'itineraire auto.

POURQUOI PAS LES RUES
    On a deja streets/marks.json, 1183 polylignes nommees. Ce n'est PAS un
    reseau routier : ce sont des lignes de reperage pour poser les noms de
    rues. Mesure faite avant d'ecrire ce script, en fusionnant les points
    proches :

        rayon  2 cases : 1078 composantes, la plus grande 1 % des noeuds
        rayon 20 cases :  573 composantes, la plus grande 18 %

    Un graphe aussi eclate ne peut pas router. D'ou la lecture des vraies
    tuiles du jeu.

CE QUE FAIT CE SCRIPT
    Pour chaque carte, il lit les .lotpack, regarde la couche z=0 et donne a
    chaque bloc de PAS x PAS cases un cout de deplacement.

    Le cout du bloc est le MEILLEUR cout qui occupe au moins un quart des
    cases. Prendre simplement le meilleur ne marche pas : mesure faite sur la
    cellule 25,20 de la vanilla, 535 pixels sur 1024 devenaient de la route,
    parce qu'une seule case de bitume sur 64 suffisait a peindre tout le bloc.
    Prendre la majorite ne marche pas non plus, une route qui longe le bord
    d'un bloc disparait. Le quart garde les routes continues sans les faire
    deborder.

    Sortie : un PNG en niveaux de gris par carte, ou la valeur du pixel EST le
    cout, plus un index JSON avec l'origine et l'echelle. Le PNG est le bon
    format : les zones vides sont uniformes et se compressent a presque rien,
    et le navigateur sait le decoder sans bibliotheque.

    Les motifs de reconnaissance des tuiles viennent de pzmap2dzi
    (render_impl/base.py, _cs_pattern), pas d'une invention locale.
"""
import json
import os
import re
import sys
import time

RACINE = os.path.dirname(os.path.abspath(__file__))
PROJET = os.path.normpath(os.path.join(RACINE, '..', '..'))
SORTIE = os.path.join(PROJET, 'out', 'html', 'map_data', 'itineraire')
JOURNAL = os.path.join(SORTIE, 'construction.log')

sys.path.insert(0, os.path.join(PROJET, 'pzmap2dzi'))

PAS = 8          # cases par pixel
CELL = 256       # cases par cellule de carte
PX_CELL = CELL // PAS

# Cout par nature de terrain. 0 = infranchissable. Plus c'est petit, plus
# l'itineraire aime y passer.
BLOQUE = 0
COUTS = [
    # (motif, cout) dans l'ordre de priorite : le premier qui matche gagne
    (re.compile('_street_'), 1),
    (re.compile('_railroad'), 3),
    (re.compile('(floors_exterior_tilesandstone|floors_interior_carpet|'
                'floors_interior_tilesandwood|^location_)'), 2),
    (re.compile('_natural_(.*_)*0*1_\\d+$'), 5),      # sable, herbe, terre
    (re.compile('(_trees|jumbo)'), 12),
    (re.compile('^vegetation'), 7),
]
EAU = re.compile('_natural_(.*_)*0*2_\\d+$')


# Un cout doit couvrir au moins cette part du bloc pour le representer.
PART_MINI = 4    # un quart


def cout_case(tuiles):
    """Cout d'une case, depuis la liste de ses tuiles. 0 si infranchissable."""
    meilleur = 0
    for t in tuiles:
        if EAU.search(t):
            return BLOQUE
        for motif, c in COUTS:
            if motif.search(t):
                if meilleur == 0 or c < meilleur:
                    meilleur = c
                break
    return meilleur


def cout_bloc(compte, cases):
    """Meilleur cout qui occupe au moins un quart du bloc, 0 sinon."""
    seuil = max(1, cases // PART_MINI)
    for c in sorted(compte):
        if c and compte[c] >= seuil:
            return c
    return BLOQUE


def traiter_cellule(args):
    chemin, cx, cy = args
    from pzmap2dzi import cell
    import collections
    bloc = bytearray(PX_CELL * PX_CELL)
    try:
        c = cell.load_cell(chemin, cx, cy)
    except Exception:
        return cx, cy, bytes(bloc)
    if not c:
        return cx, cy, bytes(bloc)
    comptes = [collections.Counter() for _ in range(PX_CELL * PX_CELL)]
    for sx in range(min(c.cell_size, CELL)):
        px = sx // PAS
        for sy in range(min(c.cell_size, CELL)):
            carre = c.get_square(sx, sy, 0)
            if not carre:
                continue
            v = cout_case(carre)
            if v:
                comptes[py_index(px, sy // PAS)][v] += 1
    for i, compte in enumerate(comptes):
        bloc[i] = cout_bloc(compte, PAS * PAS)
    return cx, cy, bytes(bloc)


def py_index(px, py):
    return py * PX_CELL + px


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
    total = sum(len(cellules(c)) for c in cartes.values())
    # La version sert a contourner le cache HTTP : le serveur envoie les .png
    # avec max-age d'une semaine, un PNG reconstruit ne serait pas relu.
    index = {'pas': PAS, 'version': int(time.time()), 'cartes': {}}
    faits = 0
    debut = time.time()
    with open(JOURNAL, 'w') as jrn:
        jrn.write('total %d\n' % total)
        jrn.flush()
        for nom, chemin in cartes.items():
            liste = cellules(chemin)
            if not liste:
                continue
            x0 = min(c[0] for c in liste)
            y0 = min(c[1] for c in liste)
            x1 = max(c[0] for c in liste)
            y1 = max(c[1] for c in liste)
            larg = (x1 - x0 + 1) * PX_CELL
            haut = (y1 - y0 + 1) * PX_CELL
            image = Image.new('L', (larg, haut), 0)
            travail = [(chemin, cx, cy) for cx, cy in liste]
            with multiprocessing.Pool(8) as pool:
                for cx, cy, bloc in pool.imap_unordered(traiter_cellule,
                                                        travail, chunksize=4):
                    vignette = Image.frombytes('L', (PX_CELL, PX_CELL), bloc)
                    image.paste(vignette,
                                ((cx - x0) * PX_CELL, (cy - y0) * PX_CELL))
                    faits += 1
                    jrn.write('%s %d %d\n' % (nom, cx, cy))
                    jrn.flush()
            fichier = '%s.png' % nom
            image.save(os.path.join(SORTIE, fichier), optimize=True)
            index['cartes'][nom] = {
                'fichier': fichier,
                'x0': x0 * CELL, 'y0': y0 * CELL,
                'largeur': larg, 'hauteur': haut,
            }
            taille = os.path.getsize(os.path.join(SORTIE, fichier))
            ligne = ('CARTE %s %dx%d px, %d cellules, %.1f Mo'
                     % (nom, larg, haut, len(liste), taille / 1e6))
            print(ligne)
            jrn.write(ligne + '\n')
            jrn.flush()
        with open(os.path.join(SORTIE, 'index.json'), 'w') as f:
            json.dump(index, f, separators=(',', ':'))
        jrn.write('FINI %d cellules en %.0f s\n' % (faits, time.time() - debut))
    print('fini : %d cellules en %.0f s' % (faits, time.time() - debut))
    return 0


if __name__ == '__main__':
    sys.exit(main())
