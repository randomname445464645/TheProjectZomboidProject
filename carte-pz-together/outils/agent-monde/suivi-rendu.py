#!/usr/bin/env python3
"""Terminal d'avancement du rendu progressif.

Lecture seule et sans cout : un petit etat.json ecrit par le rendu, quelques
fichiers de /proc et de /sys. Aucun parcours de dossier, aucune requete sur la
base. Ctrl+C quitte le suivi, jamais le rendu.

    suivi-rendu.py <dossier d'etat> [unite systemd]
"""
import json
import os
import sys
import time

FENETRE = 60          # secondes minimum pour une cadence instantanee honnete
TICKS = os.sysconf('SC_CLK_TCK')


def lire_json(chemin):
    try:
        with open(chemin, encoding='utf8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def mem_dispo():
    with open('/proc/meminfo') as f:
        for ligne in f:
            if ligne.startswith('MemAvailable:'):
                return int(ligne.split()[1]) * 1024
    return 0


def processus(pid):
    """(vivant, gele, rss octets, ticks cpu) du rendu."""
    try:
        with open('/proc/%d/stat' % pid) as f:
            champs = f.read().rsplit(')', 1)[1].split()
        ticks = int(champs[11]) + int(champs[12])
        rss = 0
        with open('/proc/%d/status' % pid) as f:
            for ligne in f:
                if ligne.startswith('VmRSS:'):
                    rss = int(ligne.split()[1]) * 1024
        gele = False
        with open('/proc/%d/cgroup' % pid) as f:
            cg = f.read().strip().split('::', 1)[-1]
        try:
            with open('/sys/fs/cgroup%s/cgroup.events' % cg) as f:
                gele = 'frozen 1' in f.read()
        except OSError:
            pass
        return True, gele, rss, ticks
    except (OSError, IndexError, ValueError):
        return False, False, 0, 0


def jeu_lance():
    for p in os.listdir('/proc'):
        if p.isdigit():
            try:
                with open('/proc/%s/comm' % p) as f:
                    if f.read().startswith('ProjectZomboid'):
                        return True
            except OSError:
                pass
    return False


def barre(frac, largeur=32):
    frac = max(0.0, min(1.0, frac))
    n = int(frac * largeur)
    return '[' + '#' * n + '.' * (largeur - n) + ']'


def duree(s):
    if s is None or s != s or s == float('inf'):
        return '?'
    s = int(s)
    if s < 90:
        return '%d s' % s
    if s < 5400:
        return '%d min' % (s // 60)
    return '%d h %02d' % (s // 3600, s % 3600 // 60)


def heure(dans):
    if dans is None or dans != dans or dans == float('inf'):
        return '?'
    return time.strftime('%H:%M', time.localtime(time.time() + dans))


def queue_journal(chemin, n=6):
    """Dernieres lignes non routinieres, lues dans les 8 derniers Ko seulement."""
    try:
        with open(chemin, 'rb') as f:
            f.seek(0, 2)
            debut = max(0, f.tell() - 8192)
            f.seek(debut)
            lignes = f.read().decode('utf8', 'replace').splitlines()
            if debut:
                lignes = lignes[1:]          # premiere ligne coupee par le seek
    except OSError:
        return []
    return [l for l in lignes if l.strip()][-n:]


def main():
    dossier = sys.argv[1] if len(sys.argv) > 1 else 'out/rendu-progressif'
    chemin_etat = os.path.join(dossier, 'etat.json')
    historique = []          # (t, octets lus, tuiles faites)
    prec_cpu = None
    file_max = None
    try:
        while True:
            e = lire_json(chemin_etat)
            maintenant = time.time()
            out = ['\033[H\033[2J', 'Rendu progressif des constructions'
                   '      (Ctrl+C quitte ce suivi, le rendu continue)', '']
            if not e:
                out.append("Aucun etat dans %s : le rendu n'a jamais ete lance ici." % dossier)
                print('\n'.join(out), flush=True)
                time.sleep(2)
                continue

            pid = e.get('pid', 0)
            vivant, gele, rss, ticks = processus(pid)
            cpu = None
            if prec_cpu and vivant and maintenant > prec_cpu[0]:
                cpu = (ticks - prec_cpu[1]) / TICKS / (maintenant - prec_cpu[0]) * 100
            prec_cpu = (maintenant, ticks) if vivant else None

            phase = e.get('phase', '?')
            age = maintenant - e.get('t', 0)
            if not vivant:
                statut = 'ARRETE (%s, dernier signe il y a %s)' % (phase, duree(age))
            elif gele:
                statut = 'GELE (pause manuelle) - reprendre : rendu-progressif.sh reprendre'
            elif e.get('pause'):
                statut = 'EN PAUSE automatique : %s' % e['pause']
            elif phase == 'attente':
                statut = 'vivant, a jour, attend du nouveau dans le releve'
            elif age > 300:
                statut = 'vivant mais muet depuis %s (tuile tres chargee ?)' % duree(age)
            else:
                statut = 'vivant, %s' % ('lecture du releve' if phase == 'lecture' else 'dessin des tuiles')
            out.append('Etat      : ' + statut)
            out.append('Machine   : %.1f Gio disponibles   jeu %s   rendu : %s RAM, CPU %s'
                       % (mem_dispo() / 2**30, 'LANCE (rendu ralenti)' if jeu_lance() else 'ferme',
                          '%.0f Mo' % (rss / 1e6) if vivant else '-',
                          'mesure en cours' if cpu is None else '%.0f %% d\'un coeur' % cpu))
            out.append('')

            lec = e.get('lecture') or {}
            tui = e.get('tuiles') or {}
            debut = e.get('debut', maintenant)
            historique.append((maintenant, lec.get('lus', 0), tui.get('faites', 0)))
            historique = [h for h in historique if maintenant - h[0] <= 600]
            ancien = next((h for h in historique if maintenant - h[0] >= FENETRE), None)

            # Etape 1 : lecture du releve.
            total, lus = lec.get('total', 0), lec.get('lus', 0)
            if total:
                moy = lus / max(1, maintenant - debut)
                inst = None
                if ancien:
                    inst = (lus - ancien[1]) / (maintenant - ancien[0])
                reste = (total - lus) / moy if moy and lus < total else 0
                out.append('Etape 1/2 lecture du releve %s %3.0f %%  %d / %d Mo'
                           % (barre(lus / total), 100 * lus / total, lus / 1e6, total / 1e6))
                out.append('          moyenne %.1f Mo/s, instantane %s%s'
                           % (moy / 1e6, 'mesure en cours' if inst is None else '%.1f Mo/s' % (inst / 1e6),
                              '' if lus >= total else ', fin prevue vers %s (dans %s)' % (heure(reste), duree(reste))))
                out.append("          (cette barre ne couvre que la lecture : la file de tuiles se remplit pendant ce temps)")
                out.append('          %d lignes lues, %d cases nouvelles ou changees'
                           % (lec.get('lignes', 0), lec.get('changees', 0)))
            else:
                out.append('Etape 1/2 lecture du releve : rien de nouveau depuis le dernier passage')
            out.append('')

            # Etape 2 : tuiles.
            faites, restantes = tui.get('faites', 0), tui.get('restantes', 0)
            if file_max is None or restantes + faites > file_max:
                grossi = file_max is not None and restantes + faites > file_max
                file_max = restantes + faites
            else:
                grossi = False
            t_rendu = tui.get('debut')
            moy_t = faites / max(1, maintenant - t_rendu) if t_rendu and faites else None
            inst_t = None
            if ancien and phase == 'rendu':
                inst_t = (faites - ancien[2]) / (maintenant - ancien[0])
            frac = faites / (faites + restantes) if (faites + restantes) else 1
            if phase == 'lecture' and not faites:
                out.append('Etape 2/2 tuiles : commence apres la lecture, %d deja a refaire' % restantes)
            else:
                out.append('Etape 2/2 tuiles %s %3.0f %%  %d faites, %d restantes'
                           % (barre(frac), 100 * frac, faites, restantes))
            if phase == 'lecture' and not faites:
                pass
            elif moy_t:
                reste_t = restantes / moy_t
                out.append('          moyenne %.2f tuile/s (%s par tuile), instantane %s'
                           % (moy_t, duree(1 / moy_t), 'mesure en cours' if inst_t is None else '%.2f tuile/s' % inst_t))
                if restantes:
                    out.append('          fin prevue vers %s (dans %s), ~%.0f Mo ecrits a la fin'
                               % (heure(reste_t), duree(reste_t),
                                  tui.get('octets', 0) / faites * (faites + restantes) / 1e6))
            else:
                out.append('          cadence : mesure en cours')
            if grossi:
                out.append('          ATTENTION : la file vient de grossir (tu explores) : projection revue a la hausse')
            out.append("          (projection en supposant que tu n'explores plus ; jeu lance = 3x plus lent)")
            out.append('')
            out.append('Journal (%s) :' % os.path.join(dossier, 'journal.log'))
            for l in queue_journal(os.path.join(dossier, 'journal.log')):
                out.append('  ' + l)
            print('\n'.join(out), flush=True)
            time.sleep(2)
    except KeyboardInterrupt:
        print('\nSuivi quitte. Le rendu, lui, continue (rendu-progressif.sh arreter pour l\'arreter).')


if __name__ == '__main__':
    main()
