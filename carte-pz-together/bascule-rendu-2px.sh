#!/usr/bin/env bash
# Bascule le rendu 2 px par case (out2) a la place du rendu 1 px (out).
# L'ancien rendu est conserve sous out/html/map_data_sqr1 : rien n'est efface.
set -eu
cd "$(dirname "$0")"

NEUF=out2/html/map_data
ACTUEL=out/html/map_data
ARCHIVE=out/html/map_data_sqr1

[ -d "$NEUF/base_top/layer0_files" ] || { echo "Rendu 2 px absent ou incomplet."; exit 1; }
[ -e "$ARCHIVE" ] && { echo "$ARCHIVE existe deja, bascule deja faite ?"; exit 1; }

# Les calques rooms / objects / streets ne dependent pas de la taille de case :
# leurs marks.json sont en coordonnees monde. On reprend ceux du rendu 1 px
# plutot que de les recalculer.
for calque in rooms objects streets; do
  [ -d "$ACTUEL/$calque" ] && cp -a "$ACTUEL/$calque" "$NEUF/$calque"
done
for carte in "$ACTUEL"/mod_maps/*/; do
  nom=$(basename "$carte")
  for calque in rooms objects streets; do
    if [ -d "$carte$calque" ] && [ -d "$NEUF/mod_maps/$nom" ]; then
      cp -a "$carte$calque" "$NEUF/mod_maps/$nom/$calque"
    fi
  done
done

mv "$ACTUEL" "$ARCHIVE"
mv "$NEUF" "$ACTUEL"

echo "Bascule faite."
echo "  actif   : $ACTUEL        ($(du -sh "$ACTUEL" | cut -f1))"
echo "  archive : $ARCHIVE  ($(du -sh "$ARCHIVE" | cut -f1))"
echo
echo "Retour arriere :"
echo "  mv $ACTUEL out2/html/map_data && mv $ARCHIVE $ACTUEL"
