# Sculpture library

The models visitors can choose in the web AR. This repository is the "server": you put GLB files in `models/`, and GitHub does the rest. It builds `catalog.json`, renders a thumbnail for each model, and publishes everything at

```
https://<your-github-name>.github.io/<this-repo-name>/catalog.json
```

The AR page reads that address every time it opens. Changes show up for visitors within a few minutes, without re-uploading anything to itch.io.

## One-time setup (about 5 minutes)

1. On github.com, create a **new public repository**, for example `sculptures`.
2. Upload everything from this folder into it (*Add file > Upload files*, then drag the contents in). This includes the hidden `.github` folder. If your file browser hides it, use GitHub Desktop or `git push` instead.
3. In the repository, open *Settings > Pages* and set **Source** to **GitHub Actions**.
4. Open the *Actions* tab. The workflow **Publish model library** runs, either on its own or when you click *Run workflow*. When it shows a green tick, open `https://<your-github-name>.github.io/<repo>/` to see the library page and copy the catalog address.
5. Paste that address into `config.json` of the AR page (`"catalogUrl": "…"`) and upload the AR zip to itch.io once more. From then on, models are managed only here.

## Adding a model

Upload `my-piece.glb` into the `models` folder (*Add file > Upload files*) and commit. That's all.

Optional files next to it, all with the same name:

| File | What it does |
|---|---|
| `my-piece.json` | Title, description, starting size and order. See below. |
| `my-piece.png` / `.jpg` / `.webp` | Your own thumbnail. Without one, a thumbnail is rendered automatically. |

`my-piece.json`:

```json
{
  "title": "My piece",
  "description": "One line shown under the name.",
  "size": 1,
  "order": 2,
  "hidden": false
}
```

- `size`: how wide the sculpture's footprint starts, measured in widths of the visitor's image. `1` means as wide as the image.
- `order`: position in the list. Lower numbers come first.
- `hidden: true`: keeps the file in the repo but takes it off the list.

## Replacing or removing a model

- **Replace**: upload a new file with the same name. Visitors get the new version straight away, because each file's address includes a fingerprint of its contents.
- **Remove**: delete the `.glb` (and its `.json` / image) and commit.

## Tips for phone-friendly models

- Keep each GLB **under ~15 MB**. The build warns you when one is bigger.
- Animations play automatically on a loop. In Blender, export with **Animation** ticked. Modifier or geometry-node motion must be baked first, or it won't export.
- Draco- and Meshopt-compressed GLBs are supported. `npx @gltf-transform/cli optimize in.glb out.glb` often shrinks files a lot.

## Running the build on your own computer (optional)

```
npm install
npx playwright install chromium
npm run build
```
