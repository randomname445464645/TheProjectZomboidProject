#!/usr/bin/env python3
"""Construit les tables de loot que l'infobulle des pastilles affiche.

Sert deux besoins :
  - le resume au survol : les objets les plus probables de la piece ;
  - la fenetre "voir toute la table" : chaque meuble, sa table, tous ses
    objets avec leur poids, et le contenu des conteneurs qu'on y trouve.

SOURCE
    media/lua/server/Items/Distributions.lua dit, pour chaque nom de piece,
    quel meuble tire dans quelle table procedurale. Le MEME fichier decrit
    aussi, au meme niveau, le contenu des conteneurs : Briefcase_Money et
    Bag_MoneyBag y sont des entrees comme bedroom ou gunstore, avec rolls et
    items directement au lieu d'une liste de meubles.
    media/lua/server/Items/ProceduralDistributions.lua dit ce que contient
    chaque table : une liste plate [objet, poids, objet, poids, ...].
    Les deux sont lus comme du Lua avec lupa.

    Les noms francais viennent de Translate/FR/ItemName.json.

CONTENEURS
    C'est ce qui manquait : DrugLabMoney contient Briefcase_Money poids 10 et
    Bag_MoneyBag poids 20, deux conteneurs bourres de billets. L'infobulle
    listait la mallette parmi les objets sans dire ce qu'il y avait dedans,
    quand elle ne la coupait pas du classement. Un objet qui a sa propre table
    est maintenant marque et ouvrable.

CHANCE AFFICHEE
    poids de l'objet / somme des poids de sa table, multiplie par la chance
    que le meuble tire cette table (son weightChance rapporte a celui des
    tables concurrentes, regle du jeu). C'est la chance qu'un tirage
    de ce meuble donne cet objet. Le nombre de tirages depend de la taille du
    conteneur et du reglage de loot du serveur, donc ce n'est PAS la
    probabilite de trouver l'objet dans la piece : c'est un ordre de grandeur,
    bon pour comparer deux objets entre eux.

MEUBLES GENERIQUES
    Chaque table est normalisee sur elle-meme, donc une petite table gagne
    toujours : StoreCounterCleaning n'a que six objets et se retrouve dans 91
    pieces, si bien que l'armurerie annoncait "Torchon 26 %, Eponge 26 %" avant
    les fusils. Le RESUME ecarte donc les tables partagees par plus de
    SEUIL_PARTAGE pieces, qui decrivent le mobilier et pas le lieu. La fenetre
    detaillee, elle, montre tout.
"""
import io
import json
import os
import sys

RACINE = os.path.dirname(os.path.abspath(__file__))
PROJET = os.path.normpath(os.path.join(RACINE, '..', '..'))
SORTIE = os.path.join(PROJET, 'out', 'html', 'carte', 'loot-pieces.json')
SORTIE_TABLES = os.path.join(PROJET, 'out', 'html', 'carte', 'loot-tables.json')

sys.path.insert(0, os.path.join(PROJET, 'pzmap2dzi'))

# Nombre d'objets gardes dans le resume. Au-dela l'infobulle devient un mur.
GARDES = 14

# Conteneurs ajoutes au resume en plus des GARDES, meme s'ils sont trop rares
# pour y entrer. C'est ce qui manquait au labo de drogue : la mallette a un
# poids de 10 sur 1200, donc elle tombait loin derriere le pain de glace,
# alors qu'elle contient 600 de Monnaie a elle seule.
GARDES_CONTENANTS = 6

# Au-dela de ce nombre de pieces, une table decrit un meuble et pas un lieu.
SEUIL_PARTAGE = 8

# Ce qui n'est pas une piece. La palette de lingots est un objet de decor, son
# contenu est code en dur dans ContextMenuCode.TakeGoldBars : 30 lingots, sans
# tirage au sort, et une seule fois.
SUPPLEMENTS = {
    'goldpallet': [["30 lingots d'or, garantis, une seule fois", 100.0]],
}

# Ordre de chargement : les tables de bric-a-brac definissent des variables
# globales (ClutterTables) dont ProceduralDistributions se sert.
FICHIERS = [
    'Distribution_BagsAndContainers.lua', 'Distribution_BinJunk.lua',
    'Distribution_ClosetJunk.lua', 'Distribution_CounterJunk.lua',
    'Distribution_DeskJunk.lua', 'Distribution_ShelfJunk.lua',
    'Distribution_SideTableJunk.lua',
    'ProceduralDistributions.lua', 'Distributions.lua',
]


