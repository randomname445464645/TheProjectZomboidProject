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
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Journal des vehicules vus, un fichier NDJSON par jour :
 *     <dossier>/AAAA-MM-JJ.ndjson
 *
 * Une ligne par EVENEMENT, pas par lecture :
 *     "e":"a"  apparition : le vehicule entre dans la zone chargee. Fiche complete.
 *     "e":"m"  modification : essence, etat, verrous, cles... Fiche complete.
 *     "e":"d"  deplacement de DEPLACE cases ou plus, ou rotation de TOURNE
 *              degres ou plus, rien d'autre n'a change. Cle, position et cap
 *              seulement : un vehicule qu'on conduit en ecrit une par lecture,
 *              la fiche complete y serait du gaspillage. Sans le cap, un
 *              vehicule conduit garderait sur la carte celui de son apparition.
 *     "e":"p"  toujours la, une fois par PRESENCE ms. Cle, position et cap.
 *     "e":"f"  fin : absent depuis ABSENCE ms. En temps et pas en nombre de
 *              lectures : l'intervalle de releve est reglable.
 * Chaque ligne porte "t" (heure reelle, ms) et "h" (heure du monde de jeu).
 *
 * C'est le serveur de la carte qui en tire, pour chaque vehicule, la premiere
 * et la derniere fois qu'il a ete vu. L'agent n'a ainsi rien a relire au
 * demarrage, et un journal coupe net par un plantage reste exploitable.
 *
 * Aucune dependance au jeu : l'agent lui passe des Releve, ce qui permet de
 * tester la classe seule.
 */
final class JournalVehicules {

    static final double DEPLACE = 3.0;          // cases
    static final double TOURNE = 20.0;          // degres
    static final long PRESENCE = 10 * 60_000L;  // ms
    static final long ABSENCE = 15_000L;        // ms

    private static final class Suivi {
        float x, y, capX, capY;
        String signature;
        long ecrit;
        long vu;
    }

    private final Path dossier;
    private final ZoneId zone;
    private final Map<String, Suivi> suivis = new HashMap<>();
    private BufferedWriter w;
    private String jour;

    JournalVehicules(Path dossier, ZoneId zone) {
        this.dossier = dossier;
        this.zone = zone;
    }

    /** Integre une lecture complete. Renvoie le nombre de lignes ecrites. */
    synchronized int noter(List<Vehicules.Releve> releves, long t, String h) throws IOException {
        String j = LocalDate.ofInstant(Instant.ofEpochMilli(t), zone).toString();
        if (!j.equals(jour)) ouvrir(j);
        String hj = Agent.chaine(h);
        int n = 0;
        Set<String> presents = new HashSet<>();
        for (Vehicules.Releve r : releves) {
            if (!presents.add(r.cle())) continue;   // deux vehicules sans keyId de meme id : improbable
            Suivi s = suivis.get(r.cle());
            String e;
            if (s == null) {
                s = new Suivi();
                suivis.put(r.cle(), s);
                e = "a";
            } else if (!r.signature().equals(s.signature)) {
                e = "m";
            } else if (Math.hypot(r.x() - s.x, r.y() - s.y) >= DEPLACE
                    || ecart(r.capX(), r.capY(), s.capX, s.capY) >= TOURNE) {
                e = "d";
            } else if (t - s.ecrit >= PRESENCE) {
                e = "p";
            } else {
                s.vu = t;
                continue;
            }
            s.vu = t;
            s.x = r.x(); s.y = r.y();
            s.capX = r.capX(); s.capY = r.capY();
            s.signature = r.signature();
            s.ecrit = t;
            if (e.equals("p") || e.equals("d")) {
                w.write(String.format(Locale.ROOT,
                        "{\"e\":\"" + e + "\",\"t\":%d,\"h\":%s,\"k\":%s,\"x\":%.1f,\"y\":%.1f,\"cap\":[%.3f,%.3f]}",
                        t, hj, Agent.chaine(r.cle()), r.x(), r.y(), r.capX(), r.capY()));
            } else {
                w.write("{\"e\":\"" + e + "\",\"t\":" + t + ",\"h\":" + hj + ",\"v\":" + r.json() + "}");
            }
            w.write('\n');
            n++;
        }
        for (Iterator<Map.Entry<String, Suivi>> it = suivis.entrySet().iterator(); it.hasNext(); ) {
            Map.Entry<String, Suivi> m = it.next();
            if (presents.contains(m.getKey())) continue;
            if (t - m.getValue().vu < ABSENCE) continue;
            // Absent plusieurs lectures de suite : sorti de la zone chargee,
            // ou parti. Le revoir plus tard fera une nouvelle apparition.
            w.write(String.format(Locale.ROOT,
                    "{\"e\":\"f\",\"t\":%d,\"h\":%s,\"k\":%s,\"x\":%.1f,\"y\":%.1f,\"cap\":[%.3f,%.3f]}",
                    t, hj, Agent.chaine(m.getKey()), m.getValue().x, m.getValue().y,
                    m.getValue().capX, m.getValue().capY));
            w.write('\n');
            n++;
            it.remove();
        }
        if (n > 0) w.flush();
        return n;
    }

    private void ouvrir(String j) throws IOException {
        if (w != null) w.close();
        Files.createDirectories(dossier);
        w = Files.newBufferedWriter(dossier.resolve(j + ".ndjson"), StandardCharsets.UTF_8,
                StandardOpenOption.CREATE, StandardOpenOption.APPEND);
        jour = j;
        // Nouveau fichier : chaque vehicule present y recommence par une
        // apparition, pour qu'un jour se lise seul.
        suivis.clear();
    }

    /** Angle entre deux caps, en degres ; 0 si l'un des deux est inconnu (nul). */
    static double ecart(float ax, float ay, float bx, float by) {
        if ((ax == 0 && ay == 0) || (bx == 0 && by == 0)) return 0;
        double d = Math.toDegrees(Math.atan2(ay, ax) - Math.atan2(by, bx));
        d = Math.abs(((d % 360) + 540) % 360 - 180);
        return d;
    }
}
