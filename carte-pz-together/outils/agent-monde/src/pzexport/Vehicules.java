package pzexport;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import org.joml.Vector3f;

import zombie.GameTime;
import zombie.characters.IsoGameCharacter;
import zombie.characters.IsoPlayer;
import zombie.core.Translator;
import zombie.inventory.InventoryItem;
import zombie.inventory.ItemContainer;
import zombie.iso.IsoCell;
import zombie.iso.IsoWorld;
import zombie.scripting.objects.VehicleScript;
import zombie.vehicles.BaseVehicle;
import zombie.vehicles.VehiclePart;

/**
 * Lecture des vehicules que le client a en memoire.
 *
 * Source : IsoCell.getVehicles(), les vehicules de la zone chargee autour du
 * joueur. C'est ce que le jeu dessine et simule : un vehicule hors de cette
 * zone n'existe pas pour le client, il ne peut donc pas etre releve.
 *
 * IDENTIFIANT
 * Il faut une cle stable d'une session a l'autre pour dire "deja vu". L'id
 * reseau (getId) est attribue par le serveur a chaque chargement, et sqlId est
 * l'index de la base LOCALE du client. Reste keyId : tire au hasard a la
 * creation du vehicule, sauvegarde avec lui, et partage par sa cle de
 * contact. C'est la cle "k<keyId>". Sans keyId (-1), repli sur l'id reseau,
 * marque "n<id>" : valable pour la session seulement.
 *
 * Tout est lu depuis un thread qui n'est pas celui du jeu. Chaque vehicule est
 * isole dans un try : une lecture ratee le saute, il revient au passage
 * suivant.
 */
final class Vehicules {

    private Vehicules() { }

    /** Un vehicule releve : sa cle, sa position, son cap (tel qu'ecrit dans la
     *  fiche, voir lireUn), et sa fiche JSON complete. */
    record Releve(String cle, float x, float y, float capX, float capY,
                  String signature, String json) { }

    /** L'heure du monde de jeu, "AAAA-MM-JJ HH:MM", ou null au menu. */
    static String heureJeu() {
        try {
            GameTime g = GameTime.getInstance();
            if (g == null) return null;
            // Mois et jour sont comptes a partir de 0 dans GameTime.
            return String.format(Locale.ROOT, "%04d-%02d-%02d %02d:%02d",
                    g.getYear(), g.getMonth() + 1, g.getDay() + 1, g.getHour(), g.getMinutes());
        } catch (Throwable e) {
            return null;
        }
    }

    /** Jours ecoules dans le monde, pour afficher "jour 34". */
    static double heuresMonde() {
        try {
            GameTime g = GameTime.getInstance();
            return g == null ? -1 : g.getWorldAgeHours();
        } catch (Throwable e) {
            return -1;
        }
    }

    private static float fini(float f) { return Float.isFinite(f) ? f : -1f; }

    static List<Releve> lire(IsoPlayer moi) {
        List<Releve> l = new ArrayList<>();
        IsoWorld monde = IsoWorld.instance;
        if (monde == null) return l;
        IsoCell cell = monde.getCell();
        if (cell == null) return l;
        Object[] tous;
        try {
            tous = cell.getVehicles().toArray();
        } catch (Throwable e) {
            return l;   // ensemble modifie pendant la copie : au prochain passage
        }
        ItemContainer inventaire = null;
        try { if (moi != null) inventaire = moi.getInventory(); } catch (Throwable ignore) { }
        for (Object o : tous) {
            if (!(o instanceof BaseVehicle v)) continue;
            try {
                Releve r = lireUn(v, inventaire);
                if (r != null) l.add(r);
            } catch (Throwable e) {
                // vehicule en cours de chargement ou de retrait
            }
        }
        return l;
    }