def charger_tables(pz_root):
    import lupa
    from pzmap2dzi import lua_util
    dossier = os.path.join(pz_root, 'media', 'lua', 'server', 'Items')
    env = lupa.LuaRuntime(unpack_returned_tuples=True)
    for f in FICHIERS:
        lua_util.run_lua_file(os.path.join(dossier, f), env=env)
    g = env.globals()
    proc = lua_util.unpack_lua_table(g['ProceduralDistributions'])['list']
    dist = lua_util.unpack_lua_table(g['Distributions'])[0]
    return proc, dist


def charger_noms(pz_root):
    chemin = os.path.join(pz_root, 'media', 'lua', 'shared', 'Translate',
                          'FR', 'ItemName.json')
    if not os.path.isfile(chemin):
        return {}
    with io.open(chemin, encoding='utf-8-sig') as f:
        return json.load(f)


def objets(table, avec_junk=False):
    """Liste plate [nom, poids, ...] -> [(nom, poids)], cumulee.

    Un meme objet peut figurer plusieurs fois avec des poids differents :
    StripClubDressers met Money a 100, 50 et 20. Le jeu tire dans la liste
    entiere, donc les poids s'additionnent.
    """
    cumul = {}
    cles = ('items', 'junk') if avec_junk else ('items',)
    for cle in cles:
        liste = table.get(cle)
        if cle == 'junk' and isinstance(liste, dict):
            liste = liste.get('items')
        if not isinstance(liste, list):
            continue
        i = 0
        while i < len(liste) - 1:
            nom, poids = liste[i], liste[i + 1]
            if isinstance(nom, str) and isinstance(poids, (int, float)):
                cumul[nom] = cumul.get(nom, 0.0) + float(poids)
                i += 2
            else:
                i += 1
    return sorted(cumul.items(), key=lambda kv: -kv[1])


def est_piece(entree):
    """Une piece est un dictionnaire de meubles ; un conteneur a ses items."""
    if not isinstance(entree, dict):
        return False
    return 'items' not in entree and 'procList' not in entree


