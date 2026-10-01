#!/usr/bin/env python3
"""Extrait les marqueurs de loot des noms de pieces, pour TOUTES les cartes.

L'extraction d'origine est anterieure a l'ajout de cinq cartes moddees : Raven
Creek, New Hartburg, Constown, Chestown et LQZ n'avaient aucune pastille, dont
Raven Creek et ses 116 cellules, la plus grande ville moddee du serveur.

CONVENTION, relevee sur les marqueurs existants
    Une piece peut etre faite de plusieurs rectangles. Le marqueur est pose au
    centre du PLUS GRAND, et la description reprend ses dimensions :
        "gunstore · 10x5 · vanilla"

Les marqueurs ecrits a la main (or, billets, Slugger), reconnaissables a leur
description qui ne suit pas ce format, sont conserves tels quels.
"""
import json
import os
import re
import sys

RACINE = os.path.dirname(os.path.abspath(__file__))
PROJET = os.path.normpath(os.path.join(RACINE, '..', '..'))
CONF = os.path.join(PROJET, 'pzmap2dzi', 'conf')
SORTIE = os.path.join(PROJET, 'out', 'html', 'markers.json')

sys.path.insert(0, os.path.join(PROJET, 'pzmap2dzi'))

# Nom de piece -> (categorie, libelle francais). Reconstitue depuis les
# marqueurs d'origine : 36 noms couvrant 1822 des 1860 entrees.
PIECES = {
    'armystorage':     ('armes',   'Dépôt militaire'),
    'armytent':        ('armes',   'Tente militaire'),
    'bank':            ('valeur',  'Banque'),
    'bankstorage':     ('valeur',  'Réserve de banque'),
    'clinic':          ('medical', 'Clinique'),
    'cornerstore':     ('bouffe',  'Supérette'),
    'druglab':         ('valeur',  'Labo de drogue'),
    'drugshack':       ('valeur',  'Planque de drogue'),
    'firestorage':     ('armes',   'Réserve de caserne'),
    'gardenstore':     ('outils',  'Jardinerie'),
    'gas2go':          ('essence', 'Gas2Go'),
    'gasstorage':      ('essence', 'Réserve de station'),
    'gasstore':        ('essence', 'Station-service'),
    'grocery':         ('bouffe',  'Épicerie'),
    'grocerystorage':  ('bouffe',  "Réserve d'épicerie"),
    'gunstore':        ('armes',   'Armurerie'),
    'gunstorestorage': ('armes',   "Réserve d'armurerie"),
    'hospitalstorage': ('medical', "Réserve d'hôpital"),
    'jewelrystorage':  ('valeur',  'Réserve de bijouterie'),
    'jewelrystore':    ('valeur',  'Bijouterie'),
    'laboratory':      ('labo',    'Laboratoire'),
    'liquorstore':     ('bouffe',  "Magasin d'alcool"),
    'mechanic':        ('outils',  'Garage mécanique'),
    'medclinic':       ('medical', 'Clinique'),
    'medicaloffice':   ('medical', 'Cabinet médical'),
    'medicalstorage':  ('medical', 'Réserve médicale'),
    'pawnshop':        ('valeur',  'Prêteur sur gages'),
    'pawnshopoffice':  ('armes',   'Bureau de prêteur sur gages'),
    'pawnshopstorage': ('valeur',  'Réserve de prêteur'),
    'pharmacy':        ('medical', 'Pharmacie'),
    'pharmacystorage': ('medical', 'Réserve de pharmacie'),
    'policelocker':    ('armes',   'Vestiaire de police'),
    'policestorage':   ('armes',   'Réserve de police'),
    'producestorage':  ('bouffe',  'Réserve de primeurs'),
    'toolstore':       ('outils',  'Quincaillerie'),
    'warehouse':       ('outils',  'Entrepôt'),
}

# Libelle court affiche dans la description, par carte.
LIBELLES = {
    'default': 'vanilla', 'Trelai_B42': 'Trelai', 'Greenport_B42': 'Greenport',
    'Maplewood_B42': 'Maplewood', 'RavenCreek_B42': 'Raven Creek',
    'Constown_B42': 'Constown', 'NewHartburg_B42': 'New Hartburg',
    'Chestown_B42': 'Chestown', 'LQZ_B42': 'LQZ',
}

