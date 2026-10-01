#!/usr/bin/env bash
# Suivi en direct de construire-grille.py. Lecture seule : Ctrl+C sort du
# suivi, pas du travail.
#
# Source unique : le nombre de lignes du journal. Une ligne par cellule finie.
# Aucun parcours d'arborescence, aucune relecture des PNG.
set -u

JOURNAL="${1:-out/html/map_data/itineraire/construction.log}"
PERIODE=2

[ -f "$JOURNAL" ] || { echo "journal introuvable : $JOURNAL"; exit 1; }

# Le PID du constructeur, cherche par nom de script et pas par motif large :
# pgrep -f sur un motif qui apparait dans sa propre ligne de commande se
# trouve lui-meme.
pid_constructeur() {
  pgrep -f 'construire-grille\.py' | head -1
}

total=$(head -1 "$JOURNAL" | awk '{print $2}')
[ -n "$total" ] || total=0

debut_ts=$(date +%s)
debut_n=$(( $(wc -l < "$JOURNAL") - 1 ))
prec_n=$debut_n
prec_ts=$debut_ts
FENETRE=15          # secondes mini avant d'oser une cadence instantanee

barre() {           # $1 = fraction 0..1, $2 = largeur
  local remplis=$(awk -v f="$1" -v w="$2" 'BEGIN{printf "%d", f*w}')
  local i out=''
  for ((i=0;i<$2;i++)); do
    if [ $i -lt "$remplis" ]; then out+='#'; else out+='.'; fi
  done
  printf '%s' "$out"
}

duree() {           # $1 = secondes -> "1 h 04" ou "3 min 20" ou "12 s"
  local s=$1
  if [ "$s" -ge 3600 ]; then printf '%d h %02d' $((s/3600)) $(((s%3600)/60))
  elif [ "$s" -ge 60 ]; then printf '%d min %02d' $((s/60)) $((s%60))
  else printf '%d s' "$s"; fi
}

trap 'printf "\n[Ctrl+C] suivi arrete. La construction continue.\n"; exit 0' INT

while :; do
  n=$(( $(wc -l < "$JOURNAL") - 1 ))
  [ "$n" -lt 0 ] && n=0
  ts=$(date +%s)
  pid=$(pid_constructeur)

  ecoule=$(( ts - debut_ts ))
  moyenne=0
  [ "$ecoule" -gt 0 ] && moyenne=$(awk -v a="$((n-debut_n))" -v t="$ecoule" 'BEGIN{printf "%.1f", a/t}')

  if [ $(( ts - prec_ts )) -ge "$FENETRE" ]; then
    inst=$(awk -v a="$((n-prec_n))" -v t="$((ts-prec_ts))" 'BEGIN{printf "%.1f", a/t}')
    prec_n=$n; prec_ts=$ts
    INST_TXT="$inst cell/s"
  else
    : "${INST_TXT:=mesure en cours}"
  fi

  frac=0
  [ "$total" -gt 0 ] && frac=$(awk -v n="$n" -v t="$total" 'BEGIN{printf "%.4f", n/t}')
  pct=$(awk -v f="$frac" 'BEGIN{printf "%.1f", f*100}')

  reste_txt='inconnu'
  if [ "$total" -gt 0 ] && [ "$(awk -v m="$moyenne" 'BEGIN{print (m>0)?1:0}')" = 1 ]; then
    reste=$(awk -v n="$((total-n))" -v m="$moyenne" 'BEGIN{printf "%d", n/m}')
    reste_txt="$(duree "$reste") (fin vers $(date -d "+$reste seconds" +%H:%M:%S))"
  fi

  if [ -n "$pid" ]; then etat="vivant, pid $pid"; else
    if grep -q '^FINI' "$JOURNAL" 2>/dev/null; then etat='termine'; else etat='ARRETE sans FINI'; fi
  fi

  clear
  printf 'Grille de cout pour l itineraire auto\n'
  printf '%s\n\n' '-------------------------------------'
  printf '  [%s] %s %%\n' "$(barre "$frac" 46)" "$pct"
  printf '  %d / %d cellules de carte\n\n' "$n" "$total"
  printf '  La barre ne couvre QUE la lecture des cellules.\n'
  printf '  L ecriture des PNG vient apres, une fois par carte, et ne compte pas.\n\n'
  printf '  cadence instantanee : %s\n' "$INST_TXT"
  printf '  moyenne depuis le debut : %s cell/s (stable tout de suite)\n' "$moyenne"
  printf '  ecoule : %s\n' "$(duree "$ecoule")"
  printf '  restant : %s\n\n' "$reste_txt"
  printf '  etat : %s\n\n' "$etat"
  printf '  dernieres lignes hors progression :\n'
  grep -E '^(CARTE|FINI|Traceback|Error|error)' "$JOURNAL" 2>/dev/null | tail -6 | sed 's/^/    /'
  printf '\n  Ctrl+C sort du suivi, pas de la construction.\n'

  [ "$etat" = 'termine' ] && break
  sleep "$PERIODE"
done
