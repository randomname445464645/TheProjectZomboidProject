"""Vehicules pour la carte : ce que l'agent voit en direct, et ce qu'il a vu.

Deux sources, en lecture seule, toutes deux ecrites par l'agent :

  vehicules.json            ecrit par l'agent toutes les 5 s : les vehicules de
                            la zone chargee autour du joueur, avec leur fiche.
  vehicules/AAAA-MM-JJ.ndjson
                            le journal de l'agent, un evenement par ligne
                            (apparition, modification, deplacement, presence,
                            fin). On en tire la premiere et la derniere fois
                            que chaque vehicule a ete vu.

vehicles.db, la base que le client tient dans la sauvegarde, n'est PAS lue :
le jeu ne la met pas a jour en continu, ses positions etaient fausses.

Le journal est lu par increments : on garde, par fichier, l'octet ou l'on
s'est arrete, et on ne relit que la suite. Une ligne incomplete (l'agent est
en train de l'ecrire) est laissee pour la fois suivante.
"""

import json
import os
import re
import threading
import time

EXPORT = os.path.expanduser('~/Zomboid/pz-export')
DIRECT = os.environ.get('PZCARTE_VEHICULES') or os.path.join(EXPORT, 'vehicules.json')
JOURNAL = os.environ.get('PZCARTE_VEHICULES_JOURNAL') or os.path.join(EXPORT, 'vehicules')

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


# --- reponse -----------------------------------------------------------------

def lire_connus():
    """(code, reponse) : tout ce que l'agent a deja vu, tire de son journal."""
    with _verrou:
        try:
            _lire_journal()
        except OSError as e:
            return 503, {'ok': False, 'erreur': 'journal illisible : %s' % e}
        return 200, {'ok': True, 'connus': list(_fiches.values())}


# --- icones ------------------------------------------------------------------
# Rendu des modeles 3D, voir icones_vehicules.py. Il demande numpy et Pillow :
# sans eux, la carte garde ses carres.
try:
    import icones_vehicules
except ImportError:
    icones_vehicules = None


def icone(script, peau, vue):
    """(chemin du PNG, mesures) ou (None, raison)."""
    if icones_vehicules is None:
        return None, 'numpy ou Pillow absent : pas de rendu des vehicules'
    try:
        peau = int(peau)
    except (TypeError, ValueError):
        peau = 0
    chemin = icones_vehicules.icone(script or '', peau, vue or 'dessus')
    if not chemin:
        return None, 'pas de modele pour ce vehicule'
    return chemin, icones_vehicules.mesures(chemin)
