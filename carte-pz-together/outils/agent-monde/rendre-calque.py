#!/usr/bin/env python3
"""Pre-calcule le calque des constructions en pyramide de tuiles.

POURQUOI
    Dessiner les sprites dans le navigateur ne tient plus : un releve de
    1,5 million de cases demande des centaines de milliers d'appels de dessin,
    et tout est a refaire au moindre deplacement comme a chaque rechargement.

    On produit donc des TUILES, exactement comme la carte de base. Le viewer
    n'a plus qu'a les afficher : instantane, mis en cache par le navigateur,
    insensible aux deplacements.

GEOMETRIE
    La pyramide reprend l'origine, la taille et la taille de tuile de la carte
    isometrique de base. Les indices de tuiles coincident donc exactement avec
    les siens, ce qui supprime toute question d'alignement.

REGLE DE DESSIN (render_impl/base.py et pzdzi.IsoDZI)
    bas_centre_x = (x - y) * 64
    bas_centre_y = (x + y + 2) * 32 - 192 * z
    sprite pose en (bas_centre + ox, bas_centre + oy)
"""
import json
import math
import os
import sys
import time
from multiprocessing import Pool

from PIL import Image

RACINE = os.path.dirname(os.path.abspath(__file__))
HTML = os.path.normpath(os.path.join(RACINE, '..', '..', 'out', 'html'))
TEXTURES = '/mnt/data/pz-render/out-iso/texture'
SORTIE = os.path.join(HTML, 'map_data', 'constructions')

GW, GH, LH = 64, 32, 192          # GRID_WIDTH, GRID_HEIGHT, LAYER_HEIGHT

# Repli si une case n'a aucun sprite connu : debordement maximal plausible
# autour du bas-centre (les arbres jumbo montent a plus de 1000 px).
MARGE_G, MARGE_D, MARGE_H, MARGE_B = 512, 512, 1088, 128

_ctx = {}


def init(noms, metas, cases, px0, py0, tuile, base_niveau):
    _ctx.update(noms=noms, metas=metas, cases=cases, px0=px0, py0=py0,
                tuile=tuile, base_niveau=base_niveau, sprites={})


def sprite(nom):
    s = _ctx['sprites']
    if nom in s:
        return s[nom]
    m = _ctx['metas'].get(nom)
    im = None
    if m:
        chemin = os.path.join(TEXTURES, m[0], nom + '.png')
        try:
            im = Image.open(chemin).convert('RGBA')
        except Exception:
            im = None
    s[nom] = im
    return im


def rendre_tuile(travail):
    """Dessine une tuile de plein niveau. Retourne (tx, ty, octets) ou None."""
    tx, ty, indices = travail
    T = _ctx['tuile']
    im = Image.new('RGBA', (T, T))
    ox, oy = tx * T, ty * T
    noms, metas, cases = _ctx['noms'], _ctx['metas'], _ctx['cases']
    pose = 0
    for i in indices:
        c = cases[i]
        # px0/py0 : meme origine de plan que l'index et que le viewer.
        bx = (c[0] - c[1]) * GW + _ctx['px0'] - ox
        by = (c[0] + c[1] + 2) * GH - LH * c[2] + _ctx['py0'] - oy
        for r in c[3]:
            nom = noms[r]
            m = metas.get(nom)
            if not m:
                continue
            s = sprite(nom)
            if s is None:
                continue
            x, y = int(bx + m[3]), int(by + m[4])
            # alpha_composite refuse un collage qui depasse la cible : on
            # ecarte ce qui est entierement dehors et on recadre le reste.
            if x + m[1] <= 0 or y + m[2] <= 0 or x >= T or y >= T:
                continue
            if x < 0 or y < 0 or x + m[1] > T or y + m[2] > T:
                gx0, gy0 = max(0, x), max(0, y)
                sx0, sy0 = gx0 - x, gy0 - y
                sx1 = min(m[1], T - x)
                sy1 = min(m[2], T - y)
                if sx1 <= sx0 or sy1 <= sy0:
                    continue
                im.alpha_composite(s.crop((sx0, sy0, sx1, sy1)), (gx0, gy0))
            else:
                im.alpha_composite(s, (x, y))
            pose += 1
    if not pose or not im.getbbox():
        return None
    return (tx, ty, ecrire(im, _ctx['base_niveau'], tx, ty))


def ecrire(im, niveau, tx, ty):
    d = os.path.join(SORTIE, 'layer0_files', str(niveau))
    os.makedirs(d, exist_ok=True)
    chemin = os.path.join(d, '%d_%d.webp' % (tx, ty))
    im.save(chemin, 'WEBP', quality=88, method=4)
    return os.path.getsize(chemin)


