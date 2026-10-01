package pzexport;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import se.krka.kahlua.vm.KahluaTable;
import se.krka.kahlua.vm.KahluaTableIterator;
import zombie.characters.CharacterStat;
import zombie.characters.IsoGameCharacter;
import zombie.characters.IsoPlayer;
import zombie.characters.Stats;
import zombie.characters.SurvivorDesc;
import zombie.characters.AttachedItems.AttachedItem;
import zombie.characters.AttachedItems.AttachedItems;
import zombie.characters.BodyDamage.BodyDamage;
import zombie.characters.BodyDamage.BodyPart;
import zombie.characters.BodyDamage.BodyPartType;
import zombie.characters.BodyDamage.Nutrition;
import zombie.characters.BodyDamage.Thermoregulator;
import zombie.characters.Moodles.Moodles;
import zombie.characters.WornItems.WornItem;
import zombie.characters.WornItems.WornItems;
import zombie.characters.professions.CharacterProfessionDefinition;
import zombie.characters.skills.PerkFactory;
import zombie.characters.skills.PerkFactory.Perk;
import zombie.characters.skills.PerkFactory.Perks;
import zombie.characters.traits.CharacterTraitDefinition;
import zombie.core.Translator;
import zombie.core.textures.Texture;
import zombie.inventory.InventoryItem;
import zombie.inventory.types.Clothing;
import zombie.inventory.types.HandWeapon;
import zombie.inventory.types.WeaponPart;
import zombie.scripting.objects.CharacterProfession;
import zombie.scripting.objects.CharacterTrait;
import zombie.scripting.objects.MoodleType;

/**
 * La fiche du personnage, au format du mod PZ Pulse.
 *
 * PZ Pulse (mod Workshop de qwerto) ecrit l'etat du personnage dans
 * Zomboid/Lua/PZ_Pulse/data.txt et sa page web le relit. Le mod n'est pas
 * installe sur le serveur, il ne peut donc pas tourner : cette classe refait
 * ses collecteurs (PZ_Pulse_Collectors.lua) en Java, avec les memes getters,
 * et produit LE MEME objet JSON. La page du mod l'affiche alors telle quelle,
 * servie par le serveur de la carte (voir serveur.py, /pulse/).
 *
 * Chaque bloc est isole : un getter qui leve ne vide qu'un panneau, comme le
 * pcall du mod. Lu depuis un thread qui n'est pas celui du jeu, comme le reste
 * de l'agent : au pire une valeur d'une image en retard.
 *
 * Ecarts connus avec le mod :
 *   - "quickload" : la barre d'actions rapides est un objet Lua (ISHotbar),
 *     invisible depuis Java. On donne a la place les objets accroches au
 *     personnage (AttachedItems), qui sont ce que la barre affiche.
 *   - pas d'extensions (ext.txt), pas de langue (lang.txt) : la page retombe
 *     sur ses textes anglais, les valeurs venant du jeu restent traduites.
 */
final class Pulse {

    private Pulse() { }

    // ---- petits outils ----------------------------------------------------

    private static int pct01(double v) {
        if (!(v > 0)) v = 0; else if (v > 1) v = 1;
        return (int) Math.floor(v * 100 + 0.5);
    }
    private static double round1(double v) { return Math.floor(v * 10 + 0.5) / 10; }
    private static double round2(double v) { return Math.floor(v * 100 + 0.5) / 100; }
    private static int rnd(double v) { return (int) Math.floor(v + 0.5); }

    /** Translator.getText sans ses defauts : null si la cle n'existe pas. */
    private static String tr(String cle) {
        try {
            String s = Translator.getTextOrNull(cle);
            return (s == null || s.isEmpty()) ? null : s;
        } catch (Throwable e) {
            return null;
        }
    }
    private static String tr(String cle, String defaut) {
        String s = tr(cle);
        return s != null ? s : defaut;
    }
    private static String texName(Texture t) {
        try { return t != null ? t.getName() : null; } catch (Throwable e) { return null; }
    }

    /** Un getter qui peut lever. */
    private interface G<T> { T get() throws Throwable; }
    private static <T> T sur(G<T> g, T defaut) {
        try { T v = g.get(); return v != null ? v : defaut; } catch (Throwable e) { return defaut; }
    }

    // ---- assemblage -------------------------------------------------------

