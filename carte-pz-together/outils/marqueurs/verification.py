"""Verification d'une piece contre la carte et contre les tables de loot.

Partage par extraire-marqueurs.py, qui ne pose une pastille que sur une piece
verifiee, et par verifier-marqueurs.py, qui audite un markers.json existant.

Ecrit apres un faux positif signale en jeu : la "Reserve de banque" de
Maplewood (bankstorage, 8248,8590) n'a aucun meuble. C'est un palier
d'escalator que le cartographe a nomme bankstorage. La verification d'avant
ne regardait que les TABLES de loot, jamais les meubles reellement poses.

Une piece est verifiee en deux temps :
  1. ses meubles de rangement, lus case par case dans les .lotpack et
     reconnus par la propriete "container" des definitions de tuiles du jeu
     et des mods (tuiles_conteneurs.py). Une piece peut etre declaree dans une
     cellule et deborder sur la voisine : chaque case est lue dans SA cellule.
  2. ce que ces meubles peuvent contenir : la table du type de meuble dans la
     piece, ou a defaut celle de 'all', comme le fait le jeu. Pour l'argent et
     l'or on suit aussi les conteneurs (mallette, sac de billets, portefeuille).

Les tables sont celles du jeu plus celles des mods installes, chargees comme
le jeu les charge : les mods ajoutent leurs tables procedurales dans des
fonctions branchees sur Events.OnPreDistributionMerge, et leurs pieces par
table.insert(Distributions, ...). On execute les deux.
"""
import collections
import glob
import json
import os
import re
import sys

RACINE = os.path.dirname(os.path.abspath(__file__))
PROJET = os.path.normpath(os.path.join(RACINE, '..', '..'))
MARQUEURS = os.path.join(PROJET, 'out', 'html', 'markers.json')
sys.path.insert(0, os.path.join(PROJET, 'pzmap2dzi'))
sys.path.insert(0, RACINE)

WORKSHOP = os.path.expanduser('~/.local/share/Steam/steamapps/workshop/content/108600')

# Fichiers Lua de loot des mods installes, releves a la main dans le workshop.
LUA_MODS = [
    '3747595202/mods/Greenport B42/common/media/lua/server/items/GP_ProceduralDistributions.lua',
    '3747595202/mods/Greenport B42/common/media/lua/server/items/GP_Distributions.lua',
    '3768876083/mods/Trelai_B42/42/media/lua/server/Items/trelaiProceduralDistributions.lua',
    '3768876083/mods/Trelai_B42/common/media/lua/server/Items/trelailootzonesdistro.lua',
    '3628736763/mods/CommunityTilePack/common/media/lua/server/items/CTP_Definitions.lua',
]

VANILLA_LUA = [
    'Distribution_BagsAndContainers.lua', 'Distribution_BinJunk.lua',
    'Distribution_ClosetJunk.lua', 'Distribution_CounterJunk.lua',
    'Distribution_DeskJunk.lua', 'Distribution_ShelfJunk.lua',
    'Distribution_SideTableJunk.lua',
    'ProceduralDistributions.lua', 'Distributions.lua',
]

BILLETS = {'Money', 'MoneyBundle'}

# Ce que promet chaque categorie de pastille, en DisplayCategory du jeu (lue
# dans les scripts d'objets, voir charger_classes). Choix assumes :
#   armes   : vraies armes, munitions, accessoires, explosifs. Pas les armes
#             improvisees (batte = SportsWeapon, machette = GardeningWeapon,
#             hache = ToolWeapon) : "armes, militaire" promet des armes.
#   outils  : outils ET materiaux de quincaillerie (clous, vis, ruban, colle
#             sont en Material) ET pieces auto (garage mecanique).
#   bouffe  : nourriture et eau.
#   medical : FirstAid (pansements, desinfectant, pilules, attelles...).
CLASSES = {
    'armes':   {'Weapon', 'Ammo', 'WeaponPart', 'Explosives'},
    'medical': {'FirstAid'},
    'outils':  {'Tool', 'ToolWeapon', 'Material', 'MaterialWeapon', 'VehicleMaintenance'},
    'bouffe':  {'Food', 'Water'},
}
# essence : les bidons. La pompe devant la station est verifiee a part.
ESSENCE = {'PetrolCan', 'JerryCan'}
# labo : les tirages faits dans les tables propres aux laboratoires du jeu.
# Pas l'appartenance des objets a ces tables : elles contiennent aussi des
# bouteilles d'eau et des stylos, et une epicerie passait pour un labo.
TABLES_LABO = ('Chemistry', 'ScienceMisc', 'TestingLab', 'FridgeMedical')

