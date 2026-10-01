#!/usr/bin/env python3
"""Rendu progressif du calque des constructions, en tache de fond.

POURQUOI
    convertir.py puis rendre-calque.py refont TOUT a chaque synchronisation :
    lecture du releve entier (1,2 Go, 18 millions de lignes, 6,5 millions de
    cases gardees en dictionnaire Python), puis 29 000 tuiles redessinees par
    8 processus. Plusieurs Gio de RAM et tous les coeurs pendant des dizaines
    de minutes : impossible pendant une partie, la machine est juste en
    memoire et le noyau tue alors le plus gros processus, c'est a dire le jeu.

    Ce script fait le meme travail par petits morceaux, et seulement la ou
    quelque chose a change :

    - il lit le releve A PARTIR DE LA OU IL S'ETAIT ARRETE (position en octets
      memorisee par fichier), par tranches de quelques Mo ;
    - il garde les cases dans une base SQLite sur disque, pas en memoire ;
    - une case dont les sprites n'ont pas change ne coute rien ; une case qui
      change marque les tuiles qu'elle touchait et celles qu'elle touche
      desormais ;
    - il redessine ces tuiles une par une, les plus proches du joueur d'abord,
      puis remonte la pyramide uniquement au-dessus d'elles ;
    - entre deux lots il dort, et il se met en pause tant que la memoire
      disponible est basse ou que le systeme est sous pression.

    Lent, mais sans jamais faire ramer le jeu. Lancer via rendu-progressif.sh,
    qui ajoute les plafonds du noyau (memoire, CPU, priorite minimale).

SORTIE
    Exactement celle de rendre-calque.py (map_data/constructions/layer0_files
    et info.json), que le viewer lit deja. Deux ajouts dans info.json :

    versions   par niveau, "tx_ty" -> jeton, pour les tuiles redessinees
               depuis le dernier rendu complet. Le viewer l'ajoute a l'URL :
               seules ces tuiles sont rechargees, les autres restent en cache.
    maj        date de la derniere ecriture, que le viewer surveille.

REPRISE
    Tout l'etat est sur disque (base, positions de lecture, tuiles a refaire).
    Un arret, un gel ou un kill reprend la ou il en etait ; au pire le lot en
    cours est refait.
"""
import argparse
import collections
import fcntl
import json
import math
import os
import signal
import sqlite3
import sys
import time

from PIL import Image

RACINE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, RACINE)
from convertir import DECALAGE_SAISON, feuillage, fichiers_source  # noqa: E402

GW, GH, LH = 64, 32, 192          # GRID_WIDTH, GRID_HEIGHT, LAYER_HEIGHT
DV_Z = LH // GH                   # un etage decale v de 6

HTML_DEFAUT = os.path.normpath(os.path.join(RACINE, '..', '..', 'out', 'html'))
SOURCE_DEFAUT = os.path.expanduser('~/Zomboid/pz-export')
TEXTURES_DEFAUT = '/mnt/data/pz-render/out-iso/texture'

arret = False


def demander_arret(*_):
    global arret
    arret = True


# --- journal et etat ---------------------------------------------------------

class Suivi:
    """Ecrit le journal et etat.json, lu par suivi-rendu.py.

    etat.json est petit et reecrit par renommage atomique : le suivi peut le
    relire toutes les deux secondes sans rien couter ni lire un fichier a
    moitie ecrit.
    """

    def __init__(self, dossier):
        self.chemin = os.path.join(dossier, 'etat.json')
        self.journal = open(os.path.join(dossier, 'journal.log'), 'a', encoding='utf8', buffering=1)
        self.e = {'pid': os.getpid(), 'debut': time.time(), 'phase': 'demarrage',
                  'pause': None, 'lecture': {}, 'tuiles': {}, 'dernier': ''}

    def log(self, msg):
        ligne = time.strftime('%Y-%m-%d %H:%M:%S ') + msg
        self.journal.write(ligne + '\n')
        print(msg, flush=True)
        self.e['dernier'] = msg

    def ecrire(self, **maj):
        self.e.update(maj)
        self.e['t'] = time.time()
        tmp = self.chemin + '.tmp'
        with open(tmp, 'w', encoding='utf8') as f:
            json.dump(self.e, f)
        os.replace(tmp, self.chemin)


