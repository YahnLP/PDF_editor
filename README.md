# Éditeur PDF WYSIWYG

Éditeur de PDF qui tourne **entièrement dans le navigateur** (aucun envoi de fichier). Un seul fichier HTML autonome : `index.html`.

## Fonctions

- **Modifier le texte existant** : un clic sur une ligne la reprend avec sa police (Helvetica/Times/Courier, gras, italique), sa taille et sa couleur. Le texte d'origine est réellement retiré du flux de contenu du PDF (pas de simple cache blanc) ; si cela n'est pas possible (texte dans un objet formulaire), un masque de la couleur de fond est utilisé en repli.
- **Texte riche, comme dans un traitement de texte** : barre d'outils (police, taille, gras, italique, souligné, couleur, **listes à puces**, **listes numérotées** sur plusieurs niveaux, retraits, alignement gauche/centre/droite). Les styles s'appliquent à la sélection pendant la saisie, à tout le texte sinon ; ils fonctionnent aussi au milieu d'une ligne existante du PDF. Clic (zone auto) ou glisser (zone à largeur fixe avec retour à la ligne) pour créer ; interligne, fond et bordure dans le panneau.
- **Polices personnalisées** : import `.ttf` / `.otf`, intégrées (sous-ensemble) au PDF exporté.
- **Zones** : rectangle et ellipse (remplissage, opacité, contour).
- **Images** : insertion (PNG, JPEG, autres formats convertis) ; **déplacement, redimensionnement, suppression et remplacement des images du document**, sur place (l'ordre d'empilement est conservé).
- **Champs de formulaire remplissables** (outil *Champ*, `F`) : texte, texte multiligne, case à cocher, liste déroulante. Ce sont de vrais champs AcroForm (nom, valeur par défaut, obligatoire, bordure, taille de police) qui restent remplissables dans Acrobat, les navigateurs, Aperçu… Indisponible sur les pages pivotées.
- Annuler / rétablir, vignettes, zoom, déplacement aux flèches, raccourcis (`V` `T` `R` `E` `F` `I`, `Suppr`, `Ctrl+Z/Y/D/S`).

## Compatibilité du PDF produit

L'export passe par [pdf-lib](https://pdf-lib.js.org/) : les pages d'origine, leurs ressources, formulaires, signets, etc. sont conservés ; seuls les flux de contenu des pages modifiées sont réécrits (et rééquilibrés `q`/`Q`). Les objets ajoutés sont de vrais éléments PDF (texte, rectangles, images). Le résultat est vérifié avec `qpdf --check` et `poppler`.

## Limites connues

- Les PDF **chiffrés / protégés par mot de passe** ne sont pas pris en charge. Une **signature numérique** est invalidée par toute modification.
- Les **polices d'origine ne sont pas réutilisées directement** (elles sont presque toujours des sous-ensembles) : la police est reconnue par son nom et remplacée par l'équivalent standard, ou par une police importée.
- Texte existant : édition **ligne par ligne** (pas de reflux de paragraphe), texte horizontal uniquement ; **désactivée sur les pages pivotées** (l'ajout de texte, zones et images y fonctionne).
- Images : seules celles placées directement dans la page (ou dans un objet formulaire qui en contient) sont déplaçables ; les images en ligne sont prises en charge, pas celles imbriquées plus profondément.
- Caractères hors WinAnsi (grec, symboles…) : importer une police qui les contient (avertissement affiché).

## Développement

```bash
npm install
npm run build        # produit index.html
```

- `src/engine.js` : tokenizer du flux de contenu, détection des images, déplacement en place (`P × T × P⁻¹`), suppression du texte par zone.
- `src/richtext.js` : texte riche (schéma et saisie [ProseMirror](https://prosemirror.net), conversion vers notre modèle de paragraphes).
- `src/app.js` : interface, mise en page du texte (partagée aperçu / export), objets, historique, export.
- `tests/` : PDF de test (`make_pdf.py`, `make_chrome_pdf.py`) et scénarios Playwright (`e2e*.py`), à lancer après `npm run build`.

## Bibliothèques libres utilisées

| Rôle | Bibliothèque | Licence |
|---|---|---|
| Rendu des pages | [pdf.js](https://mozilla.github.io/pdf.js/) | Apache-2.0 |
| Écriture / formulaires | [pdf-lib](https://pdf-lib.js.org/) + [fontkit](https://github.com/Hopding/fontkit) | MIT |
| Saisie de texte riche | [ProseMirror](https://prosemirror.net) | MIT |

Aucun moteur libre ne modifie sur place le texte et les images d'un PDF existant : c'est le rôle de `src/engine.js`, propre à ce projet.