# Types de meubles qui ne tombent jamais sur l'entree 'other' d'une piece :
# NO_GENERIC_LOOT_CONTAINERS dans ItemPickerJava (initNoGenericLootContainers),
# ids releves dans ContainerType. 41 types.
SANS_REPLI_OTHER = {
    'Mannequin', 'SurvivorCrate', 'barbecue', 'barbecuepropane', 'bin',
    'brazier', 'campfire', 'cashregister', 'clothingdryer',
    'clothingdryerbasic', 'clothingrack', 'clothingwasher', 'coffeemaker',
    'coffin', 'composter', 'dishwasher', 'doghouse', 'dumpster', 'fireplace',
    'freezer', 'fridge', 'icecream', 'logs', 'medicine', 'microwave',
    'newspaper_dispatch', 'newspaper_herald', 'newspaper_knews',
    'newspaper_times', 'plankstash', 'postbox', 'shelter', 'stonefurnace',
    'stove', 'tent', 'toaster', 'trough', 'vendingGt', 'vendingpop',
    'vendingsnack', 'woodstove',
}

CATEGORIES = ('billets', 'or', 'valeur', 'armes', 'medical', 'outils',
              'bouffe', 'essence', 'labo')


def charger_classes(pz_root, dossiers_mods=()):
    """Objet -> DisplayCategory, depuis les scripts du jeu et des mods."""
    motif = re.compile(r'\bitem\s+(\w+)\s*\{(.*?)\n\s*\}', re.S)
    cat = re.compile(r'DisplayCategory\s*=\s*([^,\n]+)')
    dossiers = [os.path.join(pz_root, 'media', 'scripts')]
    for base in dossiers_mods:
        dossiers += glob.glob(os.path.join(base, '*', 'mods', '*', '**', 'media', 'scripts'),
                              recursive=True)
    classes = {}
    for d in dossiers:
        for f in glob.glob(os.path.join(d, '**', '*.txt'), recursive=True):
            try:
                texte = open(f, encoding='utf8', errors='replace').read()
            except OSError:
                continue
            for m in motif.finditer(texte):
                c = cat.search(m.group(2))
                if c:
                    classes.setdefault(m.group(1), c.group(1).strip())
    return classes


def est_or(objet):
    o = objet.split('.')[-1]
    return 'Gold' in o and not o.startswith('Goldfish')


# ---------------------------------------------------------------------------

def charger_tables(pz_root):
    import lupa
    from pzmap2dzi import lua_util
    env = lupa.LuaRuntime(unpack_returned_tuples=True)
    env.execute('''
        require = function() end
        __crochets = {}
        Events = setmetatable({}, {__index = function(t, k)
            local e = {Add = function(f) table.insert(__crochets, f) end,
                       Remove = function() end}
            rawset(t, k, e)
            return e
        end})
        function __lancer_crochets()
            for _, f in ipairs(__crochets) do pcall(f) end
        end
    ''')
    dossier = os.path.join(pz_root, 'media', 'lua', 'server', 'Items')
    for f in VANILLA_LUA:
        lua_util.run_lua_file(os.path.join(dossier, f), env=env)
    charges = []
    for rel in LUA_MODS:
        chemin = os.path.join(WORKSHOP, rel)
        if not os.path.isfile(chemin):
            continue
        try:
            lua_util.run_lua_file(chemin, env=env)
            charges.append(os.path.basename(chemin))
        except Exception as e:
            print('  mod illisible %s : %s' % (os.path.basename(chemin), str(e).split('\n')[0]))
    env.execute('__lancer_crochets()')
    g = env.globals()
    proc = lua_util.unpack_lua_table(g['ProceduralDistributions'])['list']
    listes = lua_util.unpack_lua_table(g['Distributions'])
    # Fusion comme le jeu : les tables suivantes completent la premiere,
    # piece par piece et meuble par meuble.
    dist = {}
    for bloc in listes:
        if not isinstance(bloc, dict):
            continue
        for piece, meubles in bloc.items():
            if isinstance(meubles, dict):
                cible = dist.setdefault(piece, {})
                cible.update(meubles)
    return proc, dist, charges


