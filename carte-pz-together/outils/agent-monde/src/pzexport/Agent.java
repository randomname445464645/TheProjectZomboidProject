package pzexport;

import java.io.BufferedWriter;
import java.io.FileWriter;
import java.lang.instrument.Instrumentation;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.util.HashMap;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import zombie.characters.IsoPlayer;
import zombie.iso.IsoCell;
import zombie.iso.IsoGridSquare;
import zombie.iso.IsoObject;
import zombie.iso.IsoWorld;
import zombie.iso.objects.IsoThumpable;
import zombie.network.GameClient;
import zombie.worldMap.WorldMapRemotePlayer;
import zombie.worldMap.WorldMapRemotePlayers;
import zombie.util.list.PZArrayList;

/**
 * Exporte la zone de monde chargee en memoire vers un fichier NDJSON.
 *
 * Pourquoi un agent plutot qu'un debogueur distant : JDWP fait passer chaque
 * lecture de champ par un aller-retour reseau et exige un thread suspendu pour
 * invoquer une methode. Balayer la zone chargee y demanderait des millions
 * d'allers-retours, jeu fige. Un agent tourne DANS le processus, sans aucun
 * aller-retour.
 *
 * Pourquoi pas un mod Lua : meme resultat, mais rien a deposer dans le dossier
 * des mods ni a declarer au jeu. C'est un choix, pas une superiorite technique.
 *
 * Installation : ajouter aux vmArgs de ProjectZomboid64.json
 *     -javaagent:/chemin/agent-monde.jar=periode=5,sortie=/chemin/monde.ndjson
 *
 * Options (separees par des virgules) :
 *     periode=<secondes>   intervalle entre deux balayages, defaut 5
 *     sortie=<chemin>      fichier de sortie, defaut ~/Zomboid/pz-export/monde.ndjson
 *     tout=1               exporte TOUS les objets ; par defaut, seules les
 *                          constructions de joueur (IsoThumpable) et les cases
 *                          qui en contiennent
 *     position=<ms>        intervalle d'ecriture de la position du joueur,
 *                          defaut 1000, 0 pour ne pas l'ecrire
 *     journal=0            n'enregistre pas les deplacements (voir Journal) ;
 *                          par defaut ils sont notes dans traces/AAAA-MM-JJ.ndjson
 *
 * POSITION DU JOUEUR
 *     Un second thread ecrit position.json a cote du fichier de sortie :
 *         {"x":..,"y":..,"z":..,"a":angle,"v":0|1,"m":0|1,"t":horodatage_ms}
 *     v = en vehicule, m = mort. S'y ajoute "autres", les autres joueurs
 *     connus du client (voir lireAutres()). Ecriture dans un .tmp puis renommage
 *     atomique : le serveur de la carte ne lit jamais un fichier a moitie
 *     ecrit. Ce thread est separe du balayage, qui peut prendre plusieurs
 *     secondes sur une grande zone chargee ; la position, elle, doit suivre.
 *     L'extension .json et non .ndjson est voulue : convertir.py lit tous les
 *     .ndjson du dossier et ne doit pas prendre la position pour un releve.
 */
public final class Agent {

    private static final String DEFAUT_SORTIE =
            System.getProperty("user.home") + "/Zomboid/pz-export/monde.ndjson";

    private static long periodeMs = 5000L;
    private static String sortie = DEFAUT_SORTIE;
    private static boolean tout = false;
    private static long periodePositionMs = 1000L;
    private static boolean journalActif = true;

    // Signature de la derniere version vue de chaque case, pour n'ecrire que
    // ce qui a change. Cle = (x, y, z) empaquetes, valeur = hachage du contenu.
    private static final Map<Long, Integer> vues = new HashMap<>();

    // Au-dela de cette taille on repart de zero : sans borne, une longue
    // exploration ferait enfler la table indefiniment.
    private static final int MAX_VUES = 3_000_000;

    public static void premain(String args, Instrumentation inst) { demarrer(args); }
    public static void agentmain(String args, Instrumentation inst) { demarrer(args); }

