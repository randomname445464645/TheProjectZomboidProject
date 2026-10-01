#!/usr/bin/env bash
# Ouvre la carte PZ together dans une fenetre d'application separee.
#
# Demarre le serveur statique local s'il ne tourne pas deja, puis lance le
# navigateur en mode application : pas de barre d'adresse, pas d'onglets, une
# entree propre dans la barre des taches.
set -u

RACINE="$(cd "$(dirname "$0")" && pwd)"
PORT=8880
URL="http://127.0.0.1:$PORT/carte.html"
JOURNAL=/tmp/pzcarte.log

port_repond() { (exec 3<>/dev/tcp/127.0.0.1/$PORT) 2>/dev/null && exec 3<&- 3>&-; }

# --- serveur ---------------------------------------------------------------
if ! port_repond; then
  cd "$RACINE/out/html" || exit 1
  python3 serveur.py >"$JOURNAL" 2>&1 &
  for _ in $(seq 1 60); do port_repond && break; sleep 0.1; done
  if ! port_repond; then
    echo "Le serveur n'a pas demarre. Journal : $JOURNAL" >&2
    command -v kdialog >/dev/null && kdialog --error "La carte n'a pas pu demarrer.\nVoir $JOURNAL"
    exit 1
  fi
fi

# --- navigateur ------------------------------------------------------------
# Seuls les navigateurs Chromium gerent --app. Firefox et LibreWolf n'ont pas
# d'equivalent : on se rabat sur une fenetre ordinaire plutot que d'echouer.
for nav in google-chrome-stable google-chrome chromium chromium-browser brave-browser vivaldi-stable microsoft-edge; do
  if command -v "$nav" >/dev/null 2>&1; then
    # --class fixe l'identifiant de fenetre, pour que le gestionnaire de
    # bureau associe l'icone du .desktop a la fenetre (StartupWMClass).
    #
    # --ozone-platform=x11 est indispensable : sous Wayland, Chrome ignore
    # --class et se donne un app_id de la forme chrome-127.0.0.1__8880-Default,
    # que le .desktop ne peut pas prevoir. Plasma ne relie alors pas la fenetre
    # au raccourci et affiche son icone generique d'application web. Via
    # XWayland, WM_CLASS vaut bien carte-pz et l'icone est correcte.
    # Les deux ecrans sont a l'echelle 1, XWayland ne coute donc aucun flou.
    exec "$nav" --ozone-platform=x11 --app="$URL" --class=carte-pz --name=carte-pz
  fi
done

echo "Aucun navigateur Chromium trouve, ouverture dans le navigateur par defaut." >&2
exec xdg-open "$URL"
