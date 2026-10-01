"""Vehicules pour la carte : ce que l'agent voit en direct, et ce qu'il a vu.

Trois sources, toutes en lecture seule :

  vehicules.json            ecrit par l'agent toutes les 5 s : les vehicules de
                            la zone chargee autour du joueur, avec leur fiche.
  vehicules/AAAA-MM-JJ.ndjson
                            le journal de l'agent, un evenement par ligne
                            (apparition, modification, deplacement, presence,
                            fin). On en tire la premiere et la derniere fois
                            que chaque vehicule a ete vu.
  vehicles.db               la base du CLIENT dans la sauvegarde multijoueur.
                            Le jeu y range les vehicules qu'il a recus, avec
                            leur position, mais il ne la met pas a jour en
                            continu. Elle sert d'amorce : des vehicules connus
                            avant que l'agent ne les releve. Seuls la position
                            et le modele en sont tires ; le reste du blob est
                            la serialisation Java du vehicule, sans format
                            publie.

Le journal est lu par increments : on garde, par fichier, l'octet ou l'on
s'est arrete, et on ne relit que la suite. Une ligne incomplete (l'agent est
en train de l'ecrire) est laissee pour la fois suivante.
"""

import glob
import json
import os
import re
import sqlite3
import struct
import threading
import time

EXPORT = os.path.expanduser('~/Zomboid/pz-export')
DIRECT = os.environ.get('PZCARTE_VEHICULES') or os.path.join(EXPORT, 'vehicules.json')
JOURNAL = os.environ.get('PZCARTE_VEHICULES_JOURNAL') or os.path.join(EXPORT, 'vehicules')
SAUVEGARDES = os.path.expanduser('~/Zomboid/Saves/Multiplayer')
JEU = os.environ.get('PZCARTE_JEU') or os.path.expanduser(
    '~/.local/share/Steam/steamapps/common/ProjectZomboid/projectzomboid')
ATELIER = os.environ.get('PZCARTE_ATELIER') or os.path.expanduser(
    '~/.local/share/Steam/steamapps/workshop/content/108600')

# Revu apres plus de ce delai sans nouvelle : c'est un nouveau passage. En
# dessous, c'est le meme (changement de jour du journal, agent relance).
NOUVEAU_PASSAGE = 15 * 60 * 1000   # ms
# Lieux distincts ou un vehicule a ete vu : au-dela de cette distance d'un
# lieu deja note. Bornes en nombre, un vehicule conduit des heures en ferait
# des centaines.
ECART_LIEU = 30
MAX_LIEUX = 20
FORMAT_JOUR = re.compile(r'^\d{4}-\d{2}-\d{2}\.ndjson$')


def lire_direct():
    """(code, reponse) : les vehicules autour du joueur, et l'age du releve."""
    try:
        with open(DIRECT, encoding='utf-8') as f:
            d = json.load(f)
    except FileNotFoundError:
        return 404, {'ok': False, 'erreur': "aucun releve de vehicules : agent sans le releve, "
                                            "ou jeu pas relance depuis sa mise a jour"}
    except (OSError, ValueError) as e:
        return 503, {'ok': False, 'erreur': 'releve illisible : %s' % e}
    t = d.get('t')
    age = (time.time() * 1000 - t) / 1000 if isinstance(t, (int, float)) else None
    return 200, {'ok': True, 'age': age, **d}


# --- journal -----------------------------------------------------------------

_verrou = threading.Lock()
_lus = {}        # fichier -> octets deja integres
_fiches = {}     # cle -> fiche agregee