# Pieces qui contiennent VRAIMENT de l'or ou des billets, relevees dans les
# tables de loot du jeu et non a la main. Lecture faite avec lupa sur
# media/lua/server/Items/{Distributions,ProceduralDistributions}.lua : chaque
# piece y associe ses meubles a des tables procedurales, et chaque table liste
# ses objets avec un poids. Le score en commentaire est la somme des poids des
# objets vises, multipliee par le nombre de tirages de la table.
#
# Une piece d'ici recoit DEUX pastilles : sa categorie normale (valeur, armes)
# et la categorie rare. C'est deja le cas des 37 marqueurs ecrits a la main.
#
# Volontairement exclues, trop nombreuses pour le gain :
#   prisoncells    708 pieces, billets 124   (cellule au hasard)
#   policestorage  108 pieces, billets  70   (PoliceEvidence, chance 10 %)
#   bedroom / all  toutes les maisons        (caches sous le plancher)
PIECES_RARES = {
    # or
    'jewelrystorage':      ('or', 656),   # JewelryStorageAll + JewelerTools
    'pawnshopoffice':      ('or', 656),   # JewelryStorageAll
    'jewelrystore':        ('or', 456),   # JewelryGold en vitrine, chance 100
    'pawnshop':            ('or', 456),   # idem
    'departmentstore':     ('or', 456),   # comptoir bijoux
    'vault':               ('or', None),  # salles des coffres, verifiees une a une
    # billets
    # bankstorage a ete retire le 28/09 : aucune table ne le decrit, ni dans
    # le jeu ni dans les mods installes. BankDeposit n'est tire que par le
    # coffre-fort 'Safe' du CommunityTilePack, a 10 %, ou qu'il soit pose.
    # Sur les 12 bankstorage des cartes, 9 n'ont aucun meuble et 3 n'ont que
    # des classeurs, qui tombent sur la table generique, sans billets.
    'druglab':         ('billets', 720),   # DrugLabMoney, MoneyBundle poids 100
    'stripclub':       ('billets', 696),   # StripClubDressers
    'stripclubvip':    ('billets', 696),   # idem
    'nolansoffice':    ('billets', 300),   # NolansDesk
    'cardealershipoffice': ('billets', 136),
    'changeroomjockey':    ('billets', 124),
    'walletshop':      ('billets', None),  # voir ci-dessous
}

# walletshop n'a pas de score au sens ci-dessus parce que son argent n'est pas
# dans la table du meuble : CrateWallets donne des portefeuilles, et chaque
# portefeuille est lui-meme un conteneur dont la table est pleine de billets.
# En suivant les conteneurs, c'est 68 % par tirage, plus que le labo de drogue
# et plus que le strip-club. C'est la piece a billets la plus rentable du jeu
# et elle n'avait aucune pastille.
#
# Pas retenues au meme titre : bandlivingroom, musicschool et BandPractice ont
# bien de l'or, mais a 3,8 %, alors que la moins bonne piece deja marquee en
# 'or' est a 16,9 %.

# Titre francais des pieces rares qui n'ont pas de categorie normale.
LIBELLES_RARES = {
    'vault':               'Salle des coffres',
    'departmentstore':     'Grand magasin',
    'walletshop':          'Maroquinerie',
    'stripclub':           'Club de striptease',
    'stripclubvip':        'Club de striptease, carre VIP',
    'nolansoffice':        'Bureau de Nolan',
    'cardealershipoffice': 'Bureau de concessionnaire',
    'changeroomjockey':    'Vestiaire des jockeys',
}

# Palettes de lingots. Ce ne sont pas des conteneurs mais des objets de decor :
# l'entite Base.GoldPallet (scripts/generated/entities/misc/entity_goldpallet.txt)
# est accrochee au sprite location_military_knox_01_1, et son menu contextuel
# appelle ContextMenuCode.TakeGoldBars, qui donne 30 Base.GoldBar puis remplace
# le sprite par location_military_knox_01_0.
#
# Consequence : ca NE respawn PAS. Le repop de loot ne remplit que des
# conteneurs. Une palette videe l'est pour de bon, donc le marqueur vaut une
# fois. Les palettes deja vides d'origine (sprite _0) ne sont pas marquees.
SPRITE_PALETTE_PLEINE = 'location_military_knox_01_1'

