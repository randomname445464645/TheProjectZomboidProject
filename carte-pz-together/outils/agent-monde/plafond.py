"""Plafond memoire pour les scripts lourds du calque (convertir, rendre-calque).

Le 1er octobre 2026, le bouton synchroniser a lance convertir.py puis
rendre-calque.py sans aucune limite : 8 processus portant chacun une copie
des 6,5 millions de cases ont rempli la RAM, et le noyau a tue Claude,
Vesktop et d'autres applications au lieu du rendu.

plafonner() relance donc le script dans un cgroup systemd plafonne, sans swap,
priorite minimale et score OOM maximal : s'il depasse, c'est LUI qui meurt, et
rien d'autre. Sans systemd utilisateur, il garde au moins le score OOM maximal.
"""
import os
import sys


def deja_plafonne():
    try:
        with open('/proc/self/cgroup') as f:
            cg = f.read().strip().split('::', 1)[-1]
        with open('/sys/fs/cgroup%s/memory.max' % cg) as f:
            return f.read().strip() != 'max'
    except OSError:
        return False


def plafonner(memoire=None):
    memoire = memoire or os.environ.get('PZ_MEMOIRE_MAX', '8G')
    try:
        with open('/proc/self/oom_score_adj', 'w') as f:
            f.write('1000')
    except OSError:
        pass
    if os.environ.get('PZ_PLAFONNE') or deja_plafonne():
        return
    env = dict(os.environ, PZ_PLAFONNE='1')
    cmd = ['systemd-run', '--user', '--scope', '--quiet',
           '-p', 'MemoryMax=' + memoire, '-p', 'MemorySwapMax=0',
           '-p', 'CPUWeight=1', '-p', 'IOWeight=1',
           'nice', '-n', '19', sys.executable] + sys.argv
    print('plafond memoire : %s (au-dela, ce script est tue, pas le reste du systeme)' % memoire,
          flush=True)
    try:
        os.execvpe('systemd-run', cmd, env)
    except OSError as e:
        print('systemd-run indisponible (%s) : pas de plafond, score OOM maximal seulement' % e,
              file=sys.stderr, flush=True)
