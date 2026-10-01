package pzexport;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Journal des deplacements, un fichier NDJSON par jour :
 *     <dossier>/AAAA-MM-JJ.ndjson
 *     {"t":ms,"id":"moi","n":"pseudo","x":..,"y":..,"z":..,"v":0}
 *
 * Aucune dependance au jeu : l'agent lui passe des positions, ce qui permet
 * de tester la classe seule (voir EssaiJournal dans le scratchpad du commit).
 *
 * ECHANTILLONNAGE
 * Un point par seconde et par joueur ferait 86 400 lignes par jour de jeu
 * continu. On n'ecrit un point que si :
 *   - le joueur a parcouru au moins PAS cases depuis le dernier point ;
 *   - ou il a change d'etage, ou est monte / descendu d'un vehicule ;
 *   - ou DELAI_MAX est ecoule : a l'arret, un point par minute. C'est ce qui
 *     permet a la carte de dire "arrete 23 min ici".
 * Le premier point de chaque joueur est toujours ecrit.
 *
 * Ecriture tamponnee, videe toutes les 5 secondes : au pire les 5 dernieres
 * secondes sont perdues si le jeu plante. Changement de jour a minuit, heure
 * locale.
 */
final class Journal {

    static final double PAS = 2.0;           // cases
    static final long DELAI_MAX = 60_000L;   // ms
    static final long VIDAGE = 5_000L;       // ms

    private final Path dossier;
    private final ZoneId zone;
    private final Map<String, double[]> derniers = new HashMap<>();   // id -> {x, y, z, t, v}
    private BufferedWriter w;
    private String jour;
    private long dernierVidage;

    Journal(Path dossier, ZoneId zone) {
        this.dossier = dossier;
        this.zone = zone;
    }

    /** Note une position. Renvoie vrai si une ligne a ete ecrite. */
    synchronized boolean noter(String id, String nom, float x, float y, float z,
                               boolean vehicule, long t) throws IOException {
        String j = LocalDate.ofInstant(Instant.ofEpochMilli(t), zone).toString();
        if (!j.equals(jour)) ouvrir(j);

        double[] d = derniers.get(id);
        int v = vehicule ? 1 : 0;
        boolean ecrire = d == null
                || Math.hypot(x - d[0], y - d[1]) >= PAS
                || Math.abs(z - d[2]) >= 0.5
                || v != (int) d[4]
                || t - (long) d[3] >= DELAI_MAX;
        if (!ecrire) return false;

        w.write(String.format(Locale.ROOT,
                "{\"t\":%d,\"id\":%s,\"n\":%s,\"x\":%.1f,\"y\":%.1f,\"z\":%.1f,\"v\":%d}",
                t, Agent.chaine(id), Agent.chaine(nom), x, y, z, v));
        w.write('\n');
        derniers.put(id, new double[] {x, y, z, t, v});
        if (t - dernierVidage >= VIDAGE) {
            w.flush();
            dernierVidage = t;
        }
        return true;
    }

    synchronized void vider() throws IOException {
        if (w != null) w.flush();
    }

    private void ouvrir(String j) throws IOException {
        if (w != null) w.close();
        Files.createDirectories(dossier);
        w = Files.newBufferedWriter(dossier.resolve(j + ".ndjson"), StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        jour = j;
        // Nouveau fichier : chaque joueur y recommence par un point complet.
        derniers.clear();
    }
}