# Loot exceptionnel : une piece qui n'existe qu'une poignee de fois sur les
# neuf cartes ET qui contient du materiel qu'on ne trouve pas ailleurs. Les
# deux conditions comptent : armystorage a de meilleures armes que la plupart
# d'ici, mais il y en a 160, ce n'est pas un voyage.
#
# Le chiffre entre parenthetes est le nombre de pieces sur les neuf cartes. Le
# pourcentage est la chance par tirage de meuble, calculee comme dans
# extraire-loot.py.
PIECES_TOP = {
    'policeswat':           'Depot SWAT',            # 1  armes, munitions, viseur
    'swatlocker':           'Vestiaire SWAT',        # 1  armure et sac SWAT
    'garage_ranger':        'Garage des rangers',    # 1  revolver, carabine, fusil 25 %
    'outdoorsupply':        'Magasin de plein air',  # 1  fusils de chasse
    'judgematthassset':     'Bureau du juge Hass',   # 1  Revolver_Long 56 %
    'blacksmith':           'Forge',                 # 1  moules et outils de forgeron
    'SurvivorCache2':       'Cache de survivant',    # 1  armes assorties
    'captainoffice':        'Bureau du capitaine',   # 2  armes, coffre, insigne
    'mayorwestpointoffice': 'Bureau du maire',       # 2  coffre du maire
    'oldarmy':              'Bunker militaire',      # 5
    'prisonstorage':        "Reserve d'armes de prison",  # 6
}

# Reconnait une description produite par l'extraction, par opposition aux
# marqueurs ecrits a la main qu'on conserve tels quels. Le motif ne prenait
# que les minuscules : SurvivorCache2 et garage_ranger etaient donc classes
# "ecrits a la main", figes dans le fichier et jamais regeneres.
# Chaque piece candidate est VERIFIEE avant d'avoir sa pastille (voir
# verification.py) :
#   - toute categorie : au moins un meuble de rangement dont le type a une
#     table, dans la piece ou dans 'all' ;
#   - 'billets' et 'or' : en vidant la piece une fois, on doit s'attendre a
#     trouver au moins SEUIL_ESPERANCE objet de ce genre, d'apres les meubles
#     REELLEMENT presents (verification.Verificateur.esperance).
# Un nom de piece n'est donc plus qu'un candidat, et c'est le contenu verifie
# qui decide de 'billets', de 'or', des deux ou d'aucun. Avant le 28/09 le nom
# suffisait, et 'billets' promettait de l'argent dans 45 pieces sans meuble.
#
# Pourquoi une esperance et pas une part par tirage : la salle des coffres de
# Trelai n'a que 0,35 % de lingots par tirage, mais 25 coffres a 50 tirages.
# Le seuil par tirage (2 %) l'ecartait, alors qu'on y attend ~600 billets et
# ~2 lingots, le plus gros gisement du jeu.
SEUIL_ESPERANCE = 1.0

# Depuis le 28/09 (bis), la regle vaut pour TOUTES les categories : armes,
# medical, outils, bouffe, labo doivent aussi contenir ce qu'elles promettent
# (definitions dans verification.CLASSES). Sauf l'essence : aucune des 138
# pieces de station-service ne donne un seul bidon, leur valeur est la pompe
# devant. Une station est gardee si une pompe (propriete fuelAmount) est a
# moins de RAYON_POMPE cases. Mesure : 97 stations sur 138 en ont une a moins
# de 30 cases, puis quasiment rien entre 30 et 90.
RAYON_POMPE = 30

# Categorie 'metal' : ou trouver des plaques en metal en quantite.
# Les pieces candidates ne sont PAS listees a la main : ce sont celles dont
# un meuble peut tirer une table contenant ces objets (calcule au demarrage
# depuis les tables du jeu et des mods). Chaque piece est ensuite verifiee
# sur ses meubles reels, comme les autres categories.
# On compte en equivalent plaques : une petite plaque vaut 1/4, puisqu'une
# plaque se scie en 4 petites (recette SawSteelSheetIntoSmallSheets).
# Seuil mesure : 5 equivalents donnent 91 pieces (48 entrepots, 16
# metalleries, 6 expeditions de metal, 4 ateliers de soudure...) ; 2 en
# donnaient 150, dont des dizaines de quincailleries a 2 plaques.
OBJETS_METAL = ('SheetMetal', 'SmallSheetMetal')
SEUIL_METAL = 5.0
LIBELLES_METAL = {
    'metalshipping':    'Expédition de métal',
    'metalshop':        'Métallerie',
    'metalfabrication': 'Fabrication métallique',
    'weldingworkshop':  'Atelier de soudure',
    'weldingstorage':   'Réserve de soudure',
    'garagestorage':    'Réserve de garage',
    'toolstorestorage': 'Réserve de quincaillerie',
    'shed':             'Abri',
    'storage':          'Réserve',
    'studio':           'Atelier',
    'all':              'Réserve sans nom',
}