def objets(table):
    cumul = collections.Counter()
    liste = table.get('items') if isinstance(table, dict) else None
    if isinstance(liste, list):
        i = 0
        while i < len(liste) - 1:
            if isinstance(liste[i], str) and isinstance(liste[i + 1], (int, float)):
                cumul[liste[i].split('.')[-1]] += float(liste[i + 1])
                i += 2
            else:
                i += 1
    return cumul


class Tables:
    def __init__(self, proc, dist, classes=None):
        self.proc = proc
        self.dist = dist
        self.classes = classes or {}
        self.contenants = {k: v for k, v in dist.items()
                           if isinstance(v, dict) and 'items' in v and 'procList' not in v}
        self.cache = {}
        # Ce qu'est un bijou, d'apres le jeu lui-meme : tout objet des tables
        # Jewelry* (Gems, Gold, Silver, Wrist, WeddingRings, NavelRings,
        # Others, StorageAll), 80 objets, moins la loupe qui est un outil.
        self.bijoux = set()
        for nom, t in proc.items():
            if nom.startswith('Jewelry') and isinstance(t, dict):
                self.bijoux.update(objets(t))
        self.bijoux.discard('Loupe')

    def categories_objet(self, objet):
        """Categories de pastille qu'un objet satisfait."""
        c = set()
        b, g = objet in BILLETS, est_or(objet)
        if b:
            c.add('billets')
        if g:
            c.add('or')
        if b or g or objet in self.bijoux:
            c.add('valeur')
        classe = self.classes.get(objet)
        for nom, ensemble in CLASSES.items():
            if classe in ensemble:
                c.add(nom)
        if objet in ESSENCE:
            c.add('essence')
        return c

    def parts(self, nom, prof=0, vus=frozenset()):
        """{categorie: part par tirage} dans une table, conteneurs suivis."""
        vide = dict.fromkeys(CATEGORIES, 0.0)
        if nom in vus or prof > 3:
            return vide
        if nom in self.cache:
            return self.cache[nom]
        t = self.proc.get(nom) or self.contenants.get(nom)
        if not isinstance(t, dict):
            return vide
        o = objets(t)
        total = sum(o.values()) or 1
        r = dict(vide)
        for objet, p in o.items():
            f = p / total
            for c in self.categories_objet(objet):
                r[c] += f
            if objet in self.contenants:
                sous = self.parts(objet, prof + 1, vus | {nom})
                for c in CATEGORIES:
                    r[c] += f * sous[c]
        self.cache[nom] = r
        return r

    def meuble(self, piece, type_meuble):
        """Table utilisee par le jeu pour un meuble de ce type dans cette piece.

        Ordre releve dans le code du jeu (ItemPickerJava.fillContainerInternal
        puis fillContainerTypeInternal, projectzomboid.jar desassemble) :
          1. la piece a une entree pour ce type de meuble ;
          2. sinon son entree 'other', sauf pour les 41 types de
             NO_GENERIC_LOOT_CONTAINERS (frigo, poubelle, caisse, portant...) ;
          3. sinon son entree 'all' ;
          4. sinon la table generique 'all' du jeu : ce type, puis son 'other'
             avec la meme exclusion.
        Avant le 28/09 je sautais les etapes 2 et 3. Une etagere dans une
        reserve de bijouterie tire pourtant dans son 'other', JewelryStorageAll.
        """
        generique = type_meuble not in SANS_REPLI_OTHER
        p = self.dist.get(piece)
        if isinstance(p, dict):
            if isinstance(p.get(type_meuble), dict):
                return p[type_meuble], piece
            if generique and isinstance(p.get('other'), dict):
                return p['other'], piece + '/other'
            if isinstance(p.get('all'), dict):
                return p['all'], piece + '/all'
        a = self.dist.get('all', {})
        if isinstance(a.get(type_meuble), dict):
            return a[type_meuble], 'all'
        if generique and isinstance(a.get('other'), dict):
            return a['other'], 'all/other'
        return None, None

    def tables_meuble(self, piece, type_meuble, tuiles=frozenset(), pieces_batiment=frozenset()):
        """Tables qu'UN meuble peut tirer : [(nom, proba, min, max, tirages)].

        Regle lue instruction par instruction dans le code du jeu
        (ItemPickerJava.rollProceduralItemInternal, getDistribInHashMap) :

          - le meuble tire UNE table, au prorata de weightChance parmi les
            candidates ; sans weightChance, une table vaut 1 et non 100 ;
          - forceForTiles : si une tuile de la case du meuble est listee, la
            table est IMPOSEE. Sinon elle reste une candidate ordinaire ;
          - forceForRooms : imposee si le batiment a une piece de ce nom,
            sinon candidate ordinaire ;
          - forceForItems (tuile presente dans la piece) et forceForZones
            (zone de la carte) : imposees si la condition est remplie, sinon
            EXCLUES. Les zones ne sont pas lues ici : ces entrees sont
            ecartees, ce qui ne peut que sous-estimer.
          - plusieurs tables imposees : la derniere de la liste l'emporte,
            chaque correspondance vidant la liste des imposees.

        tuiles : noms des tuiles posees sur la case du meuble.
        pieces_batiment : noms des pieces du meme batiment.
        """
        spec, _ = self.meuble(piece, type_meuble)
        if not spec:
            return []
        if spec.get('items') and not spec.get('procList'):
            tmp = '__%s/%s' % (piece, type_meuble)
            self.contenants[tmp] = spec
            return [(tmp, 1.0, 0, 99, float(spec.get('rolls', 1) or 1))]
        impose = None
        entrees = []
        for e in (spec.get('procList') or []):
            t = self.proc.get(e.get('name'))
            if not isinstance(t, dict):
                continue
            liste = lambda k: [x for x in str(e.get(k) or '').split(';') if x]
            tir = float(t.get('rolls', 1) or 1)
            mx = e.get('max')
            mx = int(mx) if isinstance(mx, (int, float)) and mx >= 0 else 99
            mn = int(e.get('min') or 0)
            ft, fr = liste('forceForTiles'), liste('forceForRooms')
            fi, fz = liste('forceForItems'), liste('forceForZones')
            if ft and tuiles.intersection(ft):
                impose = (e.get('name'), 1.0, mn, mx, tir)
            if fr and pieces_batiment.intersection(fr):
                impose = (e.get('name'), 1.0, mn, mx, tir)
            if fi or fz:
                continue                    # jamais candidate ordinaire
            wc = e.get('weightChance')
            wc = wc if isinstance(wc, (int, float)) and wc > 0 else 1
            entrees.append((e.get('name'), float(wc), mn, mx, tir))
        if impose:
            return [impose]
        total = sum(x[1] for x in entrees)
        if not total:
            return []
        return [(n, w / total, mn, mx, r) for n, w, mn, mx, r in entrees]

    def esperance_meuble(self, piece, type_meuble):
        """{categorie: nombre attendu} dans UN meuble de ce type, sans plafond de piece."""
        r = dict.fromkeys(CATEGORIES, 0.0)
        for nom, proba, _, _, tirages in self.tables_meuble(piece, type_meuble):
            parts = self.parts(nom)
            for c in CATEGORIES:
                r[c] += proba * tirages * parts[c]
            if nom in TABLES_LABO:
                r['labo'] += proba * tirages
        return r