# --- ressources ---------------------------------------------------------------

def meminfo():
    r = {}
    with open('/proc/meminfo') as f:
        for ligne in f:
            k, v = ligne.split(':', 1)
            r[k] = int(v.split()[0]) * 1024
    return r


def pression(ressource):
    """avg10 de la ligne 'some' de /proc/pressure/<ressource>, ou 0."""
    try:
        with open('/proc/pressure/' + ressource) as f:
            for ligne in f:
                if ligne.startswith('some'):
                    return float(ligne.split('avg10=')[1].split()[0])
    except (OSError, IndexError, ValueError):
        pass
    return 0.0


def jeu_lance():
    """ProjectZomboid64 tourne-t-il ? Lecture de /proc/*/comm, sans pgrep."""
    for p in os.listdir('/proc'):
        if not p.isdigit():
            continue
        try:
            with open('/proc/%s/comm' % p) as f:
                if f.read().startswith('ProjectZomboid'):
                    return True
        except OSError:
            pass
    return False


def raison_de_pause(args):
    """Pourquoi ne pas travailler maintenant, ou None si tout va bien."""
    m = meminfo()
    libre = m.get('MemAvailable', 0)
    if libre < args.memoire_libre * 2**30:
        return 'memoire basse : %.1f Gio disponibles (seuil %.1f)' % (libre / 2**30, args.memoire_libre)
    pm = pression('memory')
    if pm > args.pression_memoire:
        return 'systeme sous pression memoire (%.0f %%)' % pm
    pio = pression('io')
    if pio > args.pression_io:
        return 'disque sature (%.0f %%)' % pio
    return None


def dormir(secondes):
    fin = time.time() + secondes
    while not arret and time.time() < fin:
        time.sleep(min(1.0, fin - time.time()))


# --- base ---------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS cases (
    x INTEGER, y INTEGER, z INTEGER,
    d INTEGER,              -- x - y : colonne de pixel
    v INTEGER,              -- x + y + 2 - 6 z : ligne de pixel du bas-centre
    s TEXT,                 -- indices de sprites, separes par des virgules
    c INTEGER,              -- vue construite au moins une fois
    PRIMARY KEY (x, y, z)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS cases_dv ON cases (d, v);
CREATE TABLE IF NOT EXISTS sprites (
    id INTEGER PRIMARY KEY, nom TEXT UNIQUE,
    dossier TEXT, w INTEGER, h INTEGER, ox INTEGER, oy INTEGER);