FORMAT_EXTRAIT = re.compile(r'^[A-Za-z0-9_]+ · \d+x\d+ · ')


def charger_conf():
    """Resout le chemin de chaque carte depuis les fichiers de pzmap2dzi."""
    from pzmap2dzi.i18n_util import load_yaml
    conf = load_yaml(os.path.join(CONF, 'conf-iso.yaml'))
    cartes = {}
    vanilla = load_yaml(os.path.join(CONF, 'vanilla.txt'))
    cartes['default'] = vanilla['default']['map_path'].format(**conf)
    mods = load_yaml(os.path.join(CONF, 'mod', 'pztogether.txt'))
    for nom, m in mods.items():
        cartes[nom] = m['map_path'].format(**dict(conf, **m))
    return cartes


def extraire(nom_carte, chemin, libelle, verif, bilan):
    from pzmap2dzi import lotheader
    marqueurs = []
    if not os.path.isdir(chemin):
        return marqueurs, 0
    cellules = 0
    for f in sorted(os.listdir(chemin)):
        if not f.endswith('.lotheader'):
            continue
        try:
            cx, cy = (int(v) for v in f[:-10].split('_'))
        except ValueError:
            continue
        try:
            h = lotheader.load_lotheader(chemin, cx, cy)
        except Exception:
            continue
        if not h:
            continue
        cellules += 1
        noms_tuiles = set(h.get('tiles') or [])
        for r in (h.get('rooms') or []):
            nom = r['name']
            if isinstance(nom, bytes):
                nom = nom.decode('utf8', 'replace')
            info = PIECES.get(nom)
            rare = PIECES_RARES.get(nom)
            sommet = PIECES_TOP.get(nom)
            metal = nom in verif.pieces_metal
            if not info and not rare and not sommet and not metal:
                continue
            rects = r.get('rects') or []
            if not rects:
                continue

            types = verif.types_meubles(nom_carte, cx, cy, r)
            if not verif.a_du_loot(nom, types):
                bilan['sans meuble a loot'] += (1 if info else 0) + (1 if rare else 0) + (1 if sommet else 0)
                continue

            if metal:
                e = verif.esperance_objets(nom, types, OBJETS_METAL)
                equiv = e['SheetMetal'] + e['SmallSheetMetal'] / 4
                if equiv >= SEUIL_METAL:
                    xm, ym, wm, hm = max(rects, key=lambda t: t[2] * t[3])
                    titre = LIBELLES_METAL.get(nom) or (info[1] if info else nom)
                    marqueurs.append({
                        'x': cx * 256 + xm + wm // 2, 'y': cy * 256 + ym + hm // 2,
                        'z': r.get('layer', 0),
                        'd': '%s · %dx%d · %s' % (nom, wm, hm, libelle),
                        'cat': 'metal', 't': titre,
                        'n': round(e['SheetMetal'], 1),
                        'ps': round(e['SmallSheetMetal'], 1),
                    })
                    bilan['gardees'] += 1
                if not info and not rare and not sommet:
                    continue
            attendus = verif.esperance(nom, types)

            # Le plus grand rectangle porte le marqueur, comme a l'origine.
            x, y, w, ht = max(rects, key=lambda t: t[2] * t[3])
            base = {
                'x': cx * 256 + x + w // 2,
                'y': cy * 256 + y + ht // 2,
                'z': r.get('layer', 0),
                'd': '%s · %dx%d · %s' % (nom, w, ht, libelle),
            }
            if info:
                c = info[0]
                if c == 'essence':
                    d = verif.pompe_proche(nom_carte, cx, cy, r, RAYON_POMPE)
                    if d is None:
                        bilan['essence sans pompe a %d cases' % RAYON_POMPE] += 1
                    else:
                        marqueurs.append(dict(base, cat=c, t=info[1], pompe=d))
                        bilan['gardees'] += 1
                elif attendus[c] < SEUIL_ESPERANCE:
                    # Exemple : les 21 pieces 'bank' n'ont rien de precieux,
                    # le jeu n'a pas de table pour elles et leurs meubles
                    # tombent sur la table generique, du materiel de bureau.
                    bilan['%s : rien de la categorie' % c] += 1
                else:
                    marqueurs.append(dict(base, cat=c, t=info[1], n=round(attendus[c], 1)))
                    bilan['gardees'] += 1
            if rare:
                titre = info[1] if info else LIBELLES_RARES[nom]
                poses = 0
                for cat in ('billets', 'or'):
                    if attendus[cat] >= SEUIL_ESPERANCE:
                        # 'n' : combien on en attend en vidant la piece, pour
                        # l'infobulle. Estimation, pas une promesse.
                        marqueurs.append(dict(base, cat=cat, t=titre,
                                              n=round(attendus[cat], 1)))
                        bilan['gardees'] += 1
                        poses += 1
                if not poses:
                    bilan['meubles sans billets ni or'] += 1
            if sommet:
                marqueurs.append(dict(base, cat='top', t=sommet))
                bilan['gardees'] += 1

        # Palettes de lingots : objet de decor, pas une piece.
        #
        # On saute les cellules sans aucune piece. Le jeu en a une, 58_1 dans
        # la vanilla, qui etale des jeux de tuiles entiers en lignes pour les
        # regarder : 26 sprites knox a la suite en y=444, un tous les deux x,
        # dont une palette pleine en x=15005. Ce n'est pas un lieu. Les onze
        # autres cellules a palettes ont entre 123 et 3372 pieces, la
        # separation est nette.
        if SPRITE_PALETTE_PLEINE in noms_tuiles and (h.get('rooms') or []):
            marqueurs.extend(palettes(chemin, cx, cy, libelle))

    verif.oublier(nom_carte)
    return marqueurs, cellules