def main():
    t_debut = time.time()
    with open(os.path.join(HTML, 'constructions.json'), encoding='utf8') as f:
        d = json.load(f)
    with open(os.path.join(HTML, 'constructions-sprites.json'), encoding='utf8') as f:
        metas = json.load(f)
    noms, cases = d['sprites'], d['cases']

    # Geometrie reprise de la carte isometrique de base.
    with open(os.path.join(HTML, 'map_data', 'base', 'map_info.json'), encoding='utf8') as f:
        base = json.load(f)
    # square2pixel (pzmap/map.js) : pixel = x0 + (X - Y) * sqr/2. L'origine a
    # AJOUTER est donc +x0, pas son oppose. Le viewer, lui, exprime l'origine
    # de la pyramide DANS le plan, d'ou son -x0 : ce sont deux points de vue
    # inverses de la meme relation.
    px0, py0 = base['x0'], base['y0']
    W, H = base['w'], base['h']
    with open(os.path.join(HTML, 'map_data', 'base', 'layer0.dzi'), encoding='utf8') as f:
        dzi = f.read()
    TUILE = int(dzi.split('TileSize="')[1].split('"')[0])
    NIVEAU_MAX = math.ceil(math.log2(max(W, H)))

    print('cases          : %d' % len(cases))
    print('geometrie      : %d x %d, tuiles de %d, niveau max %d' % (W, H, TUILE, NIVEAU_MAX))

    # Boite exacte de chaque sprite autour du bas-centre, pre-calculee une fois.
    # Une marge fixe serait a la fois trop large pour la plupart des sprites et
    # potentiellement trop courte pour les plus hauts.
    boites = {}
    for nom, m in metas.items():
        _, w, h, ox, oy = m
        boites[nom] = (ox, oy, ox + w, oy + h)

    # Index tuile -> cases, au niveau de pleine resolution.
    #
    # On parcourt TOUTE la plage de tuiles couverte par la boite, pas seulement
    # ses quatre coins : une boite plus haute qu'une tuile en couvre trois, et
    # n'indexer que les coins laissait celle du milieu sans contenu. Cela
    # produisait des bandes vides le long des diagonales de la grille iso, sur
    # 19 % des cases.
    t0 = time.time()
    index = {}
    sans_sprite = 0
    for i, c in enumerate(cases):
        bx = (c[0] - c[1]) * GW + px0
        by = (c[0] + c[1] + 2) * GH - LH * c[2] + py0
        g = h_ = 10**9
        d = b = -10**9
        for r in c[3]:
            bo = boites.get(noms[r])
            if not bo:
                continue
            g = min(g, bo[0]); h_ = min(h_, bo[1])
            d = max(d, bo[2]); b = max(b, bo[3])
        if d < g:
            sans_sprite += 1
            g, h_, d, b = -MARGE_G, -MARGE_H, MARGE_D, MARGE_B
        tx0 = (bx + g) // TUILE
        tx1 = (bx + d) // TUILE
        ty0 = (by + h_) // TUILE
        ty1 = (by + b) // TUILE
        for tx in range(tx0, tx1 + 1):
            for ty in range(ty0, ty1 + 1):
                index.setdefault((tx, ty), []).append(i)
    print('index          : %d tuiles occupees, %.1f s%s'
          % (len(index), time.time() - t0,
             '' if not sans_sprite else ' (%d cases sans sprite connu)' % sans_sprite))

    travaux = [(tx, ty, idx) for (tx, ty), idx in sorted(index.items())]
    n = len(travaux)
    existants = {NIVEAU_MAX: []}
    octets = 0
    faits = 0
    t0 = time.time()
    # px0/py0 passes aux ouvriers : ils raisonnent en coordonnees de pyramide.
    with Pool(8, initializer=init,
              initargs=(noms, metas, cases, px0, py0, TUILE, NIVEAU_MAX)) as p:
        for r in p.imap_unordered(rendre_tuile, travaux, chunksize=8):
            faits += 1
            if r:
                existants[NIVEAU_MAX].append([r[0], r[1]])
                octets += r[2]
            if faits % 200 == 0 or faits == n:
                reste = (time.time() - t0) / faits * (n - faits)
                print('niveau %d : %d/%d  %.0f Mo  reste ~%.0f min'
                      % (NIVEAU_MAX, faits, n, octets / 1e6, reste / 60), flush=True)

    # Pyramide : chaque niveau superieur agrege quatre tuiles du niveau en
    # dessous. Bien moins cher que de tout redessiner a chaque echelle.
    niveau = NIVEAU_MAX
    while niveau > 0 and existants[niveau]:
        parents = {}
        for tx, ty in existants[niveau]:
            parents.setdefault((tx // 2, ty // 2), []).append((tx, ty))
        sup = niveau - 1
        existants[sup] = []
        dsup = os.path.join(SORTIE, 'layer0_files', str(sup))
        os.makedirs(dsup, exist_ok=True)
        for (ptx, pty), enfants in parents.items():
            im = Image.new('RGBA', (TUILE * 2, TUILE * 2))
            for tx, ty in enfants:
                c = Image.open(os.path.join(SORTIE, 'layer0_files', str(niveau),
                                            '%d_%d.webp' % (tx, ty)))
                im.alpha_composite(c.convert('RGBA'),
                                   ((tx - ptx * 2) * TUILE, (ty - pty * 2) * TUILE))
            im = im.resize((TUILE, TUILE), Image.LANCZOS)
            if not im.getbbox():
                continue
            chemin = os.path.join(dsup, '%d_%d.webp' % (ptx, pty))
            im.save(chemin, 'WEBP', quality=88, method=4)
            octets += os.path.getsize(chemin)
            existants[sup].append([ptx, pty])
        print('niveau %d : %d tuiles, %.0f Mo au total' % (sup, len(existants[sup]), octets / 1e6),
              flush=True)
        niveau = sup

    # Fiche lue par le viewer. La liste des tuiles existantes evite au
    # navigateur de demander des milliers de tuiles absentes.
    info = {
        'w': W, 'h': H, 'x0': base['x0'], 'y0': base['y0'], 'sqr': base['sqr'],
        'tuile': TUILE, 'niveau_max': NIVEAU_MAX, 'format': 'webp',
        'tuiles': {str(k): v for k, v in existants.items() if v},
        'cases': len(cases),
        'genere': time.strftime('%Y-%m-%d %H:%M:%S'),
    }
    with open(os.path.join(SORTIE, 'info.json'), 'w', encoding='utf8') as f:
        json.dump(info, f, separators=(',', ':'))

    print('\ntermine en %.0f min, %.0f Mo' % ((time.time() - t_debut) / 60, octets / 1e6))
    return 0


if __name__ == '__main__':
    sys.exit(main())
