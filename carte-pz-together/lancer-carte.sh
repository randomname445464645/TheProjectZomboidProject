#!/usr/bin/env bash
# Carte locale du serveur PZ together.
# Donnees 100 % statiques : aucun acces au jeu, aucune ecriture dans ~/Zomboid.
set -u

RACINE="$(cd "$(dirname "$0")" && pwd)"
PORT=8880
JOURNAL=/tmp/pzcarte.log
MOTIF='python3? .*serveur\.py'

port_repond() { (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && exec 3<&- 3>&-; }

# Arret d'une instance precedente. Le motif vise la ligne de commande python,
# pas le chemin du script : celui-ci est lance depuis out/html, donc sa ligne
# de commande est juste "python3 serveur.py".
pkill -f "$MOTIF" 2>/dev/null
for _ in $(seq 1 30); do port_repond || break; sleep 0.1; done

if port_repond; then
  echo "Le port $PORT est occupe par un autre programme. Rien n'a ete lance."
  exit 1
fi

cd "$RACINE/out/html" || exit 1
rm -f "$JOURNAL"
python3 serveur.py >"$JOURNAL" 2>&1 &
PID=$!

for _ in $(seq 1 50); do port_repond && break; sleep 0.1; done

if ! kill -0 "$PID" 2>/dev/null || ! port_repond; then
  echo "Le serveur n'a pas demarre. Journal :"
  cat "$JOURNAL"
  exit 1
fi

echo
echo "  Carte PZ together        http://127.0.0.1:$PORT/carte.html"
echo "  Viewer pzmap2dzi complet http://127.0.0.1:$PORT/pzmap.html"
echo
echo "  Journal  : $JOURNAL  (seules les erreurs y sont ecrites)"
echo "  Arreter  : pkill -f '$MOTIF'"
echo

command -v xdg-open >/dev/null && (xdg-open "http://127.0.0.1:$PORT/carte.html" >/dev/null 2>&1 &)
exit 0