def palettes(chemin, cx, cy, libelle):
    """Positions des palettes de lingots pleines d'une cellule.

    On ne charge le .lotpack que si le .lotheader annonce le sprite : c'est le
    cas de 10 cellules sur 4278, le reste du scan ne paye rien.
    """
    from pzmap2dzi import cell
    try:
        c = cell.load_cell(chemin, cx, cy)
    except Exception:
        return []
    if not c:
        return []
    trouves = []
    for sx in range(c.cell_size):
        for sy in range(c.cell_size):
            for z in range(c.minlayer, c.maxlayer):
                carre = c.get_square(sx, sy, z)
                if not carre:
                    continue
                for t in carre:
                    if t == SPRITE_PALETTE_PLEINE:
                        trouves.append({
                            'x': cx * 256 + sx,
                            'y': cy * 256 + sy,
                            'z': z,
                            'cat': 'or',
                            't': 'Palette de lingots',
                            'd': 'goldpallet · 1x1 · %s' % libelle,
                        })
                        break
    return trouves


# Corrections de categorie sur des marqueurs ecrits a la main.
#   La "Couronne de Trelai" tire dans la table Crown, qui donne Hat_Crown1 et
#   Hat_Crown2 : des chapeaux, sans or. C'est bien un objet unique, donc du
#   loot exceptionnel, pas de l'or.
CORRECTIONS_MANUELLES = {
    ('Couronne de Trelai', 'or'): 'top',
}


def corriger_manuel(k):
    cat = CORRECTIONS_MANUELLES.get((k.get('t'), k.get('cat')))
    return dict(k, cat=cat) if cat else k


def verifier_manuel(k, verif):
    """(garde ?, raison) pour un marqueur ecrit a la main."""
    trouve = verif.piece_a(k['x'], k['y'], k['z'], voulu=k.get('p'))
    if not trouve:
        return False, 'hors de toute piece'
    nom_carte, cx, cy, r, piece = trouve
    types = verif.types_meubles(nom_carte, cx, cy, r)
    if not verif.a_du_loot(piece, types):
        return False, 'piece %s sans meuble a loot' % piece
    if k['cat'] == 'essence':
        d = verif.pompe_proche(nom_carte, cx, cy, r, RAYON_POMPE)
        if d is None:
            return False, 'piece %s : pas de pompe a %d cases' % (piece, RAYON_POMPE)
        k['pompe'] = d
    elif k['cat'] != 'top':
        attendus = verif.esperance(piece, types)
        if attendus[k['cat']] < SEUIL_ESPERANCE:
            return False, 'piece %s : meubles %s, %.2f %s attendus' % (
                piece, ','.join(sorted(types)), attendus[k['cat']], k['cat'])
        k['n'] = round(attendus[k['cat']], 1)
    return True, ''


