#!/usr/bin/env python3
"""Serveur de la carte PZ together.

La carte est statique a deux exceptions pres :
  - POST /api/sync relance le convertisseur du releve de l'agent d'export,
    pour rafraichir le calque des constructions sans passer par un terminal ;
  - GET /api/position renvoie la position du joueur, que l'agent ecrit chaque
    seconde dans ~/Zomboid/pz-export/position.json. Lecture seule.
  - GET /api/traces liste les jours de deplacements enregistres par l'agent
    (~/Zomboid/pz-export/traces/AAAA-MM-JJ.ndjson), et
    GET /api/traces?jour=AAAA-MM-JJ renvoie les points d'un jour. Lecture
    seule.

Rien d'autre n'a besoin de flask ni de waitress, la bibliotheque standard
suffit.

server.py (le serveur de pzmap2dzi, avec ses routes de trimming) reste en
place et intact ; il n'est simplement plus necessaire pour la carte.
"""

import json
import os
import re
import subprocess
import sys
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

# Reglables pour lancer une instance de test a cote de la vraie, sans
# toucher a la position que l'agent du jeu ecrit.
PORT = int(os.environ.get('PZCARTE_PORT', 8880))
RACINE = os.path.dirname(os.path.realpath(__file__))

# Les tuiles et les icones ne changent jamais : cache long.
# Le code de la carte change a chaque retouche : jamais de cache.
CACHE_LONG = ('.webp', '.png', '.jpg')
SANS_CACHE = ('.html', '.js', '.css', '.json', '.dzi', '.webmanifest')


# --- position du joueur -----------------------------------------------------

POSITION = os.environ.get('PZCARTE_POSITION') or os.path.expanduser('~/Zomboid/pz-export/position.json')


def lire_position():
    """(code, reponse) : la derniere position ecrite par l'agent, et son age.

    L'age vient de l'horodatage ecrit par l'agent, pas de la date du fichier :
    c'est l'heure a laquelle la position a ete LUE dans le jeu. Au-dela de
    quelques secondes, le jeu est ferme, en pause dans un menu, ou l'agent
    n'est pas charge ; la carte l'affiche au lieu de suivre un fantome.
    """
    try:
        with open(POSITION, encoding='utf-8') as f:
            pos = json.load(f)
    except FileNotFoundError:
        return 404, {'ok': False, 'erreur': "aucune position : jeu jamais lance avec l'agent"}
    except (OSError, ValueError) as e:
        return 503, {'ok': False, 'erreur': 'position illisible : %s' % e}
    t = pos.get('t')
    age = (time.time() * 1000 - t) / 1000 if isinstance(t, (int, float)) else None
    return 200, {'ok': True, 'age': age, **pos}


# --- traces des deplacements -------------------------------------------------

TRACES = os.environ.get('PZCARTE_TRACES') or os.path.expanduser('~/Zomboid/pz-export/traces')
# Le jour arrive de la requete : seul ce format exact est accepte, ce qui
# interdit de remonter dans l'arborescence avec des ../
FORMAT_JOUR = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def lister_jours():
    """Jours enregistres, du plus recent au plus ancien, avec leur taille.

    Pas de comptage des points ici : il faudrait relire chaque fichier, et
    des mois de jeu en feraient beaucoup. La taille suffit a choisir.
    """
    if not os.path.isdir(TRACES):
        return 200, {'ok': True, 'jours': []}
    jours = []
    for f in os.listdir(TRACES):
        j = f[:-7] if f.endswith('.ndjson') else ''
        if FORMAT_JOUR.match(j):
            jours.append({'jour': j, 'octets': os.path.getsize(os.path.join(TRACES, f))})
    jours.sort(key=lambda d: d['jour'], reverse=True)
    return 200, {'ok': True, 'jours': jours}


def lire_jour(jour):
    """Points d'un jour, en tableaux compacts [t, joueur, x, y, z, v].

    Une ligne illisible est sautee : l'agent peut etre en train d'ecrire la
    derniere au moment de la lecture.
    """
    if not FORMAT_JOUR.match(jour or ''):
        return 400, {'ok': False, 'erreur': 'jour attendu au format AAAA-MM-JJ'}
    chemin = os.path.join(TRACES, jour + '.ndjson')
    if not os.path.isfile(chemin):
        return 404, {'ok': False, 'erreur': 'aucun deplacement enregistre ce jour-la'}
    joueurs, index, points, sautees = [], {}, [], 0
    with open(chemin, encoding='utf-8', errors='replace') as f:
        for ligne in f:
            try:
                d = json.loads(ligne)
                cle = d['id']
                if cle not in index:
                    index[cle] = len(joueurs)
                    joueurs.append({'id': cle, 'n': d.get('n')})
                elif d.get('n') and not joueurs[index[cle]]['n']:
                    joueurs[index[cle]]['n'] = d['n']
                points.append([d['t'], index[cle], d['x'], d['y'], d.get('z', 0), d.get('v', 0)])
            except (ValueError, KeyError, TypeError):
                sautees += 1
    return 200, {'ok': True, 'jour': jour, 'joueurs': joueurs, 'points': points,
                 'lignes_sautees': sautees}


# --- synchronisation du releve de l'agent -----------------------------------
# Le convertisseur a besoin de Pillow, donc du python de l'environnement
# virtuel du projet, pas de celui du systeme.
PROJET = os.path.normpath(os.path.join(RACINE, '..', '..'))
OUTILS = os.path.join(PROJET, 'outils', 'agent-monde')
ETAPES = [
    ('releve', os.path.join(OUTILS, 'convertir.py')),
    ('tuiles', os.path.join(OUTILS, 'rendre-calque.py')),
]
PYTHON_VENV = os.path.join(PROJET, '.venv', 'bin', 'python')

