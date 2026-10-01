"""Fiche du personnage facon PZ Pulse, nourrie par l'agent du jeu.

PZ Pulse (mod Workshop) ecrit l'etat du personnage dans
Zomboid/Lua/PZ_Pulse/data.txt et heartbeat.txt, que sa page web recharge par
balises <script>. Le mod n'est pas sur le serveur : l'agent Java refait ses
collecteurs (voir outils/agent-monde/src/pzexport/Pulse.java) et ecrit
~/Zomboid/pz-export/pulse.json. Ce module en tire les deux fichiers que la
page du mod attend, au meme format :

    data.txt       window.PZ_DATA = {...};  window.PZ_DATA.seq = n;
    heartbeat.txt  window.PZ_BEAT = {beat, seq, interval, state, ...};

La page elle-meme n'est PAS copiee dans ce depot : c'est le travail de
l'auteur du mod. Elle est lue la ou le mod est installe sur cette machine
(dossier mods/ ou Workshop), et servie telle quelle.
"""

import glob
import json
import os
import time

PULSE = os.environ.get('PZCARTE_PULSE') or os.path.expanduser('~/Zomboid/pz-export/pulse.json')

# Ou chercher la page du mod, dans l'ordre. Le chemin "42/media/web" est celui
# de la version 1.0.0 du mod (build 42.20 et suivants).
PAGES = [
    os.environ.get('PZCARTE_PULSE_PAGE', ''),
    os.path.expanduser('~/Zomboid/mods/PZ_Pulse/42/media/web/index.html'),
    os.path.expanduser('~/Zomboid/Workshop/PZ_Pulse/Contents/mods/PZ_Pulse/42/media/web/index.html'),
] + sorted(glob.glob(os.path.expanduser(
    '~/.local/share/Steam/steamapps/workshop/content/108600/*/mods/PZ_Pulse/42/media/web/index.html')))

# Traductions de la page, ecrites par le mod quand il a tourne en solo. Sans
# elles la page reste en anglais ; les valeurs venant du jeu (noms des
# parties du corps, humeurs, competences) sont de toute facon en francais.
LANGUE = os.path.expanduser('~/Zomboid/Lua/PZ_Pulse/lang.txt')

# Au-dela, le jeu est ferme ou l'agent absent : le pouls cesse d'avancer et la
# page affiche d'elle-meme "pas de signal".
FRAICHEUR = 6.0


def page():
    """Chemin de la page du mod, ou None s'il n'est installe nulle part."""
    for p in PAGES:
        if p and os.path.isfile(p):
            return p
    return None


def lire():
    """(code, dict) : pulse.json et son age en secondes."""
    try:
        with open(PULSE, encoding='utf-8') as f:
            d = json.load(f)
    except FileNotFoundError:
        return 404, {'ok': False, 'erreur': "aucune fiche : jeu jamais lance avec l'agent a jour"}
    except (OSError, ValueError) as e:
        return 503, {'ok': False, 'erreur': 'fiche illisible : %s' % e}
    t = d.get('t')
    d['age'] = (time.time() * 1000 - t) / 1000 if isinstance(t, (int, float)) else None
    d['ok'] = True
    return 200, d


def heartbeat():
    """Contenu de heartbeat.txt.

    Le pouls ("beat") doit avancer tant que le jeu tourne et se figer quand il
    s'arrete : la page compare deux lectures successives. Il est donc calcule
    sur l'horloge du serveur quand la fiche est fraiche, et fige sur l'heure
    de la fiche sinon. Sans fiche du tout, aucun pouls : la page dit "pas de
    signal".
    """
    code, d = lire()
    if code != 200:
        return None
    intervalle = int(d.get('interval') or 1000)
    frais = d['age'] is not None and d['age'] < FRAICHEUR
    beat = int(time.time() * 1000 // intervalle) if frais else int(d['t'] // intervalle)
    etat = d.get('etat') or 'nochar'
    return ('window.PZ_BEAT = {beat:%d,seq:%d,interval:%d,state:%s,mp:"client"};\n'
            % (beat, int(d.get('seq') or 0), intervalle, json.dumps(etat)))


def data():
    """Contenu de data.txt, ou None hors partie."""
    code, d = lire()
    if code != 200 or not isinstance(d.get('data'), dict):
        return None
    # "</" ne peut pas apparaitre : l'agent echappe deja "<".
    corps = json.dumps(d['data'], ensure_ascii=False, separators=(',', ':'))
    return 'window.PZ_DATA = %s;\nwindow.PZ_DATA.seq = %d;\n' % (corps, int(d.get('seq') or 0))


def langue():
    try:
        with open(LANGUE, encoding='utf-8') as f:
            s = f.read()
        if s.startswith('window.PZ_LANG'):
            return s
    except OSError:
        pass
    return 'window.PZ_LANG={lang:"EN",s:{}};\n'


ABSENTE = """<!doctype html><html lang="fr"><meta charset="utf-8">
<title>PZ Pulse introuvable</title>
<style>body{background:#14161a;color:#e6e8ec;font:14px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px}
code{background:#1d2026;padding:1px 5px;border-radius:3px}</style>
<h1>PZ Pulse n'est pas installe sur ce PC</h1>
<p>La fiche du personnage reprend la page du mod <b>PZ Pulse</b> (Workshop),
sans la copier. Il suffit que le mod soit telecharge sur ce PC, meme s'il n'est
active sur aucun serveur : abonne-toi au mod sur le Workshop, ou depose-le dans
<code>~/Zomboid/mods/PZ_Pulse</code>.</p>
<p>Chemins essayes :</p><ul>%s</ul>
<p>Ou indique le chemin de <code>index.html</code> dans la variable
<code>PZCARTE_PULSE_PAGE</code> avant de lancer la carte.</p>
</html>"""


def page_absente():
    lignes = ''.join('<li><code>%s</code></li>' % p.replace('<', '&lt;') for p in PAGES if p)
    return ABSENTE % lignes