class Meubles(collections.Counter):
    """Counter {type de meuble: nombre} qui garde aussi chaque meuble."""
    def __init__(self, *a, **k):
        super().__init__(*a, **k)
        self.conteneurs = []


class Verificateur:
    """Meubles et contenu d'une piece donnee, avec caches par cellule."""

    def __init__(self, cartes, pz_root):
        from pzmap2dzi import lotheader, cell
        import tuiles_conteneurs
        self._lotheader, self._cell = lotheader, cell
        self.cartes = cartes
        proc, dist, self.mods = charger_tables(pz_root)
        self.classes = charger_classes(pz_root, [WORKSHOP])
        self.tables = Tables(proc, dist, self.classes)
        self.meubles = tuiles_conteneurs.charger(pz_root, [WORKSHOP])
        self.pompes_tuiles = set(tuiles_conteneurs.POMPES)
        self.pieces_metal = set()     # rempli par extraire-marqueurs.py
        self._pompes = {}
        self._cellules = {}

    def cellule(self, nom, cx, cy):
        k = (nom, cx, cy)
        if k not in self._cellules:
            try:
                self._cellules[k] = self._cell.load_cell(self.cartes[nom], cx, cy)
            except Exception:
                self._cellules[k] = None
        return self._cellules[k]

    def entete(self, nom, cx, cy):
        k = ('h', nom, cx, cy)
        if k not in self._cellules:
            try:
                self._cellules[k] = self._lotheader.load_lotheader(self.cartes[nom], cx, cy)
            except Exception:
                self._cellules[k] = None
        return self._cellules[k]

    def piece_a(self, x, y, z, voulu=None, cartes=None):
        """Piece qui contient la case (x, y, z) : (carte, cx, cy, room, nom).

        Une piece est declaree dans UNE cellule mais ses rectangles peuvent
        deborder sur la voisine : la bijouterie en 13572,1275 est declaree
        dans la cellule 52,4 avec un rectangle a (253,246) de 15x11. On
        cherche donc dans les neuf cellules autour.
        """
        cx, cy = x // 256, y // 256
        meilleur = None
        for nom in (cartes or self.cartes):
            for hx in (cx, cx - 1, cx + 1):
                for hy in (cy, cy - 1, cy + 1):
                    h = self.entete(nom, hx, hy)
                    if not h:
                        continue
                    for r in h.get('rooms') or []:
                        if r.get('layer', 0) != z:
                            continue
                        for (rx, ry, w, hh) in r['rects']:
                            if (hx * 256 + rx <= x < hx * 256 + rx + w
                                    and hy * 256 + ry <= y < hy * 256 + ry + hh):
                                n = r['name']
                                n = n.decode('utf8', 'replace') if isinstance(n, bytes) else n
                                cand = (nom, hx, hy, r, n)
                                if voulu and n == voulu:
                                    return cand
                                meilleur = meilleur or cand
        return meilleur

    def oublier(self, nom=None):
        """Libere la memoire des cellules deja lues (une carte a la fois)."""
        if nom is None:
            self._cellules.clear()
        else:
            for k in [k for k in self._cellules if k[0] == nom]:
                del self._cellules[k]

    def types_meubles(self, nom, cx, cy, room):
        """Compte des types de meubles de rangement dans une piece.

        Renvoie un Counter {type: nombre}, qui porte aussi .conteneurs, la
        liste (type, tuiles de la case) de chaque meuble : il faut les tuiles
        pour savoir si une table forceForTiles s'impose.
        """
        types = Meubles()
        z = room.get('layer', 0)
        for (rx, ry, w, hh) in room['rects']:
            for wx in range(cx * 256 + rx, cx * 256 + rx + w):
                for wy in range(cy * 256 + ry, cy * 256 + ry + hh):
                    c = self.cellule(nom, wx // 256, wy // 256)
                    if not c:
                        continue
                    case = list(c.get_square(wx % 256, wy % 256, z) or [])
                    if not case:
                        continue
                    tuiles = None
                    for t in case:
                        m = self.meubles.get(t)
                        if m:
                            types[m] += 1
                            if tuiles is None:
                                tuiles = frozenset(case)
                            types.conteneurs.append((m, tuiles))
        return types

    def esperance(self, piece, types, pieces_batiment=frozenset()):
        """{categorie: nombre attendu} en vidant la piece une fois.

        Chaque tuile de rangement est un conteneur a part dans le jeu : un
        comptoir sur deux cases, ce sont deux conteneurs. On evalue chaque
        meuble avec les tuiles de SA case (forceForTiles).

        Le jeu compte, PIECE par piece, combien de meubles ont deja tire
        chaque table : une table max=1 ne remplit qu'un meuble de la piece
        (la mallette du labo de drogue, par exemple), et une table min=1 est
        servie en priorite. On estime donc, pour chaque table, le nombre de
        meubles qui la tirent : somme des probas, plafonnee a max, relevee a
        min s'il y a assez de meubles.
        """
        detail = getattr(types, 'conteneurs', None)
        if detail is None:
            detail = [(t, frozenset()) for t, n in types.items() for _ in range(n)]
        usage = {}          # table -> [meubles attendus, min, max, tirages, eligibles]
        for t, tuiles in detail:
            for nom, proba, mn, mx, tirages in self.tables.tables_meuble(
                    piece, t, tuiles, pieces_batiment):
                u = usage.setdefault(nom, [0.0, 0, 0, tirages, 0])
                u[0] += proba
                u[1] = max(u[1], mn)
                u[2] = max(u[2], mx)
                u[4] += 1
        r = dict.fromkeys(CATEGORIES, 0.0)
        for nom, (attendu, mn, mx, tirages, eligibles) in usage.items():
            k = max(min(attendu, mx), min(mn, eligibles))
            parts = self.tables.parts(nom)
            for c in CATEGORIES:
                r[c] += k * tirages * parts[c]
            if nom in TABLES_LABO:
                r['labo'] += k * tirages
        return r

    def pieces_pour(self, cibles):
        """Noms de pieces dont un meuble peut tirer une table contenant l'un
        des objets. 'all' en fait partie si la table generique en contient :
        les pieces nommees 'all' sur la carte sont alors candidates."""
        tables = {n for n, t in self.tables.proc.items()
                  if isinstance(t, dict) and set(objets(t)) & set(cibles)}
        pieces = set()
        for p, m in self.tables.dist.items():
            if not isinstance(m, dict) or 'items' in m:
                continue
            for s in m.values():
                if isinstance(s, dict) and any(e.get('name') in tables
                                               for e in (s.get('procList') or [])):
                    pieces.add(p)
                    break
        return pieces

    def esperance_objets(self, piece, types, cibles, pieces_batiment=frozenset()):
        """{objet: nombre attendu} pour des objets precis, meme regle
        qu'esperance() : une table par meuble, plafonds min/max de la piece.
        Les conteneurs (sacs, mallettes) ne sont pas ouverts ici."""
        detail = getattr(types, 'conteneurs', None)
        if detail is None:
            detail = [(t, frozenset()) for t, n in types.items() for _ in range(n)]
        usage = {}
        for t, tuiles in detail:
            for nom, proba, mn, mx, tirages in self.tables.tables_meuble(
                    piece, t, tuiles, pieces_batiment):
                u = usage.setdefault(nom, [0.0, 0, 0, tirages, 0])
                u[0] += proba
                u[1] = max(u[1], mn)
                u[2] = max(u[2], mx)
                u[4] += 1
        r = dict.fromkeys(cibles, 0.0)
        for nom, (attendu, mn, mx, tirages, eligibles) in usage.items():
            t = self.tables.proc.get(nom) or self.tables.contenants.get(nom)
            o = objets(t) if isinstance(t, dict) else {}
            total = sum(o.values()) or 1
            k = max(min(attendu, mx), min(mn, eligibles))
            for c in cibles:
                r[c] += k * tirages * o.get(c, 0) / total
        return r

    def pompes(self, nom):
        """Positions (x, y) des pompes a essence d'une carte, calculees une fois.

        Seules les cellules dont le .lotheader annonce une tuile de pompe sont
        lues : une poignee sur des milliers.
        """
        if nom in self._pompes:
            return self._pompes[nom]
        chemin = self.cartes[nom]
        pos = []
        for f in os.listdir(chemin):
            if not f.endswith('.lotheader'):
                continue
            try:
                cx, cy = (int(v) for v in f[:-10].split('_'))
            except ValueError:
                continue
            h = self.entete(nom, cx, cy)
            if not h or not (set(h.get('tiles') or []) & self.pompes_tuiles):
                continue
            c = self.cellule(nom, cx, cy)
            if not c:
                continue
            for sx in range(c.cell_size):
                for sy in range(c.cell_size):
                    for t in (c.get_square(sx, sy, 0) or []):
                        if t in self.pompes_tuiles:
                            pos.append((cx * 256 + sx, cy * 256 + sy))
                            break
        self._pompes[nom] = pos
        return pos

    def pompe_proche(self, nom, cx, cy, room, rayon):
        """Distance a la pompe la plus proche des rectangles de la piece, ou None."""
        meilleur = None
        for (rx, ry, w, hh) in room['rects']:
            x0, y0 = cx * 256 + rx, cy * 256 + ry
            for (px, py) in self.pompes(nom):
                dx = max(x0 - px, 0, px - (x0 + w - 1))
                dy = max(y0 - py, 0, py - (y0 + hh - 1))
                dist = max(dx, dy)
                if dist <= rayon and (meilleur is None or dist < meilleur):
                    meilleur = dist
        return meilleur

    def a_du_loot(self, piece, types):
        """Au moins un meuble present a une table, dans la piece ou dans 'all'."""
        return any(self.tables.meuble(piece, t)[0] for t in types)
