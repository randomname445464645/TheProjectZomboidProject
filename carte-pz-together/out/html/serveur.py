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
  - GET /api/vehicules renvoie les vehicules que l'agent voit autour du
    joueur (~/Zomboid/pz-export/vehicules.json), et
    GET /api/vehicules?connus=1 tous ceux qu'il a deja vus, tires de son
    journal. Lecture seule, voir vehicules.py.
  - GET /api/vehicules/icone?s=Base.CarNormal&p=0&v=dessus renvoie l'icone
    rendue du modele 3D (v = dessus, 34, ou iso00 a iso31 : vue iso par cap), en cache dans vehicules-icones/.
    Voir icones_vehicules.py.
  - GET /pulse.html sert la page du mod PZ Pulse, lue la ou le mod est
    installe sur ce PC, et /api/pulse/data.txt, heartbeat.txt et lang.txt
    les fichiers qu'elle recharge, tires de ~/Zomboid/pz-export/pulse.json.
    GET /api/pulse renvoie la meme fiche en JSON pour la carte. Lecture
    seule, voir pulse.py.

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

import pulse
import vehicules

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
# Une seule etape : le rendu progressif, en une passe et sous plafonds
# (memoire, CPU, priorite idle), qui ne relit que la fin du releve et ne
# redessine que les tuiles touchees. L'ancien enchainement convertir.py puis
# rendre-calque.py chargeait tout le releve en memoire et occupait 8 coeurs :
# lance pendant une partie, il exposait le jeu a un arret par manque de RAM.
# Il reste disponible a la main pour un rendu complet.
RENDU = os.path.join(PROJET, 'rendu-progressif.sh')
ETAPES = [
    ('tuiles', ['bash', RENDU, 'une-passe']),
]
PYTHON_VENV = os.path.join(PROJET, '.venv', 'bin', 'python')

# La synchronisation peut durer : au premier passage le rendu progressif lit
# tout le releve et refait toutes les tuiles, lentement, par politesse pour le
# jeu. Elle tourne donc en TACHE DE FOND et la page interroge son etat. Une
# requete HTTP ouverte pendant un quart d'heure serait coupee par le
# navigateur bien avant la fin.
_verrou_sync = threading.Lock()
_etat_sync = {'en_cours': False, 'etape': '', 'ligne': '', 'fini': False,
              'ok': None, 'erreur': None, 'depuis': 0}