    private static void demarrer(String args) {
        lireOptions(args);
        Thread t = new Thread(Agent::boucle, "pz-export");
        t.setDaemon(true);                 // ne retient jamais l'arret du jeu
        t.setPriority(Thread.MIN_PRIORITY);
        t.start();
        if (periodePositionMs > 0) {
            Thread p = new Thread(Agent::bouclePosition, "pz-export-position");
            p.setDaemon(true);
            p.setPriority(Thread.MIN_PRIORITY);
            p.start();
        }
        System.out.println("[pz-export] agent actif, sortie=" + sortie
                + " periode=" + (periodeMs / 1000) + "s tout=" + tout
                + " position=" + periodePositionMs + "ms");
    }

    private static void lireOptions(String args) {
        if (args == null || args.isEmpty()) return;
        for (String p : args.split(",")) {
            int i = p.indexOf('=');
            if (i < 0) continue;
            String cle = p.substring(0, i).trim();
            String val = p.substring(i + 1).trim();
            switch (cle) {
                case "periode" -> {
                    try { periodeMs = Math.max(1000L, Long.parseLong(val) * 1000L); }
                    catch (NumberFormatException ignore) { }
                }
                case "sortie" -> sortie = val;
                case "journal" -> journalActif = !"0".equals(val) && !"false".equalsIgnoreCase(val);
                case "position" -> {
                    try { periodePositionMs = Math.max(0L, Long.parseLong(val)); }
                    catch (NumberFormatException ignore) { }
                    if (periodePositionMs > 0 && periodePositionMs < 200) periodePositionMs = 200;
                }
                case "tout"   -> tout = "1".equals(val) || "true".equalsIgnoreCase(val);
            }
        }
    }

    private static void boucle() {
        BufferedWriter w = null;
        try {
            Path p = Paths.get(sortie);
            if (p.getParent() != null) Files.createDirectories(p.getParent());
            w = new BufferedWriter(new FileWriter(sortie, true), 1 << 16);
        } catch (Throwable e) {
            System.out.println("[pz-export] sortie impossible : " + e);
            return;
        }

        while (true) {
            try {
                Thread.sleep(periodeMs);
                int n = balayer(w);
                if (n > 0) {
                    w.flush();
                    System.out.println("[pz-export] " + n + " cases ecrites");
                }
            } catch (InterruptedException e) {
                return;
            } catch (Throwable e) {
                // Un agent d'export ne doit JAMAIS faire tomber le jeu.
                System.out.println("[pz-export] erreur ignoree : " + e);
            }
        }
    }

    private static int balayer(BufferedWriter w) throws Exception {
        IsoWorld monde = IsoWorld.instance;
        if (monde == null) return 0;
        IsoCell cell = monde.getCell();
        if (cell == null) return 0;

        // Bornes REELLES de la zone chargee : c'est tout ce que le client a en
        // memoire, le serveur n'envoie rien de plus.
        final int x0 = cell.getMinX(), x1 = cell.getMaxX();
        final int y0 = cell.getMinY(), y1 = cell.getMaxY();
        final int z0 = cell.getMinZ(), z1 = cell.getMaxZ();
        if (x1 <= x0 || y1 <= y0) return 0;

        if (vues.size() > MAX_VUES) vues.clear();

        StringBuilder ligne = new StringBuilder(256);
        int ecrites = 0;

        for (int z = z0; z <= z1; z++) {
            for (int y = y0; y < y1; y++) {
                for (int x = x0; x < x1; x++) {
                    IsoGridSquare sq;
                    try {
                        sq = cell.getGridSquare(x, y, z);
                    } catch (Throwable e) {
                        continue;   // le jeu modifie le monde pendant qu'on lit
                    }
                    if (sq == null) continue;

                    PZArrayList<IsoObject> objets;
                    try {
                        objets = sq.getObjects();
                    } catch (Throwable e) {
                        continue;
                    }
                    if (objets == null || objets.size() == 0) continue;

                    ligne.setLength(0);
                    boolean aConstruction = false;
                    int nb = 0;
                    ligne.append("{\"x\":").append(x)
                         .append(",\"y\":").append(y)
                         .append(",\"z\":").append(z)
                         .append(",\"s\":[");

                    for (int i = 0; i < objets.size(); i++) {
                        IsoObject o;
                        String nom;
                        boolean construit;
                        try {
                            o = objets.get(i);
                            if (o == null) continue;
                            nom = o.getSpriteName();
                            if (nom == null || nom.isEmpty()) continue;
                            construit = (o instanceof IsoThumpable);
                        } catch (Throwable e) {
                            continue;
                        }
                        if (construit) aConstruction = true;
                        if (nb > 0) ligne.append(',');
                        ligne.append('"').append(echapper(nom)).append('"');
                        nb++;
                    }
                    ligne.append(']');
                    // Marque les cases contenant une construction. Avec tout=1
                    // toutes les cases sortent, ce drapeau est alors le seul
                    // moyen de les distinguer cote viewer.
                    if (aConstruction) ligne.append(",\"c\":1");
                    ligne.append('}');

                    if (nb == 0) continue;
                    if (!tout && !aConstruction) continue;

                    // N'ecrire que si la case a change depuis le dernier passage.
                    long cle = (((long) (x & 0x1FFFFF)) << 26)
                             | (((long) (y & 0x1FFFFF)) << 5)
                             | ((long) (z & 0x1F));
                    int h = ligne.toString().hashCode();
                    Integer ancien = vues.get(cle);
                    if (ancien != null && ancien == h) continue;
                    vues.put(cle, h);

                    w.write(ligne.toString());
                    w.write('\n');
                    ecrites++;
                }
            }
        }
        return ecrites;
    }