def main():
    from pzmap2dzi.i18n_util import load_yaml
    conf = load_yaml(os.path.join(PROJET, 'pzmap2dzi', 'conf', 'conf-iso.yaml'))
    pz_root = conf['pz_root']

    # Memes tables que la verification des pastilles, mods compris : sinon
    # l'infobulle de la salle des coffres de Trelai n'avait aucune liste,
    # alors que la pastille venait d'etre posee d'apres cette meme table.
    sys.path.insert(0, RACINE)
    import verification
    proc, dist, mods = verification.charger_tables(pz_root)
    print('tables des mods : %s' % (', '.join(mods) or 'aucune'))
    T = verification.Tables(proc, dist)
    noms = charger_noms(pz_root)
    def nom_fr(o):
        # Objets de mods : 'Trelai.TrelaiGoldBar'. Le jeu n'a pas leur nom
        # francais ; on essaie l'identifiant complet, puis on retire le module.
        return noms.get(o) or noms.get('Base.' + o) or o.split('.')[-1]

    # Conteneurs : les entrees de Distributions qui ont leurs items en direct.
    contenants = {}
    for cle, e in dist.items():
        if isinstance(e, dict) and not est_piece(e) and e.get('items'):
            contenants[cle] = e

    # Toutes les tables citables, procedurales ou conteneurs.
    brutes = dict(proc)
    brutes.update(contenants)

    # Combien de pieces partagent chaque table procedurale.
    partage = {}
    for piece, meubles in dist.items():
        if not est_piece(meubles):
            continue
        vues = set()
        for meuble, spec in meubles.items():
            if isinstance(spec, dict):
                for e in (spec.get('procList') or []):
                    vues.add(e.get('name'))
        for t in vues:
            partage[t] = partage.get(t, 0) + 1

    # Chance par objet dans chaque table.
    chances = {}
    for nom_table, t in brutes.items():
        if not isinstance(t, dict):
            continue
        paires = objets(t)
        total = sum(p for _, p in paires)
        if total > 0:
            chances[nom_table] = {n: p / total for n, p in paires}

    pieces = {}
    tables_citees = set()
    for piece, meubles in dist.items():
        if not est_piece(meubles):
            continue
        resume = {}
        secours = {}
        detail = []
        for meuble, spec in meubles.items():
            if not isinstance(spec, dict):
                continue
            entrees = list(spec.get('procList') or [])
            # Un meuble peut aussi avoir sa liste en direct, sans table
            # nommee. On lui en fabrique une, "piece/meuble".
            if not entrees and spec.get('items'):
                faux = '%s/%s' % (piece, meuble)
                brutes[faux] = spec
                paires = objets(spec)
                total = sum(p for _, p in paires)
                if total > 0:
                    chances[faux] = {n: p / total for n, p in paires}
                entrees = [{'name': faux}]
            # Chance REELLE que le meuble tire chaque table : weightChance
            # rapporte a la somme des candidates, une table sans poids valant
            # 1, comme dans le jeu (verification.Tables.tables_meuble). Sans
            # tuile precise : c'est le cas d'un meuble ordinaire de la piece.
            # Avant le 29/09 on affichait weightChance/100, comme si les tables
            # etaient tirees independamment.
            probas = {n: pr for n, pr, *_ in T.tables_meuble(piece, meuble)}
            for e in entrees:
                nom_table = e.get('name')
                table = chances.get(nom_table)
                if not table:
                    continue
                tables_citees.add(nom_table)
                facteur = probas.get(nom_table, 1.0 if nom_table.startswith(piece + '/') else 0.0)
                if facteur <= 0:
                    continue        # table imposee par une zone ou un objet : hors cas general
                detail.append([meuble, nom_table, round(facteur * 100, 1)])
                # Mobilier generique = table partagee par beaucoup de pieces
                # ET a plusieurs sortes d'objets. Une caisse specialisee a
                # objet unique (CrateSheetMetal : que des plaques) n'est pas du
                # remplissage meme si dix types de pieces la citent : sans
                # cette nuance, l'expedition de metal annoncait barres et
                # tuyaux, mais pas ses plaques.
                generique = (partage.get(nom_table, 0) > SEUIL_PARTAGE
                             and len(table) > 3)
                cible = secours if generique else resume
                for objet, part in table.items():
                    c = part * facteur
                    if c > cible.get(objet, 0):
                        cible[objet] = c
        retenu = resume or secours
        if not retenu and not detail:
            continue
        # Deux identifiants peuvent porter le meme nom affiche (les etuis de
        # fusil, par exemple) : on ne garde que le meilleur.
        par_nom = {}
        for objet, c in retenu.items():
            libelle = nom_fr(objet)
            if c > par_nom.get(libelle, 0):
                par_nom[libelle] = c
        top = sorted(par_nom.items(), key=lambda kv: -kv[1])[:GARDES]
        resume_final = [[libelle, round(c * 100, 1)] for libelle, c in top]

        # Les conteneurs de la piece, qu'ils aient perce ou non. Un sac
        # d'argent pese peu dans la table qui le contient mais c'est lui le
        # butin, pas les cinquante objets qui passent devant.
        deja = {libelle for libelle, _ in top}
        boites = {}
        for objet, c in retenu.items():
            if objet in contenants:
                boites[objet] = max(boites.get(objet, 0), c)
        for objet, c in sorted(boites.items(), key=lambda kv: -kv[1]):
            libelle = nom_fr(objet)
            if libelle in deja:
                continue
            deja.add(libelle)
            resume_final.append([libelle, round(c * 100, 1), objet])
            if len(boites) and len(resume_final) - len(top) >= GARDES_CONTENANTS:
                break
        # Un conteneur deja dans le top devient ouvrable lui aussi.
        for ligne in resume_final[:len(top)]:
            for objet in boites:
                if nom_fr(objet) == ligne[0] and len(ligne) == 2:
                    ligne.append(objet)

        pieces[piece] = {
            't': resume_final,
            'm': sorted(detail),
        }

    for cle, liste in SUPPLEMENTS.items():
        pieces[cle] = {'t': liste, 'm': []}

    # Les tables, y compris celles des conteneurs qu'elles citent, de proche
    # en proche : la mallette du labo contient un GemBag, qui a sa table.
    tables = {}
    a_faire = set(tables_citees)
    for d in pieces.values():
        for ligne in d['t']:
            if len(ligne) > 2:
                a_faire.add(ligne[2])
    while a_faire:
        nom_table = a_faire.pop()
        if nom_table in tables:
            continue
        t = brutes.get(nom_table)
        if not isinstance(t, dict):
            continue
        lignes = []
        for objet, poids in objets(t):
            ligne = [nom_fr(objet), round(poids, 3)]
            if objet in contenants:
                ligne.append(objet)       # ouvrable : il a sa propre table
                a_faire.add(objet)
            lignes.append(ligne)
        tables[nom_table] = {'r': t.get('rolls', 1) or 1, 'i': lignes}

    with io.open(SORTIE, 'w', encoding='utf8') as f:
        json.dump(pieces, f, ensure_ascii=False, separators=(',', ':'))
    with io.open(SORTIE_TABLES, 'w', encoding='utf8') as f:
        json.dump(tables, f, ensure_ascii=False, separators=(',', ':'))
    print('pieces decrites  : %d' % len(pieces))
    print('tables detaillees: %d (dont %d conteneurs)'
          % (len(tables), sum(1 for k in tables if k in contenants)))
    print('ecrit : %s (%.0f Ko)' % (SORTIE, os.path.getsize(SORTIE) / 1024))
    print('ecrit : %s (%.0f Ko)'
          % (SORTIE_TABLES, os.path.getsize(SORTIE_TABLES) / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