CREATE TABLE IF NOT EXISTS fichiers (chemin TEXT PRIMARY KEY, ino INTEGER, pos INTEGER);
CREATE TABLE IF NOT EXISTS sales (tx INTEGER, ty INTEGER, PRIMARY KEY (tx, ty)) WITHOUT ROWID;
-- tuiles de plein niveau refaites dont les niveaux superieurs restent a recomposer
CREATE TABLE IF NOT EXISTS a_remonter (tx INTEGER, ty INTEGER, PRIMARY KEY (tx, ty)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS reglages (cle TEXT PRIMARY KEY, valeur TEXT);
"""


def ouvrir_base(chemin):
    db = sqlite3.connect(chemin, isolation_level=None)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=NORMAL')
    db.execute('PRAGMA cache_size=-65536')        # 64 Mo, pas plus
    db.execute('PRAGMA temp_store=FILE')
    db.executescript(SCHEMA)
    return db


class Sprites:
    """Table des sprites : nom -> id, et id -> (dossier, w, h, ox, oy).

    Le decalage ox/oy vient des metadonnees des PNG ecrits par unpack, comme
    dans convertir.py. Un sprite introuvable est garde avec dossier NULL : il
    ne sera jamais dessine, et on ne le recherche pas a chaque ligne.
    """

    def __init__(self, db, textures, html):
        self.db, self.textures = db, textures
        self.ids, self.noms, self.metas = {}, {}, {}
        for i, nom, dossier, w, h, ox, oy in db.execute('SELECT * FROM sprites'):
            self.ids[nom], self.noms[i] = i, nom
            self.metas[i] = (dossier, w, h, ox, oy) if dossier else None
        self.dossiers = sorted((d for d in os.listdir(textures)
                                if os.path.isdir(os.path.join(textures, d))),
                               key=lambda n: (n != 'default', n)) if os.path.isdir(textures) else []
        # Index deja produit par convertir.py : evite de rouvrir 14 000 PNG.
        self.connus = {}
        try:
            with open(os.path.join(html, 'constructions-sprites.json'), encoding='utf8') as f:
                self.connus = json.load(f)
        except (OSError, ValueError):
            pass
        self.etendue()

    def etendue(self):
        """Debordement maximal d'un sprite autour du bas-centre."""
        ms = [m for m in self.metas.values() if m]
        if ms:
            self.g = min(m[3] for m in ms)
            self.d = max(m[3] + m[1] for m in ms)
            self.h = min(m[4] for m in ms)
            self.b = max(m[4] + m[2] for m in ms)
        else:
            self.g = self.d = self.h = self.b = 0

    def chercher(self, nom):
        m = self.connus.get(nom)
        if m and os.path.isfile(os.path.join(self.textures, m[0], nom + '.png')):
            return tuple(m)
        for d in self.dossiers:
            chemin = os.path.join(self.textures, d, nom + '.png')
            if not os.path.isfile(chemin):
                continue
            try:
                with Image.open(chemin) as im:
                    w, h = im.size
                    return (d, w, h, int(im.info.get('ox', 0)), int(im.info.get('oy', 0)))
            except Exception:
                continue
        return None

    def id(self, nom):
        i = self.ids.get(nom)
        if i is not None:
            return i
        m = self.chercher(nom)
        cur = self.db.execute('INSERT INTO sprites (nom, dossier, w, h, ox, oy) VALUES (?,?,?,?,?,?)',
                              (nom,) + (m or (None,) * 5))
        i = cur.lastrowid
        self.ids[nom], self.noms[i], self.metas[i] = i, nom, m
        if m:
            self.g = min(self.g, m[3]); self.d = max(self.d, m[3] + m[1])
            self.h = min(self.h, m[4]); self.b = max(self.b, m[4] + m[2])
        return i


# --- geometrie -----------------------------------------------------------------

class Geometrie:
    def __init__(self, html):
        with open(os.path.join(html, 'map_data', 'base', 'map_info.json'), encoding='utf8') as f:
            base = json.load(f)
        with open(os.path.join(html, 'map_data', 'base', 'layer0.dzi'), encoding='utf8') as f:
            dzi = f.read()
        self.base = base
        self.px0, self.py0 = base['x0'], base['y0']
        self.W, self.H = base['w'], base['h']
        self.T = int(dzi.split('TileSize="')[1].split('"')[0])
        self.nmax = math.ceil(math.log2(max(self.W, self.H)))

    def tuiles_case(self, d, v, ids, sprites):
        """Tuiles de plein niveau touchees par une case, ensemble vide si rien ne se dessine."""
        g = h = 10**9
        dr = b = -10**9
        for i in ids:
            m = sprites.metas.get(i)
            if not m:
                continue
            g = min(g, m[3]); h = min(h, m[4])
            dr = max(dr, m[3] + m[1]); b = max(b, m[4] + m[2])
        if dr < g:
            return ()
        bx = d * GW + self.px0
        by = v * GH + self.py0
        T = self.T
        return [(tx, ty)
                for tx in range((bx + g) // T, (bx + dr) // T + 1)
                for ty in range((by + h) // T, (by + b) // T + 1)]


# --- lecture du releve -------------------------------------------------------

def enrichir(noms, saison):
    if saison not in DECALAGE_SAISON:
        return noms
    r = []
    for s in noms:
        r.append(s)
        f = feuillage(s, saison)
        if f:
            r.append(f)
    return r


def lire_tranche(db, sprites, geo, source, saison, budget):
    """Lit au plus `budget` octets nouveaux du releve.

    Retourne (octets lus, lignes, cases changees, tuiles marquees, reste a lire).
    Un fichier dont l'inode change ou qui raccourcit est relu depuis le debut :
    les cases inchangees n'y coutent qu'une comparaison.
    """
    lus = lignes = changees = 0
    sales = set()
    reste = 0
    for chemin in fichiers_source(source):
        try:
            st = os.stat(chemin)
        except OSError:
            continue
        row = db.execute('SELECT ino, pos FROM fichiers WHERE chemin=?', (chemin,)).fetchone()
        pos = row[1] if row and row[0] == st.st_ino and row[1] <= st.st_size else 0
        if pos >= st.st_size:
            continue
        if budget - lus <= 0:
            reste += st.st_size - pos
            continue
        with open(chemin, 'rb') as f:
            f.seek(pos)
            data = f.read(min(budget - lus, st.st_size - pos))
        coupe = data.rfind(b'\n') + 1
        if not coupe:
            # Ligne en cours d'ecriture par l'agent : on la reprendra.
            continue
        tranche = {}
        for ligne in data[:coupe].splitlines():
            if not ligne.strip():
                continue
            lignes += 1
            try:
                e = json.loads(ligne)
                cle = (e['x'], e['y'], e['z'])
                c = 1 if e.get('c') else 0
                prec = tranche.get(cle)
                tranche[cle] = (e['s'], c or (prec[1] if prec else 0))
            except Exception:
                pass                    # ligne tronquee par un arret brutal du jeu
        db.execute('BEGIN')
        for (x, y, z), (noms, c) in tranche.items():
            ids = [sprites.id(n) for n in enrichir(noms, saison)]
            s = ','.join(map(str, ids))
            d, v = x - y, x + y + 2 - DV_Z * z
            old = db.execute('SELECT s, c FROM cases WHERE x=? AND y=? AND z=?', (x, y, z)).fetchone()
            if old and old[0] == s:
                if c and not old[1]:
                    db.execute('UPDATE cases SET c=1 WHERE x=? AND y=? AND z=?', (x, y, z))
                continue
            db.execute('INSERT OR REPLACE INTO cases VALUES (?,?,?,?,?,?,?)',
                       (x, y, z, d, v, s, 1 if (c or (old and old[1])) else 0))
            changees += 1
            sales.update(geo.tuiles_case(d, v, ids, sprites))
            if old and old[0]:
                sales.update(geo.tuiles_case(d, v, [int(i) for i in old[0].split(',')], sprites))
        db.executemany('INSERT OR IGNORE INTO sales VALUES (?,?)', sales)
        db.execute('INSERT OR REPLACE INTO fichiers VALUES (?,?,?)', (chemin, st.st_ino, pos + coupe))
        db.execute('COMMIT')
        # Une tranche ne lit qu'un fichier : le reste attendra la suivante.
        lus += coupe
        reste += st.st_size - pos - coupe
        return lus, lignes, changees, len(sales), total_a_lire(db, source)
    return lus, lignes, changees, 0, reste


def total_a_lire(db, source):
    total = 0
    for chemin in fichiers_source(source):
        try:
            st = os.stat(chemin)
        except OSError:
            continue
        row = db.execute('SELECT ino, pos FROM fichiers WHERE chemin=?', (chemin,)).fetchone()
        pos = row[1] if row and row[0] == st.st_ino and row[1] <= st.st_size else 0
        total += st.st_size - pos
    return total


# --- dessin --------------------------------------------------------------------

class Cache:
    """Sprites decodes, plafonnes en octets (un arbre jumbo pese 3 Mo)."""

    def __init__(self, sprites, textures, plafond):
        self.sprites, self.textures, self.plafond = sprites, textures, plafond
        self.od = collections.OrderedDict()
        self.taille = 0

    def get(self, i):
        if i in self.od:
            self.od.move_to_end(i)
            return self.od[i]
        m = self.sprites.metas.get(i)
        im = None
        if m:
            try:
                chemin = os.path.join(self.textures, m[0], self.sprites.noms[i] + '.png')
                with Image.open(chemin) as f:
                    im = f.convert('RGBA')
            except Exception:
                im = None
        self.od[i] = im
        self.taille += (im.width * im.height * 4) if im else 0
        while self.taille > self.plafond and len(self.od) > 1:
            _, vieux = self.od.popitem(last=False)
            self.taille -= (vieux.width * vieux.height * 4) if vieux else 0
        return im


def dessiner_tuile(db, geo, sprites, cache, tx, ty):
    """Image de la tuile de plein niveau (tx, ty), ou None si elle est vide."""
    T = geo.T
    ox, oy = tx * T, ty * T
    # Cases dont un sprite peut toucher la tuile, d'apres le debordement
    # maximal de tous les sprites connus ; le detail est filtre au dessin.
    d0 = (ox - sprites.d - geo.px0) // GW - 1
    d1 = (ox + T - sprites.g - geo.px0) // GW + 1
    v0 = (oy - sprites.b - geo.py0) // GH - 1
    v1 = (oy + T - sprites.h - geo.py0) // GH + 1
    rows = db.execute('SELECT x, y, z, d, v, s FROM cases WHERE d BETWEEN ? AND ? AND v BETWEEN ? AND ?',
                      (d0, d1, v0, v1)).fetchall()
    if not rows:
        return None
    # Ordre du peintre, le meme que convertir.py : etage, profondeur iso, x.
    rows.sort(key=lambda r: (r[2], r[0] + r[1], r[0]))
    im = Image.new('RGBA', (T, T))
    pose = 0
    for x, y, z, d, v, s in rows:
        if not s:
            continue
        bx = d * GW + geo.px0 - ox
        by = v * GH + geo.py0 - oy
        for i in map(int, s.split(',')):
            m = sprites.metas.get(i)
            if not m:
                continue
            px, py = bx + m[3], by + m[4]
            if px + m[1] <= 0 or py + m[2] <= 0 or px >= T or py >= T:
                continue
            spr = cache.get(i)
            if spr is None:
                continue
            if px < 0 or py < 0 or px + m[1] > T or py + m[2] > T:
                gx0, gy0 = max(0, px), max(0, py)
                sx0, sy0 = gx0 - px, gy0 - py
                sx1, sy1 = min(m[1], T - px), min(m[2], T - py)
                if sx1 <= sx0 or sy1 <= sy0:
                    continue
                im.alpha_composite(spr.crop((sx0, sy0, sx1, sy1)), (gx0, gy0))
            else:
                im.alpha_composite(spr, (px, py))
            pose += 1
    if not pose or not im.getbbox():
        return None
    return im


class Pyramide:
    """Fichiers de tuiles et info.json, mis a jour tuile par tuile."""

    def __init__(self, html, geo):
        self.sortie = os.path.join(html, 'map_data', 'constructions')
        self.geo = geo
        self.chemin_info = os.path.join(self.sortie, 'info.json')
        try:
            with open(self.chemin_info, encoding='utf8') as f:
                self.info = json.load(f)
        except (OSError, ValueError):
            self.info = {}
        b = geo.base
        if (self.info.get('tuile') != geo.T or self.info.get('niveau_max') != geo.nmax
                or self.info.get('x0') != b['x0'] or self.info.get('y0') != b['y0']):
            # Pas de rendu complet, ou geometrie differente : on repart d'une fiche neuve.
            self.info = {'w': geo.W, 'h': geo.H, 'x0': b['x0'], 'y0': b['y0'], 'sqr': b['sqr'],
                         'tuile': geo.T, 'niveau_max': geo.nmax, 'format': 'webp',
                         'tuiles': {}, 'cases': 0, 'genere': time.strftime('%Y-%m-%d %H:%M:%S')}
        self.existants = {int(k): {tuple(t) for t in v} for k, v in self.info.get('tuiles', {}).items()}
        self.versions = {int(k): dict(v) for k, v in self.info.get('versions', {}).items()}

    def chemin(self, niveau, tx, ty):
        return os.path.join(self.sortie, 'layer0_files', str(niveau), '%d_%d.webp' % (tx, ty))

    def existe(self, niveau, tx, ty):
        return (tx, ty) in self.existants.get(niveau, ())

    def poser(self, niveau, tx, ty, im, jeton):
        """Ecrit (ou efface si im est None) une tuile. Retourne les octets ecrits."""
        chemin = self.chemin(niveau, tx, ty)
        ens = self.existants.setdefault(niveau, set())
        vers = self.versions.setdefault(niveau, {})
        cle = '%d_%d' % (tx, ty)
        if im is None:
            if (tx, ty) in ens:
                ens.discard((tx, ty))
                vers.pop(cle, None)
                try:
                    os.remove(chemin)
                except OSError:
                    pass
            return 0
        os.makedirs(os.path.dirname(chemin), exist_ok=True)
        tmp = chemin + '.tmp'
        im.save(tmp, 'WEBP', quality=88, method=4)
        os.replace(tmp, chemin)         # le serveur ne sert jamais une tuile a moitie ecrite
        ens.add((tx, ty))
        vers[cle] = jeton
        return os.path.getsize(chemin)

    def remonter(self, faites, jeton):
        """Recompose les niveaux superieurs au-dessus des tuiles (tx, ty) refaites."""
        T = self.geo.T
        niveau = self.geo.nmax
        octets = 0
        touchees = set(faites)
        while niveau > 0 and touchees:
            parents = {(tx // 2, ty // 2) for tx, ty in touchees}
            enf = self.existants.get(niveau, set())
            sup = niveau - 1
            touchees = set()
            for ptx, pty in parents:
                presents = [(ptx * 2 + a, pty * 2 + b) for a in (0, 1) for b in (0, 1)
                            if (ptx * 2 + a, pty * 2 + b) in enf]
                im = None
                if presents:
                    im = Image.new('RGBA', (T * 2, T * 2))
                    for tx, ty in presents:
                        with Image.open(self.chemin(niveau, tx, ty)) as c:
                            im.alpha_composite(c.convert('RGBA'), ((tx - ptx * 2) * T, (ty - pty * 2) * T))
                    im = im.resize((T, T), Image.LANCZOS)
                    if not im.getbbox():
                        im = None
                if im is None and not self.existe(sup, ptx, pty):
                    continue
                octets += self.poser(sup, ptx, pty, im, jeton)
                touchees.add((ptx, pty))
            niveau = sup
        return octets

    def enregistrer(self, cases):
        self.info['tuiles'] = {str(k): sorted([list(t) for t in v]) for k, v in sorted(self.existants.items()) if v}
        self.info['versions'] = {str(k): v for k, v in sorted(self.versions.items()) if v}
        self.info['cases'] = cases
        self.info['maj'] = time.strftime('%Y-%m-%d %H:%M:%S')
        os.makedirs(self.sortie, exist_ok=True)
        tmp = self.chemin_info + '.tmp'
        with open(tmp, 'w', encoding='utf8') as f:
            json.dump(self.info, f, separators=(',', ':'))
        os.replace(tmp, self.chemin_info)


def position_joueur(source, geo):
    """Tuile de plein niveau sous le joueur, pour servir ses environs d'abord."""
    try:
        with open(os.path.join(source, 'position.json'), encoding='utf8') as f:
            p = json.load(f)
        x, y, z = p['x'], p['y'], p.get('z', 0)
        bx = (x - y) * GW + geo.px0
        by = (x + y + 2 - DV_Z * z) * GH + geo.py0
        return int(bx // geo.T), int(by // geo.T)
    except (OSError, ValueError, KeyError, TypeError):
        return None


def prochain_lot(db, pyr, geo, ou, n):
    """Les n tuiles a refaire en premier : zones jamais rendues, puis pres du joueur."""
    sales = db.execute('SELECT tx, ty FROM sales').fetchall()
    if not sales:
        return [], 0
    px, py = ou or (0, 0)
    sales.sort(key=lambda t: (pyr.existe(geo.nmax, *t), (t[0] - px) ** 2 + (t[1] - py) ** 2))
    return sales[:n], len(sales)


# --- boucle principale --------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--html', default=HTML_DEFAUT, help='dossier out/html de la carte')
    ap.add_argument('--source', default=SOURCE_DEFAUT, help="dossier des releves de l'agent")
    ap.add_argument('--textures', default=TEXTURES_DEFAUT)
    ap.add_argument('--etat', help='dossier de travail (defaut : out/rendu-progressif)')
    ap.add_argument('--saison', default='summer2')
    ap.add_argument('--une-passe', action='store_true', help="s'arreter quand tout est a jour")
    ap.add_argument('--lot', type=int, default=16, help='tuiles par lot (moitie quand le jeu tourne)')
    ap.add_argument('--pause', type=float, default=2, help='secondes de repos entre deux lots')
    ap.add_argument('--facteur-jeu', type=float, default=3,
                    help='multiplie la pause quand le jeu tourne')
    ap.add_argument('--remonter', type=int, default=64,
                    help='tuiles refaites avant de recomposer les niveaux superieurs')
    ap.add_argument('--remonter-delai', type=float, default=120,
                    help='secondes au plus avant de recomposer les niveaux superieurs')
    ap.add_argument('--tranche', type=float, default=8, help='Mo de releve lus par tranche')
    ap.add_argument('--attente', type=float, default=60, help='secondes entre deux verifications du releve')
    ap.add_argument('--memoire-libre', type=float, default=3.0,
                    help='Gio disponibles en dessous desquels on se met en pause')
    ap.add_argument('--pression-memoire', type=float, default=10.0)
    ap.add_argument('--pression-io', type=float, default=40.0)
    ap.add_argument('--cache-sprites', type=float, default=256, help='Mo de sprites decodes gardes')
    ap.add_argument('--premier-import', choices=('tout', 'nouveau'), default='tout',
                    help="au premier import, refaire toutes les tuiles touchees (tout) ou "
                         "seulement celles qui n'existent pas encore (nouveau)")
    ap.add_argument('--reinitialiser', action='store_true', help='oublier la base et tout relire')
    args = ap.parse_args()

    html = os.path.abspath(args.html)
    etat = os.path.abspath(args.etat or os.path.join(html, '..', 'rendu-progressif'))
    os.makedirs(etat, exist_ok=True)

    verrou = open(os.path.join(etat, 'verrou'), 'w')
    try:
        fcntl.flock(verrou, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print('Le rendu progressif tourne deja en fond : les tuiles arrivent toutes seules.')
        return 0

    try:
        os.nice(19)
    except OSError:
        pass
    signal.signal(signal.SIGTERM, demander_arret)
    signal.signal(signal.SIGINT, demander_arret)

    suivi = Suivi(etat)
    base_chemin = os.path.join(etat, 'cases.sqlite')
    if args.reinitialiser:
        for suffixe in ('', '-wal', '-shm'):
            try:
                os.remove(base_chemin + suffixe)
            except OSError:
                pass
    db = ouvrir_base(base_chemin)
    premiere = db.execute("SELECT valeur FROM reglages WHERE cle='saison'").fetchone() is None
    if premiere:
        db.execute("INSERT INTO reglages VALUES ('saison', ?)", (args.saison,))
    elif db.execute("SELECT valeur FROM reglages WHERE cle='saison'").fetchone()[0] != args.saison:
        suivi.log('saison differente de celle de la base : relancer avec --reinitialiser')
        return 2

    geo = Geometrie(html)
    sprites = Sprites(db, args.textures, html)
    cache = Cache(sprites, args.textures, args.cache_sprites * 2**20)
    pyr = Pyramide(html, geo)
    jeton = lambda: format(int(time.time()), 'x')   # noqa: E731

    a_lire = total_a_lire(db, args.source)
    cases = db.execute('SELECT count(*) FROM cases').fetchone()[0]
    suivi.log('demarrage : %d cases en base, %.0f Mo de releve a lire, %d tuiles a refaire'
              % (cases, a_lire / 1e6, db.execute('SELECT count(*) FROM sales').fetchone()[0]))
    lecture = {'total': a_lire, 'lus': 0, 'lignes': 0, 'changees': 0}
    tuiles = {'faites': 0, 'videes': 0, 'restantes': 0, 'octets': 0}
    suivi.ecrire(phase='lecture' if a_lire else 'rendu', lecture=lecture, tuiles=tuiles)
    derniere_verif = time.time()
    derniere_remontee = time.time()
    modifie = False

    def remonter_attente(force=False):
        """Recompose les niveaux superieurs des tuiles refaites, par paquets.

        Chaque niveau coute un encodage WebP par tuile parente : le faire a
        chaque lot revenait a 22 encodages pour 2 tuiles utiles. Groupees, les
        tuiles voisines partagent leurs parents. La liste est en base : un
        arret entre les deux ne perd rien.
        """
        nonlocal derniere_remontee
        attente = db.execute('SELECT tx, ty FROM a_remonter').fetchall()
        if not attente:
            return
        if not force and len(attente) < args.remonter and time.time() - derniere_remontee < args.remonter_delai:
            return
        tuiles['octets'] += pyr.remonter(attente, jeton())
        pyr.enregistrer(cases)
        db.execute('DELETE FROM a_remonter')
        derniere_remontee = time.time()

    while not arret:
        raison = raison_de_pause(args)
        if raison:
            if suivi.e.get('pause') != raison:
                suivi.log('pause : ' + raison)
            suivi.ecrire(pause=raison)
            dormir(15)
            continue
        if suivi.e.get('pause'):
            suivi.log('reprise')
            suivi.ecrire(pause=None)
        jeu = jeu_lance()
        pause = args.pause * (args.facteur_jeu if jeu else 1)

        # 1. Lecture du releve, par tranches.
        lus, lignes, changees, marquees, reste = lire_tranche(
            db, sprites, geo, args.source, args.saison, int(args.tranche * 1e6))
        if lus:
            lecture['lus'] += lus
            lecture['lignes'] += lignes
            lecture['changees'] += changees
            if changees:
                cases = db.execute('SELECT count(*) FROM cases').fetchone()[0]
            lecture['total'] = max(lecture['total'], lecture['lus'] + reste)
            if premiere and args.premier_import == 'nouveau':
                db.execute('BEGIN')
                for tx, ty in db.execute('SELECT tx, ty FROM sales').fetchall():
                    if pyr.existe(geo.nmax, tx, ty):
                        db.execute('DELETE FROM sales WHERE tx=? AND ty=?', (tx, ty))
                db.execute('COMMIT')
            tuiles['restantes'] = db.execute('SELECT count(*) FROM sales').fetchone()[0]
            suivi.ecrire(phase='lecture', lecture=lecture, tuiles=tuiles, jeu=jeu)
            if reste:
                dormir(pause / 4)
                continue
            suivi.log('releve lu : %d lignes, %d cases changees' % (lecture['lignes'], lecture['changees']))
        premiere = False

        # 2. Rendu d'un lot de tuiles.
        n = max(1, args.lot // 2 if jeu else args.lot)
        lot, restantes = prochain_lot(db, pyr, geo, position_joueur(args.source, geo), n)
        if lot:
            tuiles.setdefault('debut', time.time())
            j = jeton()
            t0 = time.time()
            faites = []
            for tx, ty in lot:
                if arret:
                    break
                faites.append((tx, ty))
                im = dessiner_tuile(db, geo, sprites, cache, tx, ty)
                if im is None and pyr.existe(geo.nmax, tx, ty):
                    tuiles['videes'] += 1
                tuiles['octets'] += pyr.poser(geo.nmax, tx, ty, im, j)
                tuiles['faites'] += 1
            # info.json d'abord : une tuile n'est rayee de la liste qu'une fois
            # annoncee au viewer.
            pyr.enregistrer(cases)
            db.execute('BEGIN')
            db.executemany('DELETE FROM sales WHERE tx=? AND ty=?', faites)
            db.executemany('INSERT OR IGNORE INTO a_remonter VALUES (?,?)', faites)
            db.execute('COMMIT')
            tuiles['restantes'] = restantes - len(faites)
            remonter_attente(force=not tuiles['restantes'])
            modifie = True
            suivi.ecrire(phase='rendu', tuiles=tuiles, jeu=jeu, duree_lot=time.time() - t0)
            if args.une_passe:
                print('tuiles : %d faites, %d restantes' % (tuiles['faites'], tuiles['restantes']), flush=True)
            dormir(pause)
            continue

        # 3. Rien a faire.
        remonter_attente(force=True)
        if args.une_passe:
            break
        if modifie:
            suivi.log('a jour : %d tuiles refaites depuis le lancement' % tuiles['faites'])
            modifie = False
        tuiles['restantes'] = 0
        suivi.ecrire(phase='attente', tuiles=tuiles, jeu=jeu)
        dormir(max(0, args.attente - (time.time() - derniere_verif)))
        derniere_verif = time.time()

    if arret:
        suivi.log('arret demande : etat enregistre, reprise au prochain lancement')
    else:
        suivi.log('termine : %d tuiles refaites' % tuiles['faites'])
    suivi.ecrire(phase='arrete' if arret else 'termine')
    db.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