    /**
     * Ecrit la position du joueur local, une fois par periode.
     *
     * Lecture depuis un thread qui n'est pas celui du jeu : les flottants
     * peuvent etre lus pendant une mise a jour, ce qui donne au pire une
     * position d'une image en retard. Sans consequence pour une carte, et
     * sans aucun verrou pris sur le jeu.
     */
    private static void bouclePosition() {
        Path fin = Paths.get(sortie).resolveSibling("position.json");
        Path tmp = Paths.get(sortie).resolveSibling("position.json.tmp");
        Journal journal = journalActif
                ? new Journal(Paths.get(sortie).resolveSibling("traces"), ZoneId.systemDefault())
                : null;
        int erreurs = 0, erreursJournal = 0;
        while (true) {
            try {
                Thread.sleep(periodePositionMs);
                IsoPlayer j = IsoPlayer.getInstance();
                if (j == null) continue;            // menu, chargement
                float x = j.getX(), y = j.getY(), z = j.getZ();
                if (!Float.isFinite(x) || !Float.isFinite(y) || x <= 0f || y <= 0f) continue;
                long t = System.currentTimeMillis();
                boolean enVehicule = j.getVehicle() != null;
                List<Autre> autres = lireAutres(j);
                String json = String.format(Locale.ROOT,
                        "{\"x\":%.2f,\"y\":%.2f,\"z\":%.2f,\"a\":%.3f,\"v\":%d,\"m\":%d,\"t\":%d,\"autres\":%s}",
                        x, y, z, j.getDirectionAngleRadians(),
                        enVehicule ? 1 : 0, j.isDead() ? 1 : 0, t, json(autres));
                Files.writeString(tmp, json, StandardCharsets.UTF_8);
                Files.move(tmp, fin, StandardCopyOption.REPLACE_EXISTING,
                        StandardCopyOption.ATOMIC_MOVE);
                erreurs = 0;

                // Journal : un souci d'ecriture ne doit jamais empecher la
                // position en direct, d'ou son propre try.
                if (journal != null) {
                    try {
                        journal.noter("moi", j.getUsername(), x, y, z, enVehicule, t);
                        for (Autre o : autres) {
                            // Le pseudo est stable d'une session a l'autre,
                            // l'identifiant reseau non : il sert de cle.
                            String cle = o.nom() != null ? "u:" + o.nom() : "j" + o.id();
                            journal.noter(cle, o.nom(), o.x(), o.y(),
                                    o.z() != null ? o.z() : 0f, o.v(), t);
                        }
                    } catch (Throwable e) {
                        if (erreursJournal++ % 60 == 0) {
                            System.out.println("[pz-export] journal ignore : " + e);
                        }
                    }
                }
            } catch (InterruptedException e) {
                return;
            } catch (Throwable e) {
                // Une fois par minute au plus : a une ecriture par seconde, une
                // erreur persistante noierait la console du jeu.
                if (erreurs++ % 60 == 0) {
                    System.out.println("[pz-export] position ignoree : " + e);
                }
            }
        }
    }