def main():
    anciens = []
    if os.path.isfile(SORTIE):
        with open(SORTIE, encoding='utf8') as f:
            anciens = json.load(f)
    # On ne garde que ce qui n'est PAS issu d'une extraction : or, billets,
    # Slugger, et tout ce qui a ete ajoute a la main.
    manuels = [k for k in anciens if not FORMAT_EXTRAIT.match(k.get('d') or '')]
    print('marqueurs existants : %d, dont %d ecrits a la main' % (len(anciens), len(manuels)))

    import collections
    import time
    from pzmap2dzi.i18n_util import load_yaml
    sys.path.insert(0, RACINE)
    import verification

    cartes = charger_conf()
    pz_root = load_yaml(os.path.join(CONF, 'conf-iso.yaml'))['pz_root']
    print('chargement des tables de loot et des tuiles de rangement...')
    verif = verification.Verificateur(cartes, pz_root)
    print('  mods : %s' % (', '.join(verif.mods) or 'aucun'))
    verif.pieces_metal = verif.pieces_pour(OBJETS_METAL)
    print('  pieces pouvant donner des plaques : %d' % len(verif.pieces_metal))

    # Marqueurs ecrits a la main : memes regles que les extraits. Un seul
    # changement de categorie, justifie ci-dessous.
    manuels = [corriger_manuel(k) for k in manuels]
    manuels_gardes, rejetes = [], []
    for k in manuels:
        ok, raison = verifier_manuel(k, verif)
        (manuels_gardes if ok else rejetes).append((k, raison))
    manuels = [k for k, _ in manuels_gardes]
    print('marqueurs ecrits a la main : %d gardes, %d retires'
          % (len(manuels), len(rejetes)))
    for k, raison in rejetes:
        print('   retire  %-8s %-34s %6d %6d  %s'
              % (k['cat'], k['t'][:34], k['x'], k['y'], raison))

    tous = []
    bilan = collections.Counter()
    print()
    debut = time.time()
    for nom, chemin in cartes.items():
        libelle = LIBELLES.get(nom, nom)
        m, cellules = extraire(nom, chemin, libelle, verif, bilan)
        tous.extend(m)
        etat = '' if cellules else '   CHEMIN INTROUVABLE'
        print('   %-18s %5d marqueurs   %4d cellules   %4.0f s%s'
              % (libelle, len(m), cellules, time.time() - debut, etat))
    print()
    print('pieces candidates ecartees apres verification :')
    for k, v in sorted(bilan.items()):
        if k != 'gardees':
            print('   %-28s %d' % (k, v))

    # Les marqueurs ecrits a la main n'ont pas de nom de piece dans leur
    # description, donc l'infobulle ne trouvait pas leur table de loot : le
    # labo de drogue en 11617,9294 n'affichait rien alors que le meme endroit
    # est aussi extrait comme 'druglab'. On leur recopie le nom de piece du
    # marqueur extrait qui tombe exactement sur la meme case.
    piece_par_case = {}
    for k in tous:
        m = FORMAT_EXTRAIT.match(k.get('d') or '')
        if m:
            piece_par_case.setdefault((k['x'], k['y'], k['z']),
                                      (k['d'] or '').split(' · ')[0])
    enrichis = 0
    for k in manuels:
        nom = piece_par_case.get((k['x'], k['y'], k['z']))
        if nom:
            k['p'] = nom
            enrichis += 1
    print('marqueurs manuels raccordes a une table de loot : %d / %d'
          % (enrichis, len(manuels)))

    # Deduplication : deux cartes peuvent se recouvrir.
    vus = set()
    fusion = []
    for k in manuels + tous:
        cle = (k['x'], k['y'], k['z'], k['cat'])
        if cle in vus:
            continue
        vus.add(cle)
        fusion.append(k)
    fusion.sort(key=lambda k: (k['y'], k['x'], k['z']))

    with open(SORTIE, 'w', encoding='utf8') as f:
        json.dump(fusion, f, ensure_ascii=False, separators=(',', ':'))
    print('\ntotal : %d marqueurs (%+d)' % (len(fusion), len(fusion) - len(anciens)))
    print('ecrit : %s (%.0f Ko)' % (SORTIE, os.path.getsize(SORTIE) / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
