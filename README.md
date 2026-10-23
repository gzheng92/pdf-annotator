# PDF Annotator for VS Code

[![CI](https://github.com/gzheng92/pdf-annotator/actions/workflows/ci.yml/badge.svg)](https://github.com/gzheng92/pdf-annotator/actions/workflows/ci.yml)

## Install

Download the latest `pdf-annotator-*.vsix` from [Releases](https://github.com/gzheng92/pdf-annotator/releases), then in VS Code open the Extensions view, click **⋯ → Install from VSIX…** and pick the file. Or from a terminal:

```bash
gh release download --repo gzheng92/pdf-annotator --pattern '*.vsix' --clobber
code --install-extension pdf-annotator-*.vsix
```

Opens `.pdf` files in VS Code and lets you mark them up:

- **Highlight** text (pick a color, or draw a free highlight)
- **Comments** on any spot, listed in a comments sidebar
- **Free text** boxes
- **Draw** with the pen
- **Images** and **signatures**

Annotations are saved *into the PDF* as standard PDF annotations, so Acrobat, Preview, browsers and other readers show them too.

## Jump to the LaTeX source (SyncTeX reverse search)

**Ctrl+click** (**Cmd+click** on macOS) anywhere in the PDF to open the `.tex` file at that line, with the clicked word selected. It opens next to the PDF, or in the column where that file is already open. `\input`/`\include`d files work.

This needs the `.synctex.gz` file that LaTeX writes next to the PDF when you compile with `-synctex=1` (LaTeX Workshop and most latexmk setups do this already). No TeX tools are needed by the extension itself.

## Saving

- **Ctrl/Cmd+S** (or the toolbar's save icon) writes your annotations into the file.
- Unsaved annotations show the usual "dirty" dot on the tab and survive switching tabs and restarting VS Code (hot exit).

## When the PDF is overwritten (LaTeX, pandoc, …)

If another program rewrites a PDF you have open, and that PDF has annotations in the editor (saved or not), the extension first backs them up, then shows the new file:

```
<system temp>/vscode-pdf-annotator/<file>-<id>/<date_time>/
    <file>.annotated.pdf   the PDF as it looked in the editor, annotations included
    <file>.previous.pdf    the file as it was on disk before being overwritten
    annotations.json       page, type, position, text, color of each annotation
```

A notification then offers **Re-apply Annotations**, which copies them onto the same pages of the new PDF (unsaved, so you can check before pressing Save). You can also do this later from the editor title bar or the command palette: **PDF Annotator: Re-apply Annotations from Backup…**.

Annotations are placed at the same page and position. If the new version moved the text around, a highlight will stay where it was on the page, not follow the words.

If the PDF had no annotations, nothing is backed up; the viewer just reloads the new file and keeps your page and zoom, like a live preview.

## Settings

| Setting | Default | |
|---|---|---|
| `pdfAnnotator.onOverwrite` | `ask` | `ask`: back up and offer to re-apply. `reapply`: back up and re-apply automatically. `discard`: back up only. |
| `pdfAnnotator.backupFolder` | *(system temp)* | Where backups go. `~` is allowed. |
| `pdfAnnotator.maxBackupsPerFile` | `20` | Older backups for the same PDF are deleted. |

## Commands

- **PDF Annotator: Re-apply Annotations from Backup…**
- **PDF Annotator: Open Backup Folder**
- **PDF Annotator: Export Annotations as JSON…**

## Notes

- If another PDF extension is installed, choose with right-click on a PDF → *Open With…* (or set `workbench.editorAssociations` for `*.pdf` to `pdfAnnotator.editor`).
- Built on Mozilla's [PDF.js](https://github.com/mozilla/pdf.js) viewer (Apache-2.0) and [pdf-lib](https://github.com/Hopding/pdf-lib) (MIT). No PDFCraft (AGPL-3.0) code is included.

## Development

```bash
npm install          # also downloads the PDF.js viewer into media/pdfjs
npm test             # unit tests (annotations, backups, SyncTeX)
npm run test:browser # viewer tests in headless Chromium (needs: npm i --no-save playwright && npx playwright install chromium)
npm run package      # builds pdf-annotator-<version>.vsix
```

Press **F5** in VS Code to try the extension in a development window.

### Releasing

Bump `version` in `package.json`, add a section to `CHANGELOG.md`, then:

```bash
git commit -am "Release vX.Y.Z" && git tag vX.Y.Z && git push --follow-tags
```

GitHub Actions builds the `.vsix` and attaches it to a GitHub release. If the repository has a `VSCE_PAT` secret (VS Code Marketplace) or `OVSX_PAT` secret (Open VSX), it also publishes there.
