#!/usr/bin/env bash
# Rendu progressif du calque des constructions, bride pour ne jamais gener le jeu.
#
#   rendu-progressif.sh demarrer [options]   lance en tache de fond (service systemd utilisateur)
#   rendu-progressif.sh une-passe [options]  met a jour puis s'arrete, au premier plan
#   rendu-progressif.sh suivi                terminal d'avancement en direct (Ctrl+C sort du suivi seulement)
#   rendu-progressif.sh pause                gele le rendu (rien n'est perdu)
#   rendu-progressif.sh reprendre            degele
#   rendu-progressif.sh arreter              arret propre, reprise au prochain demarrage
#   rendu-progressif.sh etat                 etat du service et dernieres lignes du journal
#
# Les options sont celles de outils/agent-monde/rendu-progressif.py (--help).
#
# Plafonds poses par le noyau, reglables par variables d'environnement :
#   PZRENDU_MEMOIRE=1536M   au-dela, c'est le rendu qui est tue, jamais le jeu
#   PZRENDU_CPU=50%         une moitie de coeur au plus
# En plus : priorite processeur et disque "idle" (ne tourne que quand rien
# d'autre ne veut la machine), pas de swap, et score OOM maximal pour que le
# noyau, s'il doit tuer quelque chose, choisisse le rendu.
set -u

RACINE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$RACINE/outils/agent-monde/rendu-progressif.py"
SUIVI="$RACINE/outils/agent-monde/suivi-rendu.py"
ETAT="$RACINE/out/rendu-progressif"
UNITE=pz-carte-rendu
MEMOIRE="${PZRENDU_MEMOIRE:-1536M}"
CPU="${PZRENDU_CPU:-50%}"

PYTHON="$RACINE/.venv/bin/python"
[ -x "$PYTHON" ] || PYTHON=python3

# Mio d'une taille systemd (1536M, 2G) : MemoryHigh vaut les trois quarts du
# plafond, pour que le noyau freine le rendu avant d'avoir a le tuer.
mio() { case "$1" in *G) echo $(( ${1%G} * 1024 ));; *M) echo "${1%M}";; *) echo $(( $1 / 1048576 ));; esac; }
HAUT="$(( $(mio "$MEMOIRE") * 3 / 4 ))M"

actif() { systemctl --user is-active --quiet "$UNITE" 2>/dev/null; }

cmd="${1:-aide}"
shift || true

case "$cmd" in
  demarrer)
    if actif; then
      echo "Deja en cours. Suivi : $0 suivi"
      exit 0
    fi
    systemctl --user reset-failed "$UNITE" 2>/dev/null
    systemd-run --user --unit="$UNITE" --collect --quiet \
      --description="Carte PZ : rendu progressif des constructions" \
      --working-directory="$RACINE" \
      -p MemoryMax="$MEMOIRE" -p MemoryHigh="$HAUT" -p MemorySwapMax=0 \
      -p CPUQuota="$CPU" -p CPUWeight=1 -p IOWeight=1 \
      -p Nice=19 -p CPUSchedulingPolicy=idle -p IOSchedulingClass=idle \
      -p OOMScoreAdjust=1000 \
      "$PYTHON" "$SCRIPT" "$@" || exit 1
    echo "Rendu progressif lance en fond (plafonds : $MEMOIRE de RAM, $CPU d'un coeur, priorite idle)."
    echo "  suivi      $0 suivi"
    echo "  pause      $0 pause"
    echo "  arret      $0 arreter"
    ;;

  une-passe)
    # Au premier plan, pour le bouton "synchroniser" de la carte. Si le
    # service tourne deja, le script le voit (verrou) et sort aussitot.
    if command -v systemd-run >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
      exec systemd-run --user --scope --quiet \
        -p MemoryMax="$MEMOIRE" -p MemoryHigh="$HAUT" -p MemorySwapMax=0 \
        -p CPUQuota="$CPU" -p CPUWeight=1 -p IOWeight=1 \
        choom -n 1000 -- chrt --idle 0 ionice -c3 nice -n19 \
        "$PYTHON" "$SCRIPT" --une-passe "$@"
    fi
    # Sans gestionnaire systemd utilisateur : pas de plafond memoire du noyau,
    # restent la priorite minimale et les gardes du script lui-meme.
    exec choom -n 1000 -- chrt --idle 0 ionice -c3 nice -n19 "$PYTHON" "$SCRIPT" --une-passe "$@"
    ;;

  suivi)
    exec "$PYTHON" "$SUIVI" "$ETAT" "$UNITE"
    ;;

  pause)
    # Gel par le congelateur des cgroups : aucun calcul perdu, aucune relecture
    # a la reprise. La memoire deja prise reste prise, d'ou "arreter" si c'est
    # la RAM qu'il faut rendre.
    systemctl --user freeze "$UNITE" && echo "Gele. Reprendre : $0 reprendre"
    ;;

  reprendre)
    systemctl --user thaw "$UNITE" && echo "Repris."
    ;;

  arreter)
    actif || { echo "Pas en cours."; exit 0; }
    # SIGTERM : le lot en cours se termine, l'etat est enregistre. Un service
    # gele ne recevrait pas le signal, on le degele d'abord.
    systemctl --user thaw "$UNITE" 2>/dev/null
    systemctl --user stop "$UNITE" && echo "Arrete. Reprise la ou il en etait : $0 demarrer"
    ;;

  etat)
    systemctl --user status "$UNITE" --no-pager 2>/dev/null | head -12
    echo
    tail -n 15 "$ETAT/journal.log" 2>/dev/null || echo "(pas encore de journal)"
    ;;

  *)
    sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