def _executer_sync():
    python = PYTHON_VENV if os.path.isfile(PYTHON_VENV) else sys.executable
    try:
        for nom, commande in ETAPES:
            if isinstance(commande, str):
                commande = [python, commande]
            script = commande[-1] if commande[0] == python else commande[1]
            if not os.path.isfile(script):
                _etat_sync.update(ok=False, erreur='script introuvable : %s' % script)
                return
            _etat_sync.update(etape=nom, ligne='')
            p = subprocess.Popen(commande, stdout=subprocess.PIPE,
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


# --- rendu progressif en fond ------------------------------------------------
# La case "rendu progressif en fond" de la carte demarre ou arrete le service
# systemd utilisateur lance par rendu-progressif.sh. Le serveur ne fait que
# relayer : les plafonds (memoire, CPU, priorite) sont poses par le script.
UNITE_RENDU = 'pz-carte-rendu'
ETAT_RENDU = os.path.join(PROJET, 'out', 'rendu-progressif', 'etat.json')


def etat_rendu():
    try:
        actif = subprocess.run(['systemctl', '--user', 'is-active', '--quiet', UNITE_RENDU],
                               timeout=5).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        actif = False
    r = {'ok': True, 'actif': actif}
    try:
        with open(ETAT_RENDU, encoding='utf-8') as f:
            e = json.load(f)
        t = e.get('tuiles') or {}
        lec = e.get('lecture') or {}
        r.update(phase=e.get('phase'), pause=e.get('pause'),
                 faites=t.get('faites', 0), restantes=t.get('restantes', 0),
                 lus=lec.get('lus', 0), total=lec.get('total', 0))
    except (OSError, ValueError):
        pass
    return 200, r


def piloter_rendu(actif):
    if not os.path.isfile(RENDU):
        return 500, {'ok': False, 'erreur': 'script introuvable : %s' % RENDU}
    try:
        p = subprocess.run(['bash', RENDU, 'demarrer' if actif else 'arreter'],
                           capture_output=True, text=True, timeout=120)
    except (OSError, subprocess.TimeoutExpired) as e:
        return 500, {'ok': False, 'erreur': str(e)}
    if p.returncode != 0:
        return 500, {'ok': False, 'erreur': (p.stderr or p.stdout).strip()[-300:] or 'echec'}
    return etat_rendu()


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

    def meme_origine(self):
        """Vrai si la requete vient d'une page de la carte elle-meme.

        Les fichiers de PZ Pulse sont charges par balise <script>, qui ne peut
        pas porter d'en-tete X-Carte. Sans autre garde, n'importe quel site
        ouvert dans le navigateur pourrait les inclure et lire la fiche du
        personnage. Les navigateurs indiquent l'origine de chaque requete dans
        Sec-Fetch-Site ; a defaut, on se rabat sur Referer.
        """
        site = self.headers.get('Sec-Fetch-Site')
        if site is not None:
            return site in ('same-origin', 'none')
        ref = self.headers.get('Referer') or ''
        hote = self.headers.get('Host') or ''
        return bool(hote) and ref.startswith('http://%s/' % hote)

    def repondre_texte(self, code, texte, type_mime):
        corps = texte.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', type_mime)
        self.send_header('Content-Length', str(len(corps)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(corps)

    def servir_pulse(self, chemin):
        if chemin in ('/pulse', '/pulse/', '/pulse.html'):
            # La page du mod trouve ses donnees grace a ?d=, qu'elle lit dans
            # l'URL : on l'ajoute si on arrive sans.
            if 'd=' not in self.path.split('?', 1)[-1] or chemin != '/pulse.html':
                self.send_response(302)
                self.send_header('Location', '/pulse.html?d=/api/pulse/')
                self.send_header('Content-Length', '0')
                self.end_headers()
                return
            p = pulse.page()
            if not p:
                self.repondre_texte(404, pulse.page_absente(), 'text/html; charset=utf-8')
                return
            with open(p, encoding='utf-8') as f:
                self.repondre_texte(200, f.read(), 'text/html; charset=utf-8')
            return
        if chemin == '/api/pulse':
            if self.headers.get('X-Carte') != 'pulse':
                self.send_error(403, 'en-tete X-Carte manquant')
                return
            self.repondre_json(*pulse.lire())
            return
        if not self.meme_origine():
            self.send_error(403, 'reserve aux pages de la carte')
            return
        nom = chemin[len('/api/pulse/'):]
        texte = {'data.txt': pulse.data, 'heartbeat.txt': pulse.heartbeat,
                 'lang.txt': pulse.langue}.get(nom, lambda: None)()
        if texte is None:
            # Comme le fichier absent du mod : la page sait l'interpreter.
            self.send_error(404)
            return
        self.repondre_texte(200, texte, 'text/javascript; charset=utf-8')

    def do_GET(self):
        chemin = self.path.split('?', 1)[0]
        if chemin in ('/pulse', '/pulse/', '/pulse.html', '/api/pulse') or chemin.startswith('/api/pulse/'):
            self.servir_pulse(chemin)
            return
        if self.path.split('?', 1)[0] == '/api/traces':
            if self.headers.get('X-Carte') != 'traces':
                self.send_error(403, 'en-tete X-Carte manquant')
                return
            from urllib.parse import parse_qs, urlsplit
            q = parse_qs(urlsplit(self.path).query)
            jour = (q.get('jour') or [None])[0]
            self.repondre_json(*(lire_jour(jour) if jour else lister_jours()))
            return
        if self.path.split('?', 1)[0] == '/api/vehicules/icone':
            if self.headers.get('X-Carte') != 'vehicules':
                self.send_error(403, 'en-tete X-Carte manquant')
                return
            from urllib.parse import parse_qs, urlsplit
            q = parse_qs(urlsplit(self.path).query)
            chemin, info = vehicules.icone((q.get('s') or [''])[0], (q.get('p') or ['0'])[0],
                                           (q.get('v') or ['dessus'])[0])
            if not chemin:
                self.repondre_json(404, {'ok': False, 'erreur': info})
                return
            with open(chemin, 'rb') as f:
                corps = f.read()
            self.send_response(200)
            self.send_header('Content-Type', 'image/png')
            self.send_header('Content-Length', str(len(corps)))
            self.send_header('X-Longueur', str(info.get('longueur', '')))
            self.send_header('X-Largeur', str(info.get('largeur', '')))
            self.send_header('X-Peaux', str(info.get('peaux', '')))
            if info.get('ancre'):
                self.send_header('X-Ancre', '%s,%s' % tuple(info['ancre']))
                self.send_header('X-Echelle', str(info.get('echelle', '')))
            self.end_headers()
            self.wfile.write(corps)
            return
        if self.path.split('?', 1)[0] == '/api/vehicules':
            if self.headers.get('X-Carte') != 'vehicules':
                self.send_error(403, 'en-tete X-Carte manquant')
                return
            connus = 'connus=1' in self.path.split('?', 1)[-1]
            self.repondre_json(*(vehicules.lire_connus() if connus else vehicules.lire_direct()))
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
        if self.path.split('?', 1)[0] == '/api/rendu':
            if self.headers.get('X-Carte') != 'rendu':
                self.send_error(403, 'en-tete X-Carte manquant')
                return
            self.repondre_json(*etat_rendu())
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
        if chemin == '/api/rendu':
            # Meme garde que la synchronisation, avec son propre en-tete.
            if self.headers.get('X-Carte') != 'rendu':
                self.send_error(403, 'en-tete X-Carte manquant')
                return
            try:
                n = int(self.headers.get('Content-Length') or 0)
                actif = bool(json.loads(self.rfile.read(min(n, 1024)) or b'{}').get('actif'))
            except (ValueError, AttributeError):
                self.repondre_json(400, {'ok': False, 'erreur': 'corps JSON attendu : {"actif": true}'})
                return
            self.repondre_json(*piloter_rendu(actif))
            return
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
