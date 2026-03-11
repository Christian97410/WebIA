# WebIA — Planning

## Vision

Éditeur visuel local lié au repo + IA pour les changements complexes.
L'éditeur couvre les modifs CSS/HTML simples (celles qui brûlent des tokens pour rien).
L'IA intervient pour le structurel et le complexe.

---

## 1. Features

### 1.1 Gestion de projets
- Ouvrir un dossier local (browse ou chemin)
- Projets récents (persistés en localStorage ou fichier JSON)
- Détection auto de la structure (index.html, dossier public/, etc.)

### 1.2 Canvas
- Rendu live du site dans un iframe
- Zoom (cmd+scroll, input %)
- Pan (space+drag)
- Breakpoints : Desktop (1440), Tablet (768), Mobile (375)
- Background neutre autour du site (comme Figma)

### 1.3 Sélection
- Hover : outline subtil + tag affiché
- Clic : sélection, panel droit affiche les styles
- Double-clic : édition texte inline
- Breadcrumb en bas (body > div.hero > h1)

### 1.4 Édition manuelle — CSS (panel droit)
Ce qui ne nécessite PAS d'IA :
- **Layout** : display (block/flex/grid), flex-direction, justify, align, gap, wrap
- **Spacing** : margin, padding — box model visuel cliquable
- **Size** : width, height, min/max, overflow
- **Typography** : font-family, size, weight, line-height, color, alignment
- **Background** : color picker, image (url ou upload), gradient simple
- **Border** : width, style, color, radius par coin
- **Position** : static/relative/absolute/fixed, top/right/bottom/left, z-index
- **Effects** : opacity, filter basique
- Unités : toggle px/rem/%/vw/vh/auto