def _integrer(e):
    k = e.get('k') or (e.get('v') or {}).get('k')
    t = e.get('t')
    if not k or not isinstance(t, (int, float)):
        return
    v = e.get('v')
    x = v.get('x') if v else e.get('x')
    y = v.get('y') if v else e.get('y')
    vu = {'t': t, 'h': e.get('h'), 'x': x, 'y': y}
    f = _fiches.get(k)
    if f is None:
        f = _fiches[k] = {'k': k, 'premier': vu, 'dernier': vu, 'passages': 1,
                          'fiche': None, 'lieux': [], 'parti': False}
    elif e['e'] == 'a' and t - f['dernier']['t'] > NOUVEAU_PASSAGE:
        f['passages'] += 1
    if t >= f['dernier']['t']:
        f['dernier'] = vu
        f['parti'] = e['e'] == 'f'
    if t < f['premier']['t']:
        f['premier'] = vu
    if v:
        f['fiche'] = v
    if isinstance(x, (int, float)) and isinstance(y, (int, float)):
        lieux = f['lieux']
        if all((x - l[0]) ** 2 + (y - l[1]) ** 2 >= ECART_LIEU ** 2 for l in lieux):
            lieux.append([round(x), round(y), t])
            if len(lieux) > MAX_LIEUX:
                del lieux[1]   # on garde le tout premier lieu


def _lire_journal():
    if not os.path.isdir(JOURNAL):
        return
    for nom in sorted(os.listdir(JOURNAL)):
        if not FORMAT_JOUR.match(nom):
            continue
        chemin = os.path.join(JOURNAL, nom)
        try:
            taille = os.path.getsize(chemin)
        except OSError:
            continue
        deja = _lus.get(chemin, 0)
        if taille < deja:          # fichier remplace : on le reprend
            deja = 0
        if taille == deja:
            continue
        with open(chemin, 'rb') as f:
            f.seek(deja)
            bloc = f.read(taille - deja)
        fin = bloc.rfind(b'\n') + 1    # ligne incomplete : pour la prochaine fois
        for ligne in bloc[:fin].splitlines():
            try:
                e = json.loads(ligne)
                if isinstance(e, dict) and e.get('e') in ('a', 'm', 'd', 'p', 'f'):
                    _integrer(e)
            except ValueError:
                pass
        _lus[chemin] = deja + fin


# --- amorce : vehicles.db de la sauvegarde -----------------------------------

_amorce = {'chemin': None, 'mtime': None, 'liste': []}
# Le nom du script est la premiere chaine "Module.Nom" ecrite avec sa longueur
# (2 octets, gros-boutiste) dans le blob. Avant lui ne viennent que les
# moddata, dont les cles commencent par une minuscule ou portent un "|".
SCRIPT = re.compile(rb'[A-Z][A-Za-z0-9_]*\.[A-Za-z0-9_]+')


def chemin_sauvegarde():
    """La sauvegarde multijoueur jouee le plus recemment, ou celle imposee."""
    impose = os.environ.get('PZCARTE_SAUVEGARDE')
    if impose:
        return os.path.join(impose, 'vehicles.db')
    meilleur, date = None, 0
    for d in glob.glob(os.path.join(SAUVEGARDES, '*')):
        if d.endswith('_crash') or not os.path.isfile(os.path.join(d, 'vehicles.db')):
            continue
        # map_symbols.bin et InGameMap.ini sont reecrits a chaque session.
        m = max((os.path.getmtime(os.path.join(d, f)) for f in ('InGameMap.ini', 'map_symbols.bin', 'vehicles.db')
                 if os.path.exists(os.path.join(d, f))), default=0)
        if m > date:
            meilleur, date = d, m
    return os.path.join(meilleur, 'vehicles.db') if meilleur else None


def script_du_blob(blob):
    for m in SCRIPT.finditer(blob):
        s = m.start()
        if s >= 2 and struct.unpack('>H', blob[s - 2:s])[0] == len(m.group()):
            return m.group().decode('ascii')
    return None


