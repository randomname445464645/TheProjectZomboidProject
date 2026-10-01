#!/usr/bin/env python3
"""Ou trouver un objet sur les cartes du serveur, piece par piece.

    .venv/bin/python outils/marqueurs/ou-trouver.py SheetMetal SmallSheetMetal

Pour chaque piece des neuf cartes dont les tables peuvent donner l'objet, on
lit les meubles reellement poses et on calcule combien on en attend en vidant
la piece une fois, avec la regle exacte du jeu (verification.py : une table
par meuble au prorata des poids, forceFor*, plafonds min/max par piece).
Affiche les pieces les plus riches avec la rue la plus proche.
"""
import collections
import glob
import importlib.util
import json
import math
import os
import sys

RACINE = os.path.dirname(os.path.abspath(__file__))
PROJET = os.path.normpath(os.path.join(RACINE, '..', '..'))
sys.path.insert(0, os.path.join(PROJET, 'pzmap2dzi'))
sys.path.insert(0, RACINE)


def main(cibles, n_top=12):
    import verification
    from pzmap2dzi.i18n_util import load_yaml
    spec = importlib.util.spec_from_file_location('ex', os.path.join(RACINE, 'extraire-marqueurs.py'))
    ex = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ex)
    cartes = ex.charger_conf()
    v = verification.Verificateur(
        cartes, load_yaml(os.path.join(PROJET, 'pzmap2dzi', 'conf', 'conf-iso.yaml'))['pz_root'])

    # Pieces dont au moins un meuble peut tirer une table contenant l'objet.
    tables = {n for n, t in v.tables.proc.items()
              if isinstance(t, dict) and set(verification.objets(t)) & set(cibles)}
    pieces = set()
    for p, m in v.tables.dist.items():
        if isinstance(m, dict) and 'items' not in m:
            for s in m.values():
                if isinstance(s, dict) and any(e.get('name') in tables for e in (s.get('procList') or [])):
                    pieces.add(p)
    generique = 'all' in pieces          # alors n'importe quelle piece peut en donner
    print('tables : %s' % ', '.join(sorted(tables)))
    print('pieces qui les citent : %s%s' % (', '.join(sorted(pieces - {'all'})),
          " (et 'all' : tout meuble generique)" if generique else ''))

    res = []
    for nom, chemin in cartes.items():
        for f in sorted(os.listdir(chemin)):
            if not f.endswith('.lotheader'):
                continue
            try:
                cx, cy = (int(a) for a in f[:-10].split('_'))
            except ValueError:
                continue
            for r in (v.entete(nom, cx, cy).get('rooms') or []):
                n = r['name'].decode('utf8', 'replace') if isinstance(r['name'], bytes) else r['name']
                if n not in pieces or not r.get('rects'):
                    continue
                types = v.types_meubles(nom, cx, cy, r)
                e = v.esperance_objets(n, types, cibles)
                if sum(e.values()) < 0.05:
                    continue
                x, y, w, hh = max(r['rects'], key=lambda q: q[2] * q[3])
                res.append({'carte': ex.LIBELLES.get(nom, nom), 'piece': n,
                            'x': cx * 256 + x + w // 2, 'y': cy * 256 + y + hh // 2,
                            'z': r.get('layer', 0), 'attendu': e})
        v.oublier(nom)

    rues = []
    for f in glob.glob(os.path.join(PROJET, 'out', 'html', 'map_data', '**', 'streets', 'marks.json'), recursive=True):
        for r in json.load(open(f)):
            if r.get('name'):
                rues += [(q['x'], q['y'], r['name']) for q in r['points']]

    def rue(x, y):
        if not rues:
            return ''
        b = min(rues, key=lambda q: (q[0] - x) ** 2 + (q[1] - y) ** 2)
        d = math.hypot(b[0] - x, b[1] - y)
        return '%s (%d cases)' % (b[2], d) if d < 150 else ''

    for c in cibles:
        par = collections.defaultdict(list)
        for r in res:
            if r['attendu'][c] > 0.05:
                par[r['piece']].append(r['attendu'][c])
        print('\n== %s : par type de piece' % c)
        print('   %-20s %5s %8s %8s %8s' % ('piece', 'nb', 'total', 'moyenne', 'max'))
        for p, l in sorted(par.items(), key=lambda kv: -max(kv[1]))[:12]:
            print('   %-20s %5d %8.0f %8.1f %8.1f' % (p, len(l), sum(l), sum(l) / len(l), max(l)))
        print('== %s : les %d meilleures pieces' % (c, n_top))
        for r in sorted(res, key=lambda r: -r['attendu'][c])[:n_top]:
            print('   %6.1f  %-18s %-11s x %5d y %5d z%d  %s' % (
                r['attendu'][c], r['piece'], r['carte'], r['x'], r['y'], r['z'], rue(r['x'], r['y'])))
    return res


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1:])