### 1.5 Édition manuelle — HTML
Ce qui ne nécessite PAS d'IA :
- Édition de texte inline (double-clic)
- Insertion de divs vides
- Wrapping dans un div (sélection → wrap)
- Dupliquer un élément
- Supprimer un élément
- Changer le tag (h1→h2, div→section, etc.)
- Ajouter/modifier des classes CSS
- Modifier le src d'une image
- Réordonner via le panel Layers (drag & drop dans l'arbre)

### 1.6 Mode IA — Sélection de zone + prompt
Pour tout ce qui est complexe :
- **Sélection** : clic sur un élément existant OU lasso/rectangle pour dessiner une zone sur le canvas
- **Prompt** : champ texte qui apparait — "qu'est-ce que tu veux ici ?"
- **Contexte envoyé à l'IA** : le HTML/CSS actuel de la zone sélectionnée + position dans le DOM + screenshot de la zone
- **L'IA répond** : modifie directement les fichiers source
- **Le canvas refresh** avec le résultat
- **Accept/Reject** : preview du changement, l'utilisateur valide ou annule
- Exemples d'usage :
  - Sélectionne le header → "Ajoute un menu de navigation responsive"
  - Dessine une zone vide → "Crée une section pricing avec 3 colonnes"
  - Sélectionne un formulaire → "Rends-le plus propre avec des labels inline"
  - Sélectionne une section → "Rends ça responsive pour mobile"

### 1.7 Layers (panel gauche)
- Arbre DOM collapsible
- Clic = sélectionne sur le canvas
- Drag & drop pour réordonner
- Icône par type (texte, image, div, etc.)
- Oeil pour toggle visibility

### 1.8 Pages
- Liste des fichiers HTML du projet
- Clic = charge dans le canvas

### 1.9 Git
- Branche courante affichée
- View changes (diff)
- Commit depuis l'UI

### 1.10 Raccourcis
- cmd+z / cmd+shift+z : undo/redo
- cmd+d : dupliquer
- suppr : supprimer
- escape : désélectionner
- cmd+k : command palette
- cmd+i : ouvrir le prompt IA sur l'élément sélectionné

---

## 2. Navigation

Deux vues seulement :

```
PROJECTS ──(ouvrir)──→ EDITOR
                         │
                    ┌────┴────┐
                    │         │
                EDIT MODE   AI MODE
              (panel droit)  (prompt)
```

Pas de page settings, pas de sous-menus. Tout est dans l'éditeur.

---

## 3. Schéma des pages

### 3.1 Projects

```
┌───────────────────────────────────────────────────────┐
│                                                       │
│   WebIA                                    [Browse]   │
│                                                       │
│   ┌───────────────────────────────────────────────┐   │
│   │  /path/to/project                          →  │   │
│   └───────────────────────────────────────────────┘   │
│                                                       │
│   Recent                                              │
│                                                       │
│   my-portfolio                                        │
│   ~/projects/my-portfolio · 2h ago                    │
│                                                       │
│   rembg-site                                          │
│   ~/projects/rembg/public · yesterday                 │
│                                                       │
│   landing-page                                        │
│   ~/clients/landing · 3 days ago                      │
│                                                       │
└───────────────────────────────────────────────────────┘
```

Pas de thumbnails dans le MVP. Juste nom + chemin + date. Dense et clean.

### 3.2 Editor — Layout complet avec chat AI

```
┌──────────────────────────────────────────────────────────────────┐
│ ◀  my-portfolio       Desktop ▾  100%   ↩ ↪    ◉    Changes    │
├─────────┬────────────────────────────────────────┬──────────────┤
│ Pages   │                                        │ Layout       │
│         │          CANVAS                        │ flex  row    │
│ index ● │                                        │ center       │
│ about   │    ┌────────────────────────┐           │              │
│ contact │    │                        │           │ Spacing      │
│         │    │   Le site rendu        │           │ ┌──────────┐ │
│─────────│    │   Clic = sélection     │           │ │  ┌────┐  │ │
│ Layers  │    │   Modif dans le panel  │           │ │  │    │  │ │
│         │    │   Ou prompt dans le    │           │ │  └────┘  │ │
│ ▾ body  │    │   chat en bas          │           │ └──────────┘ │
│  ▾ div  │    │                        │           │              │
│   h1    │    └────────────────────────┘           │ Size         │
│   p     │────────────────────────────────────────│ W 100%       │
│   img   │          CHAT AI                       │ H auto       │
│         │                                        │              │
│         │  You: Change the hero background to    │ Typography   │
│         │  a gradient blue                       │ Inter     16 │
│         │                                        │ 400  1.5  #0 │
│         │  AI: Done. Modified style.css:18       │              │
│         │  [Accept] [Reject]                     │ Background   │
│         │                                        │ #ffffff      │
│         │  ┌──────────────────────────────────┐  │              │
│         │  │ Ask AI...                     ⏎  │  │              │
│         │  └──────────────────────────────────┘  │              │
├─────────┴────────────────────────────────────────┴──────────────┤
│ body > div.container > section.hero > h1          main ●        │
└──────────────────────────────────────────────────────────────────┘
```

Le canvas et le chat sont séparés par un splitter horizontal draggable.
- Le chat a le contexte du projet (fichiers, DOM, élément sélectionné)
- Sélectionner un élément dans le canvas enrichit le contexte du prompt
- L'IA modifie les fichiers, le canvas refresh en live
- Chaque réponse IA propose Accept/Reject
- Le chat panel est collapsible (canvas plein écran quand on fait du visuel pur)
- Historique de conversation persisté par session

### 3.3 AI Prompt (apparait en overlay sur le canvas)

```
         ┌──────────────────────────────────────┐
         │ ┌──────────────────────────────────┐ │
         │ │                                  │ │
         │ │   [ zone sélectionnée par le     │ │
         │ │     user, highlight léger ]       │ │
         │ │                                  │ │
         │ └──────────────────────────────────┘ │
         │                                      │
         │ ┌──────────────────────────────────┐ │
         │ │ Describe what you want here...   │ │
         │ │                                ⏎ │ │
         │ └──────────────────────────────────┘ │
         └──────────────────────────────────────┘
```

Quand l'IA répond :

```
         ┌──────────────────────────────────────┐
         │ ┌──────────────────────────────────┐ │
         │ │                                  │ │
         │ │   [ preview du résultat ]        │ │
         │ │                                  │ │
         │ └──────────────────────────────────┘ │
         │                                      │
         │                    [Reject]  [Accept] │
         └──────────────────────────────────────┘
```

### 3.4 Diff / Commit (modale)

```
┌────────────────────────────────────────────────────┐
│ Changes                                       ✕    │
│                                                    │
│ index.html                            +3  -1       │
│  12  - <h1>Old title</h1>                          │
│  12  + <h1>New title</h1>                          │
│                                                    │
│ style.css                             +5  -0       │
│  18  + .hero { padding: 2rem; }                    │
│                                                    │
│ ┌────────────────────────────────────────────────┐ │
│ │ Update hero section                            │ │
│ └────────────────────────────────────────────────┘ │
│                                          [Commit]  │
└────────────────────────────────────────────────────┘
```

---

## 4. User Flows

### Flow 1 — Premier projet
```
Ouvre l'app → Page Projects (vide)
→ Colle un chemin ou Browse
→ Scan du dossier
→ index.html trouvé → Editor s'ouvre
→ Pas de HTML → message "No HTML files found"
```

### Flow 2 — Modifier un padding
```
Clic sur un élément dans le canvas
→ Panel droit affiche les styles
→ Section Spacing : box model visuel
→ Clic sur le padding-top, tape 32
→ Canvas update en temps réel
→ Fichier CSS modifié (debounced)
```

### Flow 3 — Changer une couleur
```
Élément sélectionné
→ Panel droit > Typography > Color
→ Clic sur le swatch → color picker
→ Choisis la couleur
→ Live update canvas + fichier CSS
```

### Flow 4 — Modifier du texte
```
Double-clic sur un texte
→ Mode édition inline (contenteditable)
→ Tape le nouveau texte
→ Escape ou clic ailleurs pour valider
→ Fichier HTML mis à jour
```

### Flow 5 — Créer un layout flex
```
Sélectionne un div
→ Panel droit > Layout > display → flex
→ flex-direction → row
→ justify-content → space-between
→ Les enfants se repositionnent en live
→ CSS mis à jour
```

### Flow 6 — Insérer un div
```
Clic droit sur un élément
→ "Insert div inside" / "Insert div after"
→ Div vide créé (visible par un placeholder pointillé)
→ Sélectionné automatiquement pour le styliser
```

### Flow 7 — Demander à l'IA (structurel)
```
Sélectionne un élément ou dessine une zone (cmd+i ou bouton)
→ Champ prompt apparait sous la sélection
→ "Ajoute une section témoignages avec 3 cards"
→ Loading state subtil
→ Preview du résultat dans le canvas
→ Accept → fichiers modifiés, intégré
→ Reject → retour à l'état précédent
```

### Flow 8 — Demander à l'IA (modifier l'existant)
```
Sélectionne un élément existant + cmd+i
→ "Rends ce formulaire plus moderne"
→ L'IA voit le HTML/CSS actuel de cet élément
→ Propose une modification
→ Preview → Accept/Reject
```

### Flow 9 — Commit
```
Clic "Changes" dans la top bar
→ Modale avec diff de tous les fichiers modifiés
→ Tape un message de commit
→ Clic Commit
→ Done, modale se ferme
```

### Flow 10 — Preview
```
Clic sur ◉ (preview)
→ Panels se ferment, site plein écran
→ Navigation normale (liens cliquables)
→ Escape → retour éditeur
```

---

## 5. Ce qui est OUT (pas dans le scope)

- Animations / transitions editor
- Composants réutilisables / symboles
- CMS / données dynamiques
- Hosting / deploy
- Multi-utilisateur / collab
- Support frameworks (React, Vue) — MVP = HTML/CSS statique
- Drag & drop de composants prédéfinis (sections, headers, footers)
- Marketplace de templates