    private static Releve lireUn(BaseVehicle v, ItemContainer inventaire) {
        if (v.isRemovedFromWorld()) return null;
        float x = v.getX(), y = v.getY(), z = v.getZ();
        if (!Float.isFinite(x) || !Float.isFinite(y) || x <= 0f || y <= 0f) return null;

        int keyId = v.getKeyId();
        String cle = keyId != -1 ? "k" + keyId : "n" + v.getId();

        VehicleScript s = v.getScript();
        String script = v.getScriptName();
        String nom = null, type = null;
        if (s != null) {
            String modele = s.getCarModelName() != null ? s.getCarModelName() : s.getName();
            nom = Translator.getTextOrNull("IGUI_VehicleName" + modele);
            if (nom == null && s.getName() != null && s.getName().contains("Burnt")) {
                String intact = Translator.getTextOrNull("IGUI_VehicleName" + s.getName().replace("Burnt", ""));
                nom = intact != null ? intact + " (carcasse brulee)" : null;
            }
            type = Translator.getTextOrNull("IGUI_VehicleType_" + s.getMechanicType());
        }

        // Etat : moyenne des pieces POSEES. Une piece absente n'a pas d'etat,
        // elle est comptee a part (pneus manquants surtout).
        int somme = 0, poses = 0, pneus = 0, pneusPoses = 0, objets = 0;
        for (int i = 0; i < v.getPartCount(); i++) {
            VehiclePart p = v.getPartByIndex(i);
            if (p == null) continue;
            String id = p.getId();
            boolean pneu = id != null && id.startsWith("Tire");
            InventoryItem item = p.getInventoryItem();
            if (pneu) pneus++;
            if (item != null) {
                somme += p.getCondition();
                poses++;
                if (pneu) pneusPoses++;
            }
            ItemContainer c = p.getItemContainer();
            if (c != null) {
                try { objets += c.getItems().size(); } catch (Throwable ignore) { }
            }
        }

        VehiclePart reservoir = v.getGasTank();
        float essence = -1f, capacite = -1f;
        if (reservoir != null && reservoir.getInventoryItem() != null) {
            essence = reservoir.getContainerContentAmount();
            capacite = reservoir.getContainerCapacity();
        }
        VehiclePart batterie = v.getBattery();
        float charge = (batterie != null && batterie.getInventoryItem() != null) ? v.getBatteryCharge() : -1f;
        // Un NaN ecrit tel quel rendrait tout le fichier illisible en JSON.
        essence = fini(essence); capacite = fini(capacite); charge = fini(charge);

        boolean jaiLaCle = false;
        if (inventaire != null && keyId != -1) {
            try { jaiLaCle = inventaire.haveThisKeyId(keyId) != null; } catch (Throwable ignore) { }
        }
        String conducteur = null;
        IsoGameCharacter d = v.getDriver();
        if (d instanceof IsoPlayer p) conducteur = p.getUsername();
        else if (d != null) conducteur = "?";

        // Cap : le vecteur avant du vehicule, dans le repere physique (x, y
        // vers le haut, z). ATTENTION : le signe de z est faux, la carte suit
        // (x, +z) (voir BaseVehicle.getWorldPos). La carte le corrige a la
        // lecture (out/html/vehicules.py, _corriger_cap) pour reparer aussi le
        // journal deja ecrit : ne pas changer ce signe ici sans retirer
        // cette correction.
        float capX = 0f, capY = 0f;
        try {
            Vector3f avant = v.getForwardVector(new Vector3f());
            capX = fini(avant.x);
            capY = fini(-avant.z);
        } catch (Throwable ignore) { }

        int etat = poses > 0 ? Math.round((float) somme / poses) : -1;
        boolean toutVerrouille = v.areAllDoorsLocked();
        boolean uneVerrouillee = v.isAnyDoorLocked();

        StringBuilder b = new StringBuilder(512);
        b.append("{\"k\":").append(Agent.chaine(cle))
         .append(",\"id\":").append(v.getId())
         .append(",\"s\":").append(Agent.chaine(script))
         .append(",\"n\":").append(Agent.chaine(nom))
         .append(",\"ty\":").append(Agent.chaine(type))
         .append(String.format(Locale.ROOT, ",\"x\":%.1f,\"y\":%.1f,\"z\":%.1f", x, y, z))
         .append(String.format(Locale.ROOT, ",\"cap\":[%.3f,%.3f]", capX, capY))
         .append(String.format(Locale.ROOT, ",\"c\":[%.3f,%.3f,%.3f]",
                 fini(v.getColorHue()), fini(v.getColorSaturation()), fini(v.getColorValue())))
         .append(",\"skin\":").append(v.getSkinIndex())
         .append(",\"etat\":").append(etat)
         .append(",\"moteur\":").append(v.getEngineCondition())
         .append(",\"qualite\":").append(v.getEngineQuality())
         .append(",\"puissance\":").append(v.getEnginePower())
         .append(String.format(Locale.ROOT, ",\"essence\":%.1f,\"reservoir\":%.1f,\"batterie\":%.2f",
                 essence, capacite, charge))
         .append(",\"pneus\":[").append(pneusPoses).append(',').append(pneus).append(']')
         .append(",\"objets\":").append(objets)
         .append(",\"verr\":").append(toutVerrouille ? 2 : uneVerrouillee ? 1 : 0)
         .append(",\"coffre\":").append(v.isTrunkLocked() ? 1 : 0)
         .append(",\"contact\":").append(v.isKeysInIgnition() ? 1 : 0)
         .append(",\"porte\":").append(v.isKeyIsOnDoor() ? 1 : 0)
         .append(",\"cable\":").append(v.isHotwired() ? 1 : 0)
         .append(",\"macle\":").append(jaiLaCle ? 1 : 0)
         .append(",\"alarme\":").append(v.isAlarmed() ? 1 : 0)
         .append(",\"marche\":").append(v.isEngineRunning() ? 1 : 0)
         .append(String.format(Locale.ROOT, ",\"vit\":%.0f", Math.abs(fini(v.getCurrentSpeedKmHour()))))
         .append(",\"cond\":").append(Agent.chaine(conducteur))
         .append(",\"remorque\":").append(v.getVehicleTowing() != null ? 1 : 0)
         .append('}');

        // Ce qui justifie une nouvelle ligne au journal quand ca change.
        // Arrondis : l'essence d'un moteur qui tourne baisse en continu, une
        // ligne par lecture n'apprendrait rien.
        int essencePct = capacite > 0 ? Math.round(essence / capacite * 20) * 5 : -1;
        String signature = etat / 5 + "|" + v.getEngineCondition() / 5 + "|" + essencePct
                + "|" + (charge < 0 ? -1 : Math.round(charge * 10)) + "|" + pneusPoses
                + "|" + (toutVerrouille ? 2 : uneVerrouillee ? 1 : 0)
                + "|" + (v.isKeysInIgnition() ? 1 : 0) + (v.isKeyIsOnDoor() ? 1 : 0)
                + (v.isHotwired() ? 1 : 0) + (jaiLaCle ? 1 : 0) + "|" + objets;
        return new Releve(cle, x, y, capX, capY, signature, b.toString());
    }
}