# La synchronisation dure une quinzaine de minutes : le calcul des tuiles est
# long. Elle tourne donc en TACHE DE FOND et la page interroge son etat. Une
# requete HTTP ouverte pendant un quart d'heure serait coupee par le
# navigateur bien avant la fin.
_verrou_sync = threading.Lock()
_etat_sync = {'en_cours': False, 'etape': '', 'ligne': '', 'fini': False,
              'ok': None, 'erreur': None, 'depuis': 0}


def _executer_sync():
    python = PYTHON_VENV if os.path.isfile(PYTHON_VENV) else sys.executable
    try:
        for nom, script in ETAPES:
            if not os.path.isfile(script):
                _etat_sync.update(ok=False, erreur='script introuvable : %s' % script)
                return
            _etat_sync.update(etape=nom, ligne='')
            p = subprocess.Popen([python, script], stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, text=True, bufsize=1)
            derniere = ''
            for ligne in p.stdout:
                ligne = ligne.strip()
                if ligne and 'RuntimeWarning' not in ligne and 'sys.prefix' not in ligne:
                    derniere = ligne
                    _etat_sync['ligne'] = ligne
            p.wait()
            if p.returncode != 0:
                _etat_sync.update(ok=False, erreur='%s : %s' % (nom, derniere or 'echec'))
                return
        _etat_sync.update(ok=True, erreur=None)
    except Exception as e:
        _etat_sync.update(ok=False, erreur=str(e))
    finally:
        _etat_sync.update(en_cours=False, fini=True)
        _verrou_sync.release()


def demarrer_sync():
    if not _verrou_sync.acquire(blocking=False):
        return 409, {'ok': False, 'erreur': 'une synchronisation est deja en cours'}
    _etat_sync.update(en_cours=True, etape='', ligne='', fini=False,
                      ok=None, erreur=None, depuis=time.time())
    threading.Thread(target=_executer_sync, daemon=True).start()
    return 202, {'ok': True, 'demarre': True}


def etat_sync():
    e = dict(_etat_sync)
    e['secondes'] = int(time.time() - e['depuis']) if e['depuis'] else 0
    return 200, e


class Handler(SimpleHTTPRequestHandler):
    # HTTP/1.1 : connexions persistantes. Indispensable quand une vue charge
    # des dizaines de tuiles, et exige par certains navigateurs pour accepter
    # un service worker. La taille est toujours annoncee pour les fichiers,
    # la condition de HTTP/1.1 est donc remplie.
    protocol_version = 'HTTP/1.1'

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=RACINE, **kwargs)

    def end_headers(self):
        chemin = self.path.split('?', 1)[0].lower()
        if chemin.endswith(CACHE_LONG):
            self.send_header('Cache-Control', 'public, max-age=604800')
        elif chemin.endswith(SANS_CACHE):
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def do_GET(self):
        if self.path.split('?', 1)[0] == '/api/traces':
            if self.headers.get('X-Carte') != 'traces':
                self.send_error(403, 'en-tete X-Carte manquant')
                return
            from urllib.parse import parse_qs, urlsplit
            q = parse_qs(urlsplit(self.path).query)
            jour = (q.get('jour') or [None])[0]
            self.repondre_json(*(lire_jour(jour) if jour else lister_jours()))
            return
        if self.path.split('?', 1)[0] == '/api/position':
            # Meme garde que /api/sync : sans l'en-tete, une page d'une autre
            # origine ne peut pas lire ta position (il faudrait une requete
            # preliminaire, a laquelle le serveur ne repond pas).
            if self.headers.get('X-Carte') != 'position':
                self.send_error(403, 'en-tete X-Carte manquant')
                return
            self.repondre_json(*lire_position())
            return
        if self.path.split('?', 1)[0] == '/api/sync':
            if self.headers.get('X-Carte') != 'sync':
                self.send_error(403, 'en-tete X-Carte manquant')
                return
            self.repondre_json(*etat_sync())
            return
        super().do_GET()

    def repondre_json(self, code, reponse):
        corps = json.dumps(reponse).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(corps)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(corps)

    def do_POST(self):
        chemin = self.path.split('?', 1)[0]
        if chemin != '/api/sync':
            self.send_error(404)
            return
        # Un en-tete non standard ne peut pas etre pose par une page d'une
        # autre origine sans requete preliminaire, a laquelle on ne repond
        # pas. Cela suffit a empecher un site tiers de declencher la
        # synchronisation a ton insu.
        if self.headers.get('X-Carte') != 'sync':
            self.send_error(403, 'en-tete X-Carte manquant')
            return

        self.repondre_json(*demarrer_sync())

    def log_message(self, fmt, *args):
        # On ne veut voir que les erreurs, pas les 5000 tuiles servies.
        code = args[1] if len(args) > 1 else ''
        if str(code).startswith(('4', '5')):
            sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))


Handler.extensions_map.setdefault('.webp', 'image/webp')
# Sans ce type MIME, Chrome ignore le manifeste et refuse d'installer la PWA.
Handler.extensions_map.setdefault('.webmanifest', 'application/manifest+json')
Handler.extensions_map.setdefault('.dzi', 'application/xml')

if __name__ == '__main__':
    serveur = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print('Carte servie sur http://127.0.0.1:%d/carte.html' % PORT)
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        pass