def _lire_amorce():
    chemin = chemin_sauvegarde()
    if not chemin or not os.path.isfile(chemin):
        _amorce.update(chemin=None, mtime=None, liste=[])
        return
    mtime = os.path.getmtime(chemin)
    if chemin == _amorce['chemin'] and mtime == _amorce['mtime']:
        return
    liste = []
    try:
        # immutable=1 : aucun verrou pose, aucun fichier -journal cree. Le jeu
        # peut ecrire la base pendant ce temps, on lirait au pire un etat
        # intermediaire, relu a la prochaine modification.
        c = sqlite3.connect('file:%s?mode=ro&immutable=1' % chemin, uri=True)
        try:
            for i, x, y, blob in c.execute('SELECT id, x, y, data FROM vehicles'):
                if x is None or y is None:
                    continue
                s = script_du_blob(blob or b'')
                liste.append({'k': 'db%d' % i, 's': s, 'n': nom_vehicule(s),
                              'x': round(x, 1), 'y': round(y, 1)})
        finally:
            c.close()
    except sqlite3.Error:
        liste = []
    _amorce.update(chemin=chemin, mtime=mtime, liste=liste)


# --- noms des vehicules ------------------------------------------------------

_noms = None


def _charger_noms():
    """IGUI_VehicleName* en francais, a defaut en anglais : jeu puis mods."""
    noms = {'FR': {}, 'EN': {}}
    motif = re.compile(r'"?IGUI_VehicleName([A-Za-z0-9_]+)"?\s*[:=]\s*"([^"]*)"')
    fichiers = []
    for langue in ('EN', 'FR'):
        fichiers.append((langue, os.path.join(JEU, 'media/lua/shared/Translate', langue, 'IG_UI.json')))
        for f in glob.glob(os.path.join(ATELIER, '*/mods/*/**/Translate/%s/IG_UI*' % langue), recursive=True):
            fichiers.append((langue, f))
    for langue, f in fichiers:
        try:
            brut = open(f, 'rb').read()
        except OSError:
            continue
        try:
            texte = brut.decode('utf-8')
        except UnicodeDecodeError:
            texte = brut.decode('cp1252', errors='replace')
        for m in motif.finditer(texte):
            noms[langue].setdefault(m.group(1), m.group(2))
    return noms


def nom_vehicule(script):
    global _noms
    if not script:
        return None
    if _noms is None:
        _noms = _charger_noms()
    court = script.split('.', 1)[-1]
    # Les declinaisons (StepVan_Propane) n'ont souvent pas de nom propre : le
    # jeu prend alors celui du modele de base (carModelName = StepVan).
    for c in (court, court.split('_', 1)[0]):
        n = _noms['FR'].get(c) or _noms['EN'].get(c)
        if n:
            return n
    return None


# --- reponse -----------------------------------------------------------------

def lire_connus():
    """(code, reponse) : tout ce qui a ete vu, journal puis amorce."""
    with _verrou:
        try:
            _lire_journal()
        except OSError as e:
            return 503, {'ok': False, 'erreur': 'journal illisible : %s' % e}
        _lire_amorce()
        connus = list(_fiches.values())
        # Un vehicule de l'amorce deja releve par l'agent (meme modele, a
        # quelques cases) ne s'affiche qu'une fois, avec les donnees de l'agent.
        # Grille de 10 cases : la comparaison reste lineaire quel que soit le
        # nombre de vehicules connus.
        vus = set()
        for f in connus:
            s = f['fiche'] and f['fiche'].get('s')
            for l in f['lieux']:
                vus.add((s, l[0] // 10, l[1] // 10))
        amorce = []
        for a in _amorce['liste']:
            gx, gy = int(a['x']) // 10, int(a['y']) // 10
            if not any((a['s'], gx + i, gy + j) in vus for i in (-1, 0, 1) for j in (-1, 0, 1)):
                amorce.append(a)
        return 200, {
            'ok': True,
            'connus': connus,
            'amorce': amorce,
            'amorce_source': _amorce['chemin'],
            'amorce_date': int(_amorce['mtime'] * 1000) if _amorce['mtime'] else None,
        }