    /**
     * Les autres joueurs connus du client, en tableau JSON.
     *
     * Deux sources, dans cet ordre :
     *   1. GameClient.IDToPlayerMap : les joueurs PROCHES, que le client
     *      simule. Donnees completes : etage, orientation, vehicule, mort.
     *   2. WorldMapRemotePlayers : ce qui alimente la carte du monde en jeu.
     *      Position et nom seulement, mais aussi pour les joueurs lointains,
     *      si le serveur le permet (option MapRemotePlayerVisibility).
     * Fusion par identifiant reseau : un joueur proche n'apparait qu'une fois,
     * avec ses donnees completes. "p":1 marque un joueur proche.
     *
     * Les joueurs invisibles (administrateurs) restent caches, comme dans le
     * jeu : on applique isInvisible() et canSeeInvisiblePlayer().
     *
     * Ces listes sont modifiees par le fil reseau pendant qu'on les lit : on
     * copie d'abord (toArray), et une lecture ratee est simplement refaite a la
     * seconde suivante.
     */
    /** Un autre joueur tel que lu dans le jeu. z et a absents pour un lointain. */
    private record Autre(short id, String nom, float x, float y, Float z, Float a,
                         boolean v, boolean m, boolean proche) { }

    private static List<Autre> lireAutres(IsoPlayer moi) {
        List<Autre> l = new ArrayList<>();
        Set<Short> vus = new HashSet<>();
        vus.add(moi.getOnlineID());
        try {
            for (Object o : GameClient.IDToPlayerMap.values().toArray()) {
                if (!(o instanceof IsoPlayer p)) continue;
                if (p == moi || p.isLocalPlayer() || p.isInvisible()) continue;
                float x = p.getX(), y = p.getY();
                if (!Float.isFinite(x) || !Float.isFinite(y) || x <= 0f || y <= 0f) continue;
                if (!vus.add(p.getOnlineID())) continue;
                l.add(new Autre(p.getOnlineID(), p.getUsername(), x, y, p.getZ(),
                        p.getDirectionAngleRadians(), p.getVehicle() != null, p.isDead(), true));
            }
        } catch (Throwable e) {
            // liste modifiee pendant la copie : on refera a la prochaine seconde
        }
        try {
            WorldMapRemotePlayers carte = WorldMapRemotePlayers.instance;
            if (carte != null) {
                for (Object o : carte.getPlayers().toArray()) {
                    if (!(o instanceof WorldMapRemotePlayer r)) continue;
                    if (r.isInvisible() && !r.canSeeInvisiblePlayer()) continue;
                    float x = r.getX(), y = r.getY();
                    if (!Float.isFinite(x) || !Float.isFinite(y) || x <= 0f || y <= 0f) continue;
                    if (!vus.add(r.getOnlineID())) continue;
                    l.add(new Autre(r.getOnlineID(), r.hasFullData() ? r.getUsername() : null,
                            x, y, null, null, false, false, false));
                }
            }
        } catch (Throwable e) {
            // idem
        }
        return l;
    }

    /** Les autres joueurs en tableau JSON, pour position.json. */
    private static String json(List<Autre> l) {
        StringBuilder sb = new StringBuilder(256).append('[');
        for (int i = 0; i < l.size(); i++) {
            Autre o = l.get(i);
            if (i > 0) sb.append(',');
            if (o.proche()) {
                sb.append(String.format(Locale.ROOT,
                        "{\"id\":%d,\"n\":%s,\"x\":%.2f,\"y\":%.2f,\"z\":%.2f,\"a\":%.3f,\"v\":%d,\"m\":%d,\"p\":1}",
                        o.id(), chaine(o.nom()), o.x(), o.y(), o.z(), o.a(),
                        o.v() ? 1 : 0, o.m() ? 1 : 0));
            } else {
                sb.append(String.format(Locale.ROOT,
                        "{\"id\":%d,\"n\":%s,\"x\":%.2f,\"y\":%.2f,\"p\":0}",
                        o.id(), chaine(o.nom()), o.x(), o.y()));
            }
        }
        return sb.append(']').toString();
    }

    /** Chaine JSON complete, ou null. Un pseudo peut contenir n'importe quoi. */
    static String chaine(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> {
                    if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
                }
            }
        }
        return b.append('"').toString();
    }

    /** Echappement JSON minimal : les noms de sprites sont alphanumeriques. */
    private static String echapper(String s) {
        if (s.indexOf('"') < 0 && s.indexOf('\\') < 0) return s;
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
