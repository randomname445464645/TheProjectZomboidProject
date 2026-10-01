#!/usr/bin/env python3
"""Verifie chaque pastille contre la carte ET contre les tables de loot.

Ecrit apres un faux positif signale en jeu : la "Reserve de banque" de
Maplewood (bankstorage, 8248,8590) n'a aucun meuble. C'est un palier
d'escalator que le cartographe a nomme bankstorage. Rien ne peut y apparaitre.

Pour chaque pastille, trois questions, dans l'ordre :

  1. La pastille tombe-t-elle dans une piece de la carte ?
  2. Cette piece contient-elle au moins un meuble de rangement ? On lit les
     tuiles posees sur ses cases dans le .lotpack, et on reconnait les
     meubles par la propriete "container" des definitions de tuiles du jeu
     et des mods (tuiles_conteneurs.py).
  3. Les meubles presents tirent-ils dans une table qui contient ce que la
     categorie promet ? Pour 'billets' et 'or', on suit aussi les conteneurs
     (mallette, sac de billets, portefeuille), comme dans extraire-loot.py.

TABLES
    Celles du jeu, plus celles des mods installes, chargees comme le jeu les
    charge : les fichiers Lua des mods ajoutent leurs tables procedurales
    dans des fonctions branchees sur Events.OnPreDistributionMerge, et leurs
    pieces par table.insert(Distributions, ...). On execute les deux.

    Une piece absente des tables utilise l'entree 'all' pour chaque type de
    meuble. C'est ce que fait le jeu, et c'est le cas de bankstorage.
"""
import collections
import json
import os
import sys

RACINE = os.path.dirname(os.path.abspath(__file__))
PROJET = os.path.normpath(os.path.join(RACINE, '..', '..'))
MARQUEURS = os.path.join(PROJET, 'out', 'html', 'markers.json')
sys.path.insert(0, os.path.join(PROJET, 'pzmap2dzi'))
sys.path.insert(0, RACINE)

SEUIL_ESPERANCE = 1.0   # memes regles que extraire-marqueurs.py
RAYON_POMPE = 30


# ---------------------------------------------------------------------------

def main():
    """Audite out/html/markers.json. Aucune ecriture, sauf le rapport demande
    par la variable RAPPORT."""
    import importlib.util
    import verification
    from pzmap2dzi.i18n_util import load_yaml

    spec = importlib.util.spec_from_file_location(
        'ex', os.path.join(RACINE, 'extraire-marqueurs.py'))
    ex = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ex)
    cartes = ex.charger_conf()
    pz_root = load_yaml(os.path.join(PROJET, 'pzmap2dzi', 'conf', 'conf-iso.yaml'))['pz_root']
    verif = verification.Verificateur(cartes, pz_root)
    par_libelle = {v: k for k, v in ex.LIBELLES.items()}

    marqueurs = json.load(open(MARQUEURS, encoding='utf8'))
    rapport = []
    for i, m in enumerate(marqueurs):
        d = m.get('d') or ''
        morceaux = d.split(' · ')
        if d.startswith('goldpallet'):
            rapport.append((i, 'ok', 'palette, sprite verifie a part', {}))
            continue
        voulu = morceaux[0] if len(morceaux) == 3 else m.get('p')
        ordre = None
        if len(morceaux) == 3 and morceaux[2] in par_libelle:
            ordre = [par_libelle[morceaux[2]]] + [n for n in cartes if n != par_libelle[morceaux[2]]]
        trouve = verif.piece_a(m['x'], m['y'], m['z'], voulu=voulu, cartes=ordre)
        if not trouve:
            rapport.append((i, 'hors-piece', 'aucune piece a cet endroit', {}))
            continue
        nom, cx, cy, r, piece = trouve
        types = verif.types_meubles(nom, cx, cy, r)
        info = {'carte': nom, 'piece': piece, 'meubles': dict(types)}
        if not verif.a_du_loot(piece, types):
            rapport.append((i, 'vide', 'aucun meuble a loot', info))
            continue
        e = verif.esperance(piece, types)
        info.update({'attendus': {k: round(v, 2) for k, v in e.items()}})
        if m['cat'] == 'metal':
            o = verif.esperance_objets(piece, types, ('SheetMetal', 'SmallSheetMetal'))
            equiv = o['SheetMetal'] + o['SmallSheetMetal'] / 4
            info['plaques'] = round(equiv, 1)
            rapport.append((i, 'ok' if equiv >= 5.0 else 'sans-contenu',
                            '' if equiv >= 5.0 else 'moins de 5 plaques', info))
        elif m['cat'] == 'essence':
            if verif.pompe_proche(nom, cx, cy, r, RAYON_POMPE) is None:
                rapport.append((i, 'sans-contenu', 'pas de pompe', info))
            else:
                rapport.append((i, 'ok', '', info))
        elif m['cat'] in e and e[m['cat']] < SEUIL_ESPERANCE:
            rapport.append((i, 'sans-contenu', 'rien de la categorie', info))
        elif False:
            rapport.append((i, 'sans-contenu', "pas d'or", info))
        else:
            rapport.append((i, 'ok', '', info))

    par_cat = collections.defaultdict(collections.Counter)
    for i, verdict, _, _ in rapport:
        par_cat[marqueurs[i]['cat']][verdict] += 1
    print('%-9s %6s %6s %6s %8s %8s' % ('categorie', 'total', 'ok', 'vide', 'sans', 'hors'))
    for cat in ['top', 'or', 'billets', 'valeur', 'metal', 'armes', 'medical', 'outils',
                'bouffe', 'essence', 'labo']:
        c = par_cat.get(cat, {})
        print('%-9s %6d %6d %6d %8d %8d' % (cat, sum(c.values()), c.get('ok', 0),
              c.get('vide', 0), c.get('sans-contenu', 0), c.get('hors-piece', 0)))
    echecs = sum(1 for _, v, _, _ in rapport if v != 'ok')
    print('\n%d pastilles, %d en echec' % (len(rapport), echecs))

    sortie = os.environ.get('RAPPORT')
    if sortie:
        with open(sortie, 'w', encoding='utf8') as f:
            json.dump([{'i': i, 'verdict': v, 'raison': r, **marqueurs[i], **info}
                       for i, v, r, info in rapport], f, ensure_ascii=False, indent=1)
        print('detail : %s' % sortie)
    return 1 if echecs else 0


if __name__ == '__main__':
    sys.exit(main())