    /** L'objet complet, cle -> valeur, dans l'ordre du mod. */
    static Map<String, Object> lire(IsoPlayer p, int intervalle) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("interval", intervalle);
        bloc(d, "info", () -> info(p));
        bloc(d, "recent", () -> recettes(p));
        bloc(d, "encumbrance", () -> charge(p));
        bloc(d, "health", () -> sante(p));
        bloc(d, "protection", () -> protection(p));
        bloc(d, "clothing", () -> vetements(p));
        bloc(d, "weapon", () -> armes(p));
        bloc(d, "quickload", () -> accroches(p));
        bloc(d, "bodytemp", () -> temperature(p));
        bloc(d, "needs", () -> besoins(p));
        bloc(d, "moodles", () -> humeurs(p));
        bloc(d, "skills", () -> competences(p));
        return d;
    }

    private static int erreursSignalees = 0;
    private static final Set<String> signales = new HashSet<>();

    private static void bloc(Map<String, Object> d, String cle, G<Object> g) {
        try {
            d.put(cle, g.get());
        } catch (Throwable e) {
            // Une fois par bloc et par session : la boucle tourne chaque seconde.
            if (signales.add(cle) && erreursSignalees++ < 20) {
                System.out.println("[pz-export] pulse : bloc " + cle + " ignore : " + e);
            }
        }
    }

    // ---- info -------------------------------------------------------------

    private static final Set<String> TRAITS_POIDS =
            Set.of("emaciated", "veryunderweight", "underweight", "overweight", "obese");

    private static Map<String, Object> info(IsoPlayer p) {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("sex", p.isFemale() ? "Female" : "Male");
        SurvivorDesc desc = sur(p::getDescriptor, null);
        if (desc != null) {
            String nom = (sur(desc::getForename, "") + " " + sur(desc::getSurname, "")).trim();
            o.put("name", nom);
            CharacterProfession prof = sur(desc::getCharacterProfession, null);
            if (prof != null) {
                CharacterProfessionDefinition def =
                        sur(() -> CharacterProfessionDefinition.getCharacterProfessionDefinition(prof), null);
                if (def != null) {
                    o.put("profession", sur(def::getUIName, null));
                    o.put("professionTex", sur(() -> texName(def.getTexture()), null));
                }
            }
        }
        Nutrition n = sur(p::getNutrition, null);
        if (n != null) {
            o.put("weight", rnd(n.getWeight()));
            String t = "stable";
            if (sur(n::isIncWeightLot, false)) t = "upLot";
            else if (sur(n::isIncWeight, false)) t = "up";
            else if (sur(n::isDecWeight, false)) t = "down";
            o.put("weightTrend", t);
        }
        List<Object> traits = new ArrayList<>();
        List<CharacterTrait> connus = sur(() -> new ArrayList<>(p.getCharacterTraits().getKnownTraits()), List.of());
        for (CharacterTrait tid : connus) {
            CharacterTraitDefinition def = sur(() -> CharacterTraitDefinition.getCharacterTraitDefinition(tid), null);
            if (def == null) continue;
            String label = sur(def::getLabel, null);
            String tex = sur(() -> texName(def.getTexture()), null);
            String cle = String.valueOf(tid).toLowerCase(Locale.ROOT).replaceFirst("^base:", "").replaceAll("\\s+", "");
            if (TRAITS_POIDS.contains(cle) && label != null && !label.isEmpty()) {
                o.put("weightTrait", label);
                o.put("weightTraitTex", tex);
            }
            if (tex != null && label != null && !label.isEmpty()) {
                Map<String, Object> t = new LinkedHashMap<>();
                t.put("label", label);
                t.put("desc", sur(def::getDescription, ""));
                t.put("tex", tex);
                traits.add(t);
            }
        }
        o.put("traits", traits);
        // Arme favorite : le jeu compte les coups par arme dans modData["Fav:<nom>"].
        String fav = null;
        double coups = 0;
        try {
            KahluaTable md = p.getModData();
            KahluaTableIterator it = md != null ? md.iterator() : null;
            while (it != null && it.advance()) {
                if (it.getKey() instanceof String k && k.startsWith("Fav:")
                        && it.getValue() instanceof Double v && v > coups) {
                    fav = k.substring(4);
                    coups = v;
                }
            }
        } catch (Throwable ignore) { }
        o.put("favWeapon", fav);
        o.put("zombieKills", sur(p::getZombieKills, 0));
        o.put("timeSurvived", sur(p::getTimeSurvived, null));
        return o;
    }

    // ---- recettes apprises --------------------------------------------------

    private static Set<String> recettesBase = null;
    private static IsoPlayer recettesJoueur = null;
    private static int recettesTaille = -1, recettesSeq = 0;
    private static List<String> recettesNoms = List.of();

    private static Map<String, Object> recettes(IsoPlayer p) {
        Map<String, Object> o = new LinkedHashMap<>();
        List<String> connues = sur(() -> new ArrayList<>(p.getKnownRecipes()), null);
        if (connues != null) {
            if (recettesBase == null || recettesJoueur != p) {
                recettesBase = new HashSet<>(connues);
                recettesJoueur = p;
                recettesTaille = connues.size();
            } else if (connues.size() != recettesTaille) {
                List<String> lot = new ArrayList<>();
                for (String r : connues) {
                    if (recettesBase.add(r)) lot.add(sur(() -> Translator.getRecipeName(r), r));
                }
                recettesTaille = connues.size();
                if (!lot.isEmpty()) { recettesSeq++; recettesNoms = lot; }
            }
        }
        o.put("seq", recettesSeq);
        o.put("names", recettesNoms);
        return o;
    }

    // ---- charge -----------------------------------------------------------

    private static Map<String, Object> charge(IsoPlayer p) {
        Map<String, Object> o = new LinkedHashMap<>();
        double charge = p.getInventoryWeight(), max = p.getMaxWeight();
        if (!(max > 0)) return o;
        o.put("load", round1(charge));
        o.put("max", round1(max));
        o.put("ratio", rnd(charge / max * 100));
        int lvl = sur(() -> p.getMoodles().getMoodleLevel(MoodleType.HEAVY_LOAD), 0);
        o.put("level", lvl);
        if (lvl >= 1) o.put("tier", tr("Moodles_HeavyLoad_lvl" + lvl, "Heavy load"));
        o.put("icon", "status_heavyload");
        return o;
    }

    // ---- competences ------------------------------------------------------

    private record Comp(int id, Perk perk, String nom) { }
    private static List<String> compOrdre = null;
    private static Map<String, List<Comp>> compGroupes = null;

    private static void squelette() {
        if (compOrdre != null) return;
        Map<String, List<Comp>> groupes = new HashMap<>();
        Map<String, Boolean> passif = new HashMap<>();
        int max = Perks.getMaxIndex();
        for (int i = 0; i < max; i++) {
            Perk type = Perks.fromIndex(i);
            Perk perk = type != null ? PerkFactory.getPerk(type) : null;
            if (perk == null || perk.getParent() == Perks.None || perk.getParent() == null) continue;
            Perk parent = perk.getParent();
            String cat = sur(() -> PerkFactory.getPerkName(parent), "Other");
            if (!groupes.containsKey(cat)) {
                groupes.put(cat, new ArrayList<>());
                passif.put(cat, sur(() -> PerkFactory.getPerk(parent).isPassiv(), false));
            }
            groupes.get(cat).add(new Comp(i, perk, sur(perk::getName, "?")));
        }
        List<String> ordre = new ArrayList<>(groupes.keySet());
        for (List<Comp> l : groupes.values()) l.sort(Comparator.comparing(c -> c.nom().toLowerCase(Locale.ROOT)));
        ordre.sort((a, b) -> {
            boolean pa = passif.get(a), pb = passif.get(b);
            if (pa != pb) return pa ? -1 : 1;           // categories passives d'abord
            return a.toLowerCase(Locale.ROOT).compareTo(b.toLowerCase(Locale.ROOT));
        });
        if (!ordre.isEmpty()) { compOrdre = ordre; compGroupes = groupes; }
    }

    private static Map<String, Object> competences(IsoPlayer p) {
        squelette();
        Map<String, Object> o = new LinkedHashMap<>();
        if (compOrdre == null) { o.put("order", List.of()); o.put("groups", Map.of()); return o; }
        IsoGameCharacter.XP xp = sur(p::getXp, null);
        Map<String, Object> groupes = new LinkedHashMap<>();
        for (String cat : compOrdre) {
            List<Object> lignes = new ArrayList<>();
            for (Comp c : compGroupes.get(cat)) {
                int niv = sur(() -> p.getPerkLevel(c.perk()), 0);
                double prog = 0;
                Double lvlXp = null, lvlNeed = null;
                if (niv < 10 && xp != null) {
                    double debut = sur(() -> (double) c.perk().getTotalXpForLevel(niv), 0d);
                    double suite = sur(() -> (double) c.perk().getTotalXpForLevel(niv + 1), 0d);
                    double cur = sur(() -> (double) xp.getXP(c.perk()), 0d);
                    if (suite > debut) prog = (cur - debut) / (suite - debut);
                    lvlXp = cur - debut;
                    lvlNeed = suite - debut;
                } else if (niv >= 10) {
                    prog = 1;
                }
                float mult = xp != null ? sur(() -> xp.getMultiplier(c.perk()), 0f) : 0f;
                Map<String, Object> l = new LinkedHashMap<>();
                l.put("id", c.id());
                l.put("name", c.nom());
                l.put("level", niv);
                l.put("progress", pct01(prog));
                if (lvlXp != null) l.put("xp", round2(lvlXp));
                if (lvlNeed != null) l.put("xpNext", rnd(lvlNeed));
                if (mult > 0) l.put("mult", true);
                lignes.add(l);
            }
            groupes.put(cat, lignes);
        }
        o.put("order", compOrdre);
        o.put("groups", groupes);
        return o;
    }

    // ---- sante ------------------------------------------------------------

    private static final String W = "wound", HOT = "hot", OK = "treat", MINOR = "minor";
    private static final Map<String, Integer> PRIO = Map.of(W, 4, HOT, 3, MINOR, 2, OK, 1);

    private static String sev(int doc, int besoin, double t, double sevT, double modT) {
        if (doc <= besoin) return "";
        if (t > sevT) return " (" + tr("IGUI_health_Severe", "Severe") + ")";
        if (t > modT) return " (" + tr("IGUI_health_Moderate", "Moderate") + ")";
        return "";
    }

    /** Les lignes du panneau de sante du jeu pour une partie du corps (ISHealthPanel). */
    private static List<Map<String, Object>> lignesPartie(BodyPart bp, int doc) {
        List<Map<String, Object>> l = new ArrayList<>();
        java.util.function.BiConsumer<String, String> add = (t, c) -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("t", t);
            m.put("c", c);
            l.add(m);
        };
        if (sur(bp::getPlantainFactor, 0f) > 0) add.accept("- " + tr("ContextMenu_PlantainCataplasm", "Plantain"), OK);
        if (sur(bp::getComfreyFactor, 0f) > 0) add.accept("- " + tr("ContextMenu_ComfreyCataplasm", "Comfrey"), OK);
        if (sur(bp::getGarlicFactor, 0f) > 0) add.accept("- " + tr("ContextMenu_GarlicCataplasm", "Garlic"), OK);
        if (sur(bp::scratched, false))
            add.accept("- " + tr("IGUI_health_Scratched", "Scratched") + sev(doc, 2, sur(bp::getScratchTime, 0f), 17, 14), W);
        if (sur(bp::isCut, false))
            add.accept("- " + tr("IGUI_health_Cut", "Cut") + sev(doc, 2, sur(bp::getCutTime, 0f), 17, 14), W);
        if (sur(bp::deepWounded, false))
            add.accept("- " + tr("IGUI_health_DeepWound", "Deep wound") + " " + sev(doc, 4, sur(bp::getDeepWoundTime, 0f), 10, 8), W);
        if (sur(bp::bitten, false)) add.accept("- " + tr("IGUI_health_Bitten", "Bitten"), W);
        float douleur = sur(() -> bp.getAdditionalPain(), 0f);
        if (douleur > 50) add.accept("- " + tr("IGUI_health_HeavyPain", "Heavy pain"), W);
        else if (douleur > 10) add.accept("- " + tr("IGUI_health_Pain", "Pain"), W);
        float raideur = sur(bp::getStiffness, 0f);
        if (raideur >= 5) {
            if (raideur < 20) add.accept("- " + tr("IGUI_health_MinorStiffness", "Minor stiffness"), MINOR);
            else add.accept("- " + tr("IGUI_health_Stiffness", "Stiffness"), W);
        }
        if (sur(bp::bleeding, false)) add.accept("- " + tr("IGUI_health_Bleeding", "Bleeding"), W);
        float attelle = sur(bp::getSplintFactor, 0f), fracture = sur(bp::getFractureTime, 0f);
        if (fracture > 0 && attelle == 0)
            add.accept("- " + tr("IGUI_health_Fracture", "Fracture") + " " + sev(doc, 6, fracture, 50, 20), W);
        if (attelle > 0) {
            String s = "";
            if (doc > 4) {
                if (attelle > 4) s = " (" + tr("IGUI_health_Good", "Good") + ")";
                else if (fracture > 2) s = " (" + tr("IGUI_health_Moderate", "Moderate") + ")";
            }
            add.accept("- " + tr("IGUI_health_Splinted", "Splinted") + " " + s, OK);
        }
        boolean bande = sur(bp::bandaged, false);
        if (bande) {
            if (sur(bp::getBandageLife, 0f) > 0) add.accept("- " + tr("IGUI_health_Bandaged", "Bandaged"), OK);
            else add.accept("- " + tr("IGUI_health_DirtyBandage", "Dirty bandage"), HOT);
        }
        if (sur(bp::isInfectedWound, false) && !bande) {
            float lvl = sur(bp::getWoundInfectionLevel, 0f);
            if (doc > 8 || lvl * 10 >= (2.5 - doc)) add.accept("- " + tr("IGUI_health_Infected", "Infected"), HOT);
        }
        if (sur(bp::haveBullet, false) && !bande) add.accept("- " + tr("IGUI_health_LodgedBullet", "Lodged bullet"), W);
        if (sur(bp::getBurnTime, 0f) > 0 && !bande) {
            String b = "";
            if (doc > 4 && sur(bp::isNeedBurnWash, false)) b = " (" + tr("IGUI_health_NeedCleaning", "Needs cleaning") + ")";
            add.accept("- " + tr("IGUI_health_Burned", "Burned") + b, W);
        }
        if (sur(bp::stitched, false)) {
            String s = "";
            if (doc > 6) s = sur(bp::getStitchTime, 0f) > 40
                    ? " (" + tr("IGUI_health_Good", "Good") + ")"
                    : " (" + tr("IGUI_health_NeedTime", "Needs time") + ")";
            add.accept("- " + tr("IGUI_health_Stitched", "Stitched") + s, OK);
        }
        if (sur(bp::haveGlass, false) && !bande) add.accept("- " + tr("IGUI_health_LodgedGlassShards", "Glass shards"), W);
        return l;
    }

    private static final String[] PALIERS = {
        "IGUI_health_Slight_damage", "IGUI_health_Very_Minor_damage", "IGUI_health_Minor_damage",
        "IGUI_health_Moderate_damage", "IGUI_health_Severe_damage", "IGUI_health_Very_Severe_damage",
        "IGUI_health_Crital_damage", "IGUI_health_Highly_Crital_damage", "IGUI_health_Terminal_damage",
    };

    private static String etatSante(double h) {
        if (h <= 0) return tr("IGUI_health_Deceased", "Deceased");
        if (h >= 100) return tr("IGUI_health_ok", "OK");
        int i = (int) Math.floor((100 - h) / 100 * PALIERS.length);
        i = Math.max(0, Math.min(PALIERS.length - 1, i));
        return tr(PALIERS[i], "");
    }

    private static Map<String, Object> sante(IsoPlayer p) {
        Map<String, Object> o = new LinkedHashMap<>();
        BodyDamage bd = p.getBodyDamage();
        double global = sur(bd::getHealth, 0f);
        int doc = sur(() -> p.getPerkLevel(Perks.Doctor), 0);
        List<Object> parties = new ArrayList<>();
        List<BodyPart> liste = sur(() -> new ArrayList<>(bd.getBodyParts()), List.of());
        for (BodyPart bp : liste) {
            if (bp == null) continue;
            List<String> flags = new ArrayList<>();
            if (sur(bp::bleeding, false)) flags.add("Bleeding");
            if (sur(bp::isDeepWounded, false)) flags.add("Deep wound");
            if (sur(bp::getFractureTime, 0f) > 0) flags.add("Fracture");
            if (sur(bp::getBurnTime, 0f) > 0) flags.add("Burn");
            if (sur(bp::bitten, false)) flags.add("Bitten");
            if (sur(bp::scratched, false)) flags.add("Scratched");
            if (sur(bp::isCut, false)) flags.add("Cut");
            if (sur(bp::haveBullet, false)) flags.add("Bullet");
            if (sur(bp::haveGlass, false)) flags.add("Glass");
            if (sur(bp::isInfectedWound, false)) flags.add("Infected");
            if (sur(bp::bandaged, false)) flags.add("Bandaged");
            if (sur(bp::getSplintFactor, 0f) > 0) flags.add("Splinted");
            List<Map<String, Object>> lignes = lignesPartie(bp, doc);
            String pin = null;
            int meilleur = 0;
            for (Map<String, Object> ln : lignes) {
                int pr = PRIO.getOrDefault((String) ln.get("c"), 0);
                if (pr > meilleur) { meilleur = pr; pin = (String) ln.get("c"); }
            }
            BodyPartType type = bp.getType();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", sur(() -> BodyPartType.getDisplayName(type), "?"));
            m.put("idx", sur(() -> BodyPartType.ToIndex(type), null));
            m.put("health", rnd(sur(bp::getHealth, 0f)));
            m.put("flags", flags);
            m.put("lines", lignes);
            if (pin != null) m.put("pinCls", pin);
            parties.add(m);
        }
        o.put("overall", rnd(global));
        o.put("status", etatSante(global));
        o.put("sex", p.isFemale() ? "female" : "male");
        o.put("parts", parties);
        return o;
    }

    // ---- protection, vetements, armes -------------------------------------

    private static final List<String> PARTIES_PROTECTION = List.of(
            "Hand_L", "Hand_R", "ForeArm_L", "ForeArm_R", "UpperArm_L", "UpperArm_R",
            "Torso_Upper", "Torso_Lower", "Head", "Neck", "Groin",
            "UpperLeg_L", "UpperLeg_R", "LowerLeg_L", "LowerLeg_R", "Foot_L", "Foot_R");

    private static Map<String, Object> protection(IsoPlayer p) {
        List<Object> parties = new ArrayList<>();
        int max = BodyPartType.ToIndex(BodyPartType.MAX);
        for (int i = 0; i <= max; i++) {
            final int k = i;
            BodyPartType type = sur(() -> BodyPartType.FromIndex(k), null);
            String cle = type != null ? sur(() -> BodyPartType.ToString(type), null) : null;
            if (cle == null || !PARTIES_PROTECTION.contains(cle)) continue;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", sur(() -> BodyPartType.getDisplayName(type), cle));
            m.put("idx", sur(() -> BodyPartType.ToIndex(type), null));
            m.put("bite", rnd(sur(() -> p.getBodyPartClothingDefense(k, true, false), 0f)));
            m.put("scratch", rnd(sur(() -> p.getBodyPartClothingDefense(k, false, false), 0f)));
            parties.add(m);
        }
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("parts", parties);
        o.put("sex", p.isFemale() ? "female" : "male");
        return o;
    }

    private static Map<String, Object> vetements(IsoPlayer p) {
        List<Object> items = new ArrayList<>();
        WornItems worn = p.getWornItems();
        int n = worn != null ? worn.size() : 0;
        for (int i = 0; i < n; i++) {
            final int k = i;
            WornItem e = sur(() -> worn.get(k), null);
            InventoryItem it = e != null ? sur(e::getItem, null) : null;
            if (!(it instanceof Clothing c) || sur(c::isHidden, false)) continue;
            int condMax = sur(c::getConditionMax, 0), cond = sur(c::getCondition, 0);
            int insul = rnd(sur(c::getInsulation, 0f) * 100);
            int bite = rnd(sur(c::getBiteDefense, 0f)), scratch = rnd(sur(c::getScratchDefense, 0f));
            if (insul <= 0 && bite <= 0 && scratch <= 0) continue;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", sur(c::getName, "?"));
            if (condMax > 0) m.put("cond", rnd((double) cond / condMax * 100));
            m.put("holes", sur(c::getHolesNumber, 0));
            m.put("bite", bite);
            m.put("scratch", scratch);
            m.put("insul", insul);
            items.add(m);
        }
        return Map.of("items", items);
    }

    private static Integer condPct(InventoryItem it) {
        int mx = sur(it::getConditionMax, 0), c = sur(it::getCondition, 0);
        return mx > 0 ? rnd((double) c / mx * 100) : null;
    }

    private static Map<String, Object> armes(IsoPlayer p) {
        List<Object> items = new ArrayList<>();
        InventoryItem a = sur(p::getPrimaryHandItem, null), b = sur(p::getSecondaryHandItem, null);
        if (a instanceof HandWeapon w) items.add(arme(w, p));
        if (b instanceof HandWeapon w && b != a) items.add(arme(w, p));
        return Map.of("items", items);
    }

    private static Map<String, Object> arme(HandWeapon w, IsoPlayer p) {
        Map<String, Object> e = new LinkedHashMap<>();
        boolean distance = sur(w::isRanged, false);
        e.put("name", sur(w::getName, "?"));
        e.put("tex", sur(() -> texName(w.getTexture()), null));
        e.put("ranged", distance);
        e.put("twoHand", sur(w::isTwoHandWeapon, false));
        e.put("cond", condPct(w));
        e.put("broken", sur(w::isBroken, false));
        e.put("repaired", sur(w::getHaveBeenRepaired, 0));
        if (sur(w::hasHeadCondition, false)) {
            int hmx = sur(w::getHeadConditionMax, 0), hc = sur(w::getHeadCondition, 0);
            e.put("hasHead", true);
            if (hmx > 0) e.put("headCond", rnd((double) hc / hmx * 100));
        }
        if (!distance) {
            boolean affutable = sur(w::isSharpenable, false);
            float sv = sur(w::getSharpness, 0f);
            if (affutable || sv > 0) e.put("sharp", pct01(sv));
        }
        e.put("dmgMin", round2(sur(w::getMinDamage, 0f)));
        e.put("dmgMax", round2(sur(w::getMaxDamage, 0f)));
        if (distance) {
            e.put("jammed", sur(w::isJammed, false));
            int cur = sur(w::getCurrentAmmoCount, 0), mx = sur(w::getMaxAmmo, 0);
            if (mx > 0) { e.put("ammo", cur); e.put("ammoMax", mx); }
            if (sur(w::haveChamber, false)) {
                e.put("chambered", sur(w::isRoundChambered, false));
                e.put("spent", sur(w::isSpentRoundChambered, false));
            }
        }
        List<WeaponPart> pieces = sur(() -> new ArrayList<>(w.getDetachableWeaponParts(p)), List.of());
        if (!pieces.isEmpty()) {
            List<Object> l = new ArrayList<>();
            for (WeaponPart wp : pieces) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("name", sur(wp::getName, "?"));
                m.put("cond", condPct(wp));
                m.put("broken", sur(wp::isBroken, false));
                l.add(m);
            }
            e.put("parts", l);
        }
        return e;
    }

    /** A la place de la barre d'actions rapides (Lua) : les objets accroches. */
    private static Map<String, Object> accroches(IsoPlayer p) {
        List<Object> slots = new ArrayList<>();
        AttachedItems ai = p.getAttachedItems();
        int n = ai != null ? ai.size() : 0;
        for (int i = 0; i < n; i++) {
            final int k = i;
            AttachedItem a = sur(() -> ai.get(k), null);
            if (a == null) continue;
            InventoryItem it = sur(a::getItem, null);
            String lieu = sur(a::getLocation, "?");
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("key", i + 1);
            s.put("slot", tr("IGUI_HotbarAttachment_" + lieu, lieu));
            if (it != null) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("name", sur(it::getName, "?"));
                m.put("tex", sur(() -> texName(it.getTexture()), null));
                m.put("equipped", sur(it::isEquipped, false));
                s.put("item", m);
            }
            slots.add(s);
        }
        return Map.of("slots", slots);
    }

    // ---- temperature ------------------------------------------------------

    private static Map<String, Object> temperature(IsoPlayer p) {
        Thermoregulator th = p.getBodyDamage().getThermoregulator();
        if (th == null) return null;
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("core", pct01(sur(th::getCoreTemperatureUI, 0f)));
        o.put("heat", pct01(sur(th::getHeatGenerationUI, 0f)));
        // Pas dans le mod : la temperature en degres, pour l'affichage sur la carte.
        o.put("coreC", round1(sur(th::getCoreTemperature, 0f)));
        o.put("sex", p.isFemale() ? "female" : "male");
        List<Object> parties = new ArrayList<>();
        int max = BodyPartType.ToIndex(BodyPartType.MAX);
        for (int i = 0; i < max; i++) {
            final int k = i;
            BodyPartType type = sur(() -> BodyPartType.FromIndex(k), null);
            if (type == null) continue;
            Thermoregulator.ThermalNode nd = sur(() -> th.getNodeForType(type), null);
            if (nd == null) continue;
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", sur(() -> BodyPartType.getDisplayName(type), "?"));
            m.put("idx", sur(() -> BodyPartType.ToIndex(type), null));
            m.put("skin", pct01(sur(nd::getSkinCelciusUI, 0f)));
            m.put("skinC", round1(sur(nd::getSkinCelcius, 0f)));
            m.put("ins", pct01(sur(nd::getInsulationUI, 0f)));
            m.put("insVal", round2(sur(nd::getInsulation, 0f)));
            parties.add(m);
        }
        o.put("parts", parties);
        return o;
    }

    // ---- besoins et humeurs -----------------------------------------------

    private record Besoin(CharacterStat stat, String label, String lkey, boolean badHigh, String icon) { }
    private static final List<Besoin> BESOINS = List.of(
            new Besoin(CharacterStat.HUNGER, "Hunger", "UI_PZ_Pulse_Need_Hunger", true, "status_hunger"),
            new Besoin(CharacterStat.THIRST, "Thirst", "UI_PZ_Pulse_Need_Thirst", true, "status_thirst"),
            new Besoin(CharacterStat.FATIGUE, "Fatigue", "UI_PZ_Pulse_Need_Fatigue", true, "mood_sleepy"),
            new Besoin(CharacterStat.ENDURANCE, "Stamina", "UI_PZ_Pulse_Need_Stamina", false, "status_difficultybreathing"),
            new Besoin(CharacterStat.BOREDOM, "Boredom", "UI_PZ_Pulse_Need_Boredom", true, "mood_bored"),
            new Besoin(CharacterStat.STRESS, "Stress", "UI_PZ_Pulse_Need_Stress", true, "mood_stressed"),
            new Besoin(CharacterStat.PANIC, "Panic", "UI_PZ_Pulse_Need_Panic", true, "mood_panicked"),
            new Besoin(CharacterStat.UNHAPPINESS, "Unhappiness", "UI_PZ_Pulse_Need_Unhappiness", true, "mood_sad"),
            new Besoin(CharacterStat.PAIN, "Pain", "UI_PZ_Pulse_Need_Pain", true, "mood_pained"),
            new Besoin(CharacterStat.SICKNESS, "Sickness", "UI_PZ_Pulse_Need_Sickness", true, "mood_nauseous"),
            new Besoin(CharacterStat.WETNESS, "Wetness", "UI_PZ_Pulse_Need_Wetness", true, "status_wet"),
            new Besoin(CharacterStat.INTOXICATION, "Drunkenness", "UI_PZ_Pulse_Need_Drunkenness", true, "mood_drunk"));

    private static List<Object> besoins(IsoPlayer p) {
        List<Object> l = new ArrayList<>();
        Stats st = p.getStats();
        if (st == null) return l;
        for (Besoin b : BESOINS) {
            Float v = sur(() -> st.get(b.stat()), null);
            if (v == null) continue;
            double frac;
            if (b.stat() == CharacterStat.SICKNESS) {
                // Comme l'ecran du jeu : l'infection apparente compte dans la maladie.
                frac = sur(() -> p.getBodyDamage().getApparentInfectionLevel(), 0f) / 100.0 + v;
            } else {
                float mx = sur(() -> b.stat().getMaximumValue(), 0f);
                frac = mx > 0 ? v / mx : v;
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("label", b.label());
            m.put("value", pct01(frac));
            m.put("badHigh", b.badHigh());
            m.put("icon", b.icon());
            // Pas dans le mod : la cle stable, pour cocher ce besoin sur la carte.
            m.put("id", b.label().toLowerCase(Locale.ROOT));
            l.add(m);
        }
        return l;
    }

    private record Humeur(MoodleType type, String tkey, String label, String icon, String valence, int min) { }
    private static final List<Humeur> HUMEURS = List.of(
            new Humeur(MoodleType.HUNGRY, "Hungry", "Hungry", "status_hunger", "bad", 1),
            new Humeur(MoodleType.THIRST, "Thirst", "Thirsty", "status_thirst", "bad", 1),
            new Humeur(MoodleType.TIRED, "Tired", "Tired", "mood_sleepy", "bad", 1),
            new Humeur(MoodleType.ENDURANCE, "Endurance", "Exertion", "status_difficultybreathing", "bad", 1),
            new Humeur(MoodleType.BORED, "Bored", "Bored", "mood_bored", "bad", 1),
            new Humeur(MoodleType.UNHAPPY, "Unhappy", "Unhappy", "mood_sad", "bad", 1),
            new Humeur(MoodleType.STRESS, "Stress", "Stressed", "mood_stressed", "bad", 1),
            new Humeur(MoodleType.PANIC, "Panic", "Panic", "mood_panicked", "bad", 1),
            new Humeur(MoodleType.ANGRY, "Angry", "Angry", "mood_angry", "bad", 1),
            new Humeur(MoodleType.PAIN, "Pain", "Pain", "mood_pained", "bad", 1),
            new Humeur(MoodleType.SICK, "Sick", "Sick", "mood_nauseous", "bad", 1),
            new Humeur(MoodleType.HAS_A_COLD, "HasACold", "Cold", "mood_ill", "bad", 1),
            new Humeur(MoodleType.INJURED, "Injured", "Injured", "status_injuredmajor", "bad", 1),
            new Humeur(MoodleType.BLEEDING, "Bleeding", "Bleeding", "status_bleeding", "bad", 1),
            new Humeur(MoodleType.WET, "Wet", "Wet", "status_wet", "bad", 1),
            new Humeur(MoodleType.HEAVY_LOAD, "HeavyLoad", "Heavy load", "status_heavyload", "bad", 1),
            new Humeur(MoodleType.CANT_SPRINT, "CantSprint", "Can't sprint", "status_movementrestricted", "bad", 1),
            new Humeur(MoodleType.UNCOMFORTABLE, "Uncomfortable", "Uncomfortable", "mood_discomfort", "bad", 1),
            new Humeur(MoodleType.NOXIOUS_SMELL, "NoxiousSmell", "Noxious smell", "mood_noxioussmell", "bad", 1),
            new Humeur(MoodleType.DRUNK, "Drunk", "Drunk", "mood_drunk", "bad", 1),
            new Humeur(MoodleType.HYPERTHERMIA, "Hyperthermia", "Hyperthermia", "status_temperaturehot", "bad", 1),
            new Humeur(MoodleType.HYPOTHERMIA, "Hypothermia", "Hypothermia", "status_temperaturelow", "bad", 1),
            new Humeur(MoodleType.WINDCHILL, "Windchill", "Windchill", "status_windchill", "bad", 1),
            new Humeur(MoodleType.FOOD_EATEN, "FoodEaten", "Well fed", "status_hunger", "good", 3));

    private static List<Object> humeurs(IsoPlayer p) {
        List<Object> l = new ArrayList<>();
        Moodles m = p.getMoodles();
        if (m == null) return l;
        for (Humeur h : HUMEURS) {
            if (h.type() == null) continue;
            int lvl = sur(() -> m.getMoodleLevel(h.type()), 0);
            if (lvl < h.min()) continue;
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("label", tr("Moodles_" + h.tkey() + "_lvl" + lvl, h.label()));
            o.put("level", lvl);
            o.put("icon", h.icon());
            o.put("valence", h.valence());
            l.add(o);
        }
        return l;
    }

    // ---- JSON -------------------------------------------------------------

    static void json(StringBuilder sb, Object v) {
        if (v == null) {
            sb.append("null");
        } else if (v instanceof String s) {
            chaine(sb, s);
        } else if (v instanceof Boolean b) {
            sb.append(b ? "true" : "false");
        } else if (v instanceof Double || v instanceof Float) {
            double d = ((Number) v).doubleValue();
            if (!Double.isFinite(d)) sb.append('0');
            else if (d == Math.rint(d) && Math.abs(d) < 1e15) sb.append((long) d);
            else sb.append(d);
        } else if (v instanceof Number n) {
            sb.append(n.longValue());
        } else if (v instanceof Map<?, ?> m) {
            sb.append('{');
            boolean premier = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (e.getValue() == null) continue;     // comme Lua : nil n'est pas ecrit
                if (!premier) sb.append(',');
                premier = false;
                chaine(sb, String.valueOf(e.getKey()));
                sb.append(':');
                json(sb, e.getValue());
            }
            sb.append('}');
        } else if (v instanceof List<?> l) {
            sb.append('[');
            for (int i = 0; i < l.size(); i++) {
                if (i > 0) sb.append(',');
                json(sb, l.get(i));
            }
            sb.append(']');
        } else {
            chaine(sb, String.valueOf(v));
        }
    }

    private static void chaine(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    // < echappe aussi : la charge finit dans un <script>.
                    if (c < 0x20 || c == '<' || c == 0x2028 || c == 0x2029) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        sb.append('"');
    }
}
