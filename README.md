# PhotoBoîte

Éditeur d'images qui fonctionne entièrement dans le navigateur : aucun fichier n'est envoyé sur Internet.
Installable comme application (PWA) sur Windows, Android, iPhone et iPad, et utilisable hors connexion.

## Fonctions

**Convertir (par lot)**
- Entrée : JPG, PNG, WebP, GIF, BMP, HEIC/HEIF, AVIF, PDF (TIFF seulement dans Safari).
- Sortie : PNG (par défaut), JPG, WebP, GIF, BMP, PDF.
- PDF vers images : choix de la résolution (96, 150, 300 dpi) et des pages (« 1-3, 5 », « 4- »).
- Images vers PDF : un seul PDF ou un PDF par fichier, page à la taille de l'image ou A4 avec marges.
- Transformations appliquées à tous les fichiers : taille maximale ou pourcentage, rotation, miroir.
- Conservation des métadonnées EXIF de JPG vers JPG.
- Résultats : téléchargement un par un, en ZIP, ou partage (enregistrement dans Photos sur mobile).

**Retoucher (une image)**
- Rotation 90°, redressement fin (-45° à +45°), miroir horizontal et vertical.
- Rognage libre ou aux proportions 1:1, 4:3, 3:2, 16:9, 10×15.
- Redimensionnement en pixels, annulation des dernières opérations.
- Photo d'identité au format français 35 × 45 mm (300 dpi), avec repères menton et haut du crâne, et planche 10 × 15 cm de 6 photos.
- Format Polaroid : image carrée 79 × 79 mm dans un cadre 88 × 107 mm, légende facultative.

**Tags EXIF (par lot, JPG)**
- Titre, auteur, copyright, mots-clés, commentaire, note (étoiles), date de prise de vue (fixer ou décaler), position GPS (définir ou supprimer), suppression de toutes les métadonnées.
- L'image n'est pas recompressée : seules les métadonnées changent.

**Confort d'utilisation**
- Glisser-déposer n'importe où dans la fenêtre, ou coller une image (Ctrl+V).
- Préréglages : « PDF ou images en PNG », « Images en un seul PDF A4 », « Photos pour le web », « Photos pour e-mail ».
- Réglages mémorisés d'une session à l'autre, thème sombre automatique, navigation en bas de l'écran sur mobile.
- Raccourcis : Ctrl+O ouvrir, Ctrl+Z annuler, Ctrl+Y rétablir, Ctrl+S enregistrer (onglet Retoucher). Molette pour zoomer.

## Mise en ligne sur GitHub Pages

1. Créez un dépôt sur GitHub (par exemple `photoboite`), public.
2. Envoyez tout le contenu de ce dossier à la racine du dépôt (bouton « Add file > Upload files », glissez tous les fichiers et dossiers).
3. Dans le dépôt : **Settings > Pages > Build and deployment**, Source « Deploy from a branch », branche `main`, dossier `/ (root)`, puis **Save**.
4. Après une à deux minutes, l'application est en ligne à l'adresse `https://VOTRE-COMPTE.github.io/photoboite/`.

## Installer l'application

- **Windows (Edge ou Chrome)** : ouvrez l'adresse, puis cliquez sur « Installer l'application » en haut de la page (ou sur l'icône d'installation dans la barre d'adresse). Une fois installée, elle apparaît dans le menu Démarrer et dans « Ouvrir avec » pour les images et les PDF.
- **Android (Chrome)** : bouton « Installer l'application », ou menu ⋮ > « Ajouter à l'écran d'accueil ».
- **iPhone / iPad (Safari)** : bouton Partager > « Sur l'écran d'accueil ».

## Mettre à jour

Après avoir modifié des fichiers, changez la valeur `CACHE` en haut de `sw.js` (par exemple `photoboite-v1.0.1`) et `APP_VERSION` dans `js/config.js`. Sinon les appareils qui ont installé l'application garderont l'ancienne version en cache.

## Renommer le logiciel

Le nom apparaît dans `js/config.js` (`APP_NAME`), `manifest.webmanifest` (`name`, `short_name`) et `index.html` (`<title>` et `apple-mobile-web-app-title`).

## Limites connues

- **EXIF** : la modification des tags ne fonctionne que sur les JPG. PNG, WebP et HEIC ne sont pas modifiables ici, et une conversion vers un autre format que JPG perd les métadonnées.
- **Accents dans les tags** : titre, auteur, mots-clés et commentaire sont écrits dans les champs Windows (lus correctement par l'Explorateur) et en UTF-8 dans les champs EXIF standard. Quelques vieux logiciels peuvent afficher « Ã© » à la place de « é ».
- **HEIC** : décodage natif dans Safari ; ailleurs, via une bibliothèque intégrée plus lente (quelques secondes par photo). L'export en HEIC n'est pas possible.
- **WebP** : Safari (iPhone, Mac) ne sait pas créer de WebP ; il en lit, mais l'export WebP y affiche un message d'erreur.
- **GIF animés** : seule la première image est conservée. L'export GIF est limité à 256 couleurs.
- **iPhone / iPad** : les très grandes images (au-delà d'environ 16 millions de pixels, par exemple les photos 48 Mpx) sont réduites automatiquement, car Safari limite la taille des images en mémoire. Le bouton « Installer » n'existe pas sur iOS : il faut passer par Partager > « Sur l'écran d'accueil ». « Ouvrir avec » n'existe pas sur iOS ni Android.
- **PDF protégés** par mot de passe : non pris en charge.
- **Photo d'identité** : pour le permis de conduire et certaines démarches ANTS, un code e-photo délivré par un photographe ou une cabine agréés est obligatoire.

## Bibliothèques utilisées (incluses dans `vendor/`)

pdf.js (Apache 2.0), pdf-lib (MIT), piexifjs (MIT), heic2any (MIT, libheif LGPL), JSZip (MIT), Cropper.js (MIT), gifenc (MIT). Icônes dessinées dans le style Lucide (ISC).
